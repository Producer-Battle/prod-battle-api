// Presigned S3 PUT URL generator.
// Scopes the URL to: max 20 MB, content-type allowlist, bucket key
// `matches/{matchId}/{userId}.{ext}`, 5 minute expiry.

export async function createUploadUrl(_matchId: string, _userId: string, _contentType: string): Promise<string> {
  throw new Error('not implemented');
}
