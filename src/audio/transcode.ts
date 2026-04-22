// Dispatch a Scaleway Serverless Job run for the ffmpeg transcoder.
// Input:  S3 key of the raw upload
// Output: normalized Opus + waveform JSON written back to the same bucket.
// The job is defined in `jobs/ffmpeg/` and provisioned by prod-battle-infra.

export async function dispatchTranscode(
  _s3Key: string,
  _matchId: string,
  _userId: string,
): Promise<void> {
  throw new Error('not implemented');
}
