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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rawSearch(opts: {
  query: string;
  minD: number;
  maxD: number;
  pageSize: number;
  page: number;
}): Promise<Response> {
  const url = new URL('/apiv2/search/text/', FREESOUND_API);
  url.searchParams.set('query', opts.query);
  url.searchParams.set(
    'filter',
    `duration:[${opts.minD} TO ${opts.maxD}] license:"Creative Commons 0"`,
  );
  url.searchParams.set('fields', 'id,name,username,license,duration,previews');
  url.searchParams.set('page_size', String(opts.pageSize));
  url.searchParams.set('page', String(opts.page));
  return fetch(url.toString(), { headers: { Authorization: `Token ${token()}` } });
}

/**
 * Search Freesound and return up to `count` random hits. Filters to short
 * CC0 sounds suitable as one-shot stems. Handles two failure modes the
 * upstream API surfaces noisily:
 *   - 404 on page>1 when the result set has fewer rows than page_size.
 *     Falls back to page 1 once.
 *   - 429 rate limit (60/min on the free tier). Sleeps for the Retry-After
 *     window (capped at 60s) and retries once.
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
  const requestedPage = opts.page ?? 1;

  const fetchOnce = (page: number) => rawSearch({ query: opts.query, minD, maxD, pageSize, page });

  let res = await fetchOnce(requestedPage);

  // 429 -> back off once and retry on the same page.
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after')) || 30;
    const waitMs = Math.min(retryAfter, 60) * 1000;
    console.warn(`[freesound] 429 rate-limited, waiting ${waitMs / 1000}s before retry`);
    await sleep(waitMs);
    res = await fetchOnce(requestedPage);
  }

  // 404 typically means the requested page is past the result set.
  // Retry on page 1 if we weren't already there.
  if (res.status === 404 && requestedPage !== 1) {
    res = await fetchOnce(1);
  }

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
