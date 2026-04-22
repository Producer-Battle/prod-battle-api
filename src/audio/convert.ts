// ffmpeg .ogg → .wav converter. Runs the ffmpeg binary from the container
// (the base Docker image ships ffmpeg via `apk add ffmpeg` or it's present
// in the jobs/ffmpeg image). For local dev, the host must have ffmpeg
// installed - document this in README.

import { spawn } from 'node:child_process';

/**
 * Pipe an .ogg buffer through ffmpeg and return the WAV bytes.
 * Normalizes loudness to -16 LUFS so different stems play at similar volume.
 */
export async function oggToWav(ogg: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-af',
        'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-f',
        'wav',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
        return;
      }
      resolve(new Uint8Array(Buffer.concat(chunks)));
    });

    proc.stdin.end(Buffer.from(ogg));
  });
}
