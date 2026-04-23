#!/usr/bin/env node
// Scaleway Serverless Job entrypoint.
// Env:
//   S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY
//   INPUT_KEY    - object key of the raw upload
//   OUTPUT_PREFIX - where normalized audio + waveform JSON are written
// TODO:
//   1. Pull INPUT_KEY to /tmp
//   2. ffmpeg -i in.wav -c:a libopus -b:a 128k out.opus
//   3. ffmpeg … → peaks.json (256 buckets)
//   4. Upload both to OUTPUT_PREFIX
//   5. POST back to API /internal/transcode-done with signed key
console.error('ffmpeg job stub - not implemented');
process.exit(1);
