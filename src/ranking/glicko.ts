// Glicko-2 rating per (user, genre, season).
// Called on match completion: for each player, compute expected vs actual rank
// against all other finalists, update rating + rating deviation + volatility.

export type GlickoResult = { rating: number; rd: number; volatility: number };

export function updateGlicko(
  _current: GlickoResult,
  _opponents: ReadonlyArray<{ rating: number; rd: number; outcome: 0 | 0.5 | 1 }>,
): GlickoResult {
  throw new Error('not implemented');
}
