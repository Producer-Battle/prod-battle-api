// Freesound.org APIv2 client.
//
// Register a token at https://freesound.org/apiv2/apply/ and set
// FREESOUND_API_KEY in the env. Filtering to Creative Commons 0 (CC0)
// means we can redistribute without per-sound attribution - matches how
// beat-battle.net ships kits without a credits screen.
//
// Rate limit: 60 req/min by default. This client stays well under that
// because we batch stems per genre at refresh time, not per match.

import { env } from '../env.js';

const FREESOUND_API = 'https://freesound.org/apiv2';

type SearchHit = {
  id: number;
  name: string;
  username: string;
  license: string;
  duration: number;
  previews: {
    'preview-hq-ogg': string;
    'preview-lq-ogg': string;
  };
};

type SearchResponse = {
  count: number;
  results: SearchHit[];
};

export type FreesoundSample = {
  id: number;
  name: string;
  author: string;
  license: string;
  durationSec: number;
  previewUrl: string; // .ogg
};

function token(): string {
  if (!env.FREESOUND_API_KEY) throw new Error('FREESOUND_API_KEY not set');
  return env.FREESOUND_API_KEY;
}

/**
 * Search Freesound and return up to `count` random hits. Filters to short
 * CC0 sounds suitable as one-shot stems.
 */
export async function searchStems(opts: {
  query: string;
  maxDurationSec?: number;
  minDurationSec?: number;
  count?: number;
  page?: number;
}): Promise<FreesoundSample[]> {
  const count = opts.count ?? 10;
  const minD = opts.minDurationSec ?? 0.1;
  const maxD = opts.maxDurationSec ?? 4;
  const pageSize = Math.min(150, Math.max(count * 3, 30));
  const page = opts.page ?? 1;

  const url = new URL('/apiv2/search/text/', FREESOUND_API);
  url.searchParams.set('query', opts.query);
  url.searchParams.set('filter', `duration:[${minD} TO ${maxD}] license:"Creative Commons 0"`);
  url.searchParams.set('fields', 'id,name,username,license,duration,previews');
  url.searchParams.set('page_size', String(pageSize));
  url.searchParams.set('page', String(page));

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Token ${token()}` },
  });
  if (!res.ok) {
    throw new Error(`Freesound search failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as SearchResponse;

  const mapped: FreesoundSample[] = json.results.map((r) => ({
    id: r.id,
    name: r.name,
    author: r.username,
    license: r.license,
    durationSec: r.duration,
    previewUrl: r.previews['preview-hq-ogg'],
  }));

  // Shuffle + take `count` so we don't always return the top-N.
  for (let i = mapped.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [mapped[i], mapped[j]] = [mapped[j] as FreesoundSample, mapped[i] as FreesoundSample];
  }
  return mapped.slice(0, count);
}

/** Download the .ogg preview of a sample into memory. */
export async function downloadPreview(sample: FreesoundSample): Promise<Uint8Array> {
  const res = await fetch(sample.previewUrl);
  if (!res.ok) throw new Error(`preview download failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
