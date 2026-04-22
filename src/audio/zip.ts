// ZIP builder for sample packs. Streams files from Object Storage into
// an in-memory archive, uploads the archive back to Object Storage, and
// returns a signed download URL.

import { type Readable, Writable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import archiver from 'archiver';
import type { SamplePackItem } from '../db/schema.js';
import { bucket, putObject, s3, signedDownloadUrl } from './s3.js';

function keyFromUrl(url: string): string | null {
  // Strip "<endpoint>/<bucket>/" prefix to get the key.
  const b = bucket();
  const idx = url.indexOf(`/${b}/`);
  if (idx === -1) return null;
  return url.slice(idx + b.length + 2);
}

export async function buildPackZip(
  matchId: string,
  samples: ReadonlyArray<SamplePackItem>,
): Promise<{ key: string; url: string }> {
  const client = s3();
  const b = bucket();

  // Fetch every stem body up-front so archiver can stream synchronously.
  type Entry = { filename: string; body: Buffer };
  const entries: Entry[] = [];
  for (const sample of samples) {
    const key = keyFromUrl(sample.url);
    if (!key) continue;
    const obj = await client.send(new GetObjectCommand({ Bucket: b, Key: key }));
    if (!obj.Body) continue;
    const body = await streamToBuffer(obj.Body as Readable);
    entries.push({ filename: `${sample.stemType}-${sample.name}.wav`, body });
  }

  const chunks: Buffer[] = [];
  const collector = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.pipe(collector);
  for (const e of entries) archive.append(e.body, { name: e.filename });

  await new Promise<void>((resolve, reject) => {
    collector.on('finish', () => resolve());
    archive.on('error', reject);
    archive.finalize().catch(reject);
  });

  const zipBytes = Buffer.concat(chunks);
  const zipKey = `packs/${matchId}.zip`;
  await putObject(zipKey, zipBytes, 'application/zip');
  const url = await signedDownloadUrl(zipKey, 24 * 3600);
  return { key: zipKey, url };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
