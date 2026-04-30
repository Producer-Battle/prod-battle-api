// Glicko-2 rating algorithm.
// Reference: Mark Glickman, "Example of the Glicko-2 system" (2012)
//   http://www.glicko.net/glicko/glicko2.pdf
//
// All internal computation is on the Glicko-2 scale (mu/phi).
// Public API uses the player-facing scale (rating ~1500-centred, RD in same units).

export interface GlickoPlayer {
  rating: number;
  rd: number;
  volatility: number;
}

export interface GlickoOpponent {
  rating: number;
  rd: number;
  /** 1 = win, 0.5 = draw, 0 = loss (from the perspective of the player being updated) */
  score: number;
}

// Glickman's recommended system constant tau. Controls how quickly volatility
// changes over time. 0.3-1.2 is the suggested range; 0.5 is the worked-example value.
const TAU = 0.5;

const SCALE = 173.7178;

// Convergence tolerance for the Illinois algorithm (step 5.4 in the paper).
const EPSILON = 1e-6;

function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

function E(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

export function updateRating(player: GlickoPlayer, opponents: GlickoOpponent[]): GlickoPlayer {
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.volatility;

  if (opponents.length === 0) {
    // No games played this rating period: inflate RD only.
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return {
      rating: player.rating,
      rd: phiStar * SCALE,
      volatility: sigma,
    };
  }

  const opp = opponents.map((o) => ({
    mu: (o.rating - 1500) / SCALE,
    phi: o.rd / SCALE,
    score: o.score,
  }));

  // Step 3: compute v (estimated variance of the player's rating).
  let vInv = 0;
  for (const o of opp) {
    const gPhi = g(o.phi);
    const eMu = E(mu, o.mu, o.phi);
    vInv += gPhi * gPhi * eMu * (1 - eMu);
  }
  const v = 1 / vInv;

  // Step 4: compute delta (estimated improvement).
  let deltaMul = 0;
  for (const o of opp) {
    const gPhi = g(o.phi);
    const eMu = E(mu, o.mu, o.phi);
    deltaMul += gPhi * (o.score - eMu);
  }
  const delta = v * deltaMul;

  // Step 5: update volatility via the Illinois algorithm.
  // f(x) per Glickman eq. (9).
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const delta2 = delta * delta;

  function f(x: number): number {
    const ex = Math.exp(x);
    const d2 = phi2 + v + ex;
    return (ex * (delta2 - d2)) / (2 * d2 * d2) - (x - a) / (TAU * TAU);
  }

  // Bracket initialisation per Glickman §5.4.
  let A = a;
  let B: number;
  if (delta2 > phi2 + v) {
    B = Math.log(delta2 - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);

  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }

  const sigmaPrime = Math.exp(A / 2);

  // Step 6: update the rating deviation.
  const phiStar = Math.sqrt(phi * phi + sigmaPrime * sigmaPrime);
  const phiPrime = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);

  // Step 7: update the rating.
  let muSum = 0;
  for (const o of opp) {
    muSum += g(o.phi) * (o.score - E(mu, o.mu, o.phi));
  }
  const muPrime = mu + phiPrime * phiPrime * muSum;

  return {
    rating: muPrime * SCALE + 1500,
    rd: phiPrime * SCALE,
    volatility: sigmaPrime,
  };
}

// Widen a player's RD after N inactive rating periods without updating rating
// or volatility. Equivalent to calling updateRating with no opponents N times.
export function updateRdForInactivity(player: GlickoPlayer, periods: number): GlickoPlayer {
  const phi = player.rd / SCALE;
  const sigma = player.volatility;
  let phiCur = phi;
  for (let i = 0; i < periods; i++) {
    phiCur = Math.sqrt(phiCur * phiCur + sigma * sigma);
  }
  return {
    rating: player.rating,
    rd: phiCur * SCALE,
    volatility: sigma,
  };
}
