// S3-compatible storage helper (MinIO in dev, Scaleway Object Storage in prod).
// Uses the AWS SDK v3 pointed at whatever S3_ENDPOINT is set in env.

import {
  GetObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.js';

let _client: S3Client | null = null;

export function s3(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    region: env.S3_REGION ?? 'fr-par',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials:
      env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
        : undefined,
  });
  return _client;
}

export function bucket(): string {
  if (!env.S3_BUCKET) throw new Error('S3_BUCKET not set');
  return env.S3_BUCKET;
}

export async function putObject(
  key: string,
  body: PutObjectCommandInput['Body'],
  contentType: string,
): Promise<string> {
  const b = bucket();
  await s3().send(
    new PutObjectCommand({ Bucket: b, Key: key, Body: body, ContentType: contentType }),
  );
  return publicUrl(key);
}

export function publicUrl(key: string): string {
  const endpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT ?? '';
  const b = bucket();
  return `${endpoint}/${b}/${key}`;
}

export async function signedDownloadUrl(key: string, ttlSec = 86_400): Promise<string> {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key }), {
    expiresIn: ttlSec,
  });
}

/** Convert a public URL back to its bucket key. Returns null if the URL
 *  doesn't belong to our bucket. */
export function keyFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const b = bucket();
  const idx = url.indexOf(`/${b}/`);
  if (idx === -1) return null;
  return url.slice(idx + b.length + 2);
}

/** Re-sign a stored unsigned URL with a short-lived GET signature. */
export async function signUrl(url: string, ttlSec = 86_400): Promise<string> {
  const key = keyFromUrl(url);
  if (!key) return url; // not ours - pass through
  return signedDownloadUrl(key, ttlSec);
}
