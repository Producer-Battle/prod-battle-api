// Generates a few short "beat-like" WAVs so uploaded submissions render a
// lively waveform (amplitude pulses) instead of the flat line a silent WAV
// gives. 16-bit PCM mono. Run with plain node:
//   node scripts/browser-e2e/gen-audio.js
// Writes to ../../marketing/audio/beat{1..4}.wav

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../../../marketing/audio');
fs.mkdirSync(OUT, { recursive: true });

const SR = 22050;

function writeWav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((v * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

// A macro envelope over the whole clip so each variant's waveform has a
// distinct silhouette (steady block, a build, a drop, or sparse stabs).
function macro(shape, frac) {
  switch (shape) {
    case 'build':
      return 0.25 + 0.75 * frac;
    case 'drop':
      return frac < 0.45 ? 0.3 : 1; // quiet intro then full
    case 'sparse':
      return 0.4 + 0.6 * Math.abs(Math.sin(frac * Math.PI * 3)); // pulsing gaps
    default:
      return 1; // steady
  }
}

// One variant: kicks on the beat, hats on the offbeat, a bass tone, all
// shaped by per-hit decay envelopes so the waveform has clear pulses.
function makeBeat({ seconds, bpm, bassHz, seed, shape }) {
  const n = Math.floor(seconds * SR);
  const out = new Float32Array(n);
  const beat = (60 / bpm) * SR; // samples per beat
  let rng = seed;
  const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const m = macro(shape, i / n);
    const posInBeat = i % beat;
    const kickEnv = Math.exp(-posInBeat / (beat * 0.12));
    const kick = Math.sin(2 * Math.PI * 55 * t) * kickEnv * 0.8;
    const offset = (i + beat / 2) % beat;
    const hatEnv = Math.exp(-offset / (beat * 0.04));
    const hat = rand() * hatEnv * 0.25;
    const bass = Math.sin(2 * Math.PI * bassHz * t) * 0.18;
    out[i] = (kick + hat + bass) * m;
  }
  return out;
}

const variants = [
  { seconds: 8, bpm: 140, bassHz: 82, seed: 7, shape: 'steady' },
  { seconds: 9, bpm: 128, bassHz: 65, seed: 19, shape: 'build' },
  { seconds: 8, bpm: 150, bassHz: 98, seed: 33, shape: 'drop' },
  { seconds: 10, bpm: 100, bassHz: 49, seed: 51, shape: 'sparse' },
  { seconds: 7, bpm: 160, bassHz: 73, seed: 71, shape: 'build' },
  { seconds: 9, bpm: 92, bassHz: 58, seed: 91, shape: 'drop' },
  { seconds: 8, bpm: 135, bassHz: 110, seed: 113, shape: 'sparse' },
  { seconds: 10, bpm: 174, bassHz: 87, seed: 137, shape: 'steady' },
];

variants.forEach((v, i) => {
  const file = path.join(OUT, `beat${i + 1}.wav`);
  fs.writeFileSync(file, writeWav(makeBeat(v)));
  console.log('wrote', file);
});

// A long beat for the Daily Challenge, which requires tracks >= 90 seconds.
const longFile = path.join(OUT, 'beat-long.wav');
fs.writeFileSync(longFile, writeWav(makeBeat({ seconds: 96, bpm: 140, bassHz: 80, seed: 5, shape: 'build' })));
console.log('wrote', longFile);
