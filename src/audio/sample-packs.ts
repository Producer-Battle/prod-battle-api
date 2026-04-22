// Thin helper for resolving sample pack stem URLs.
//
// Today MinIO is public-read, so we pass the URL through unchanged.
// TODO: once we switch to private MinIO or Scaleway Object Storage buckets,
//   replace `resolveUrl` with a real presigned-URL generator using the
//   S3_ENDPOINT + S3_ACCESS_KEY + S3_SECRET_KEY env vars and an expiry of ~1 hour.
//   Something like:
//     import { S3Client, GetObjectCommand, getSignedUrl } from '@aws-sdk/...'
//     const client = new S3Client({ endpoint: env.S3_ENDPOINT, ... })
//     return getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 })

import type { SamplePackItem } from '../db/schema.js';

/**
 * Resolve a stem URL for delivery to the client.
 *
 * For public buckets this is a pass-through. When private buckets are enabled,
 * swap this for a presigned-URL generator keyed to S3_ENDPOINT / S3_ACCESS_KEY.
 */
export function resolveUrl(url: string): string {
  // TODO: generate presigned URL for private bucket access.
  return url;
}

/**
 * Resolve all URLs in a samples array. Returns a new array with resolved URLs.
 */
export function resolveSampleUrls(samples: SamplePackItem[]): SamplePackItem[] {
  return samples.map((s) => ({ ...s, url: resolveUrl(s.url) }));
}
