import { describe, expect, it } from 'vitest';
import { updateRating, updateRdForInactivity } from './glicko2.js';

// Canonical example from Glickman (2012), page 3.
// Player: r=1500, RD=200, sigma=0.06
// Opponents: (1400, 30, win), (1550, 100, loss), (1700, 300, loss)
// Expected output: r~=1464.05, RD~=151.52, sigma~=0.05999
describe('Glicko-2 canonical Glickman example', () => {
  const player = { rating: 1500, rd: 200, volatility: 0.06 };
  const opponents = [
    { rating: 1400, rd: 30, score: 1 },
    { rating: 1550, rd: 100, score: 0 },
    { rating: 1700, rd: 300, score: 0 },
  ];

  it('produces the expected new rating', () => {
    const result = updateRating(player, opponents);
    expect(result.rating).toBeCloseTo(1464.05, 1);
  });

  it('produces the expected new RD', () => {
    const result = updateRating(player, opponents);
    expect(result.rd).toBeCloseTo(151.52, 1);
  });

  it('produces the expected new volatility', () => {
    const result = updateRating(player, opponents);
    expect(result.volatility).toBeCloseTo(0.05999, 4);
  });
});

describe('updateRating edge cases', () => {
  it('no opponents - rating and volatility unchanged, RD widens', () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const result = updateRating(player, []);
    expect(result.rating).toBe(1500);
    expect(result.volatility).toBe(0.06);
    expect(result.rd).toBeGreaterThan(200);
    // RD' = sqrt(200^2 + (0.06 * 173.7178)^2) -- just check it widened sensibly
    expect(result.rd).toBeLessThan(300);
  });

  it('all wins - rating rises, RD shrinks', () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponents = [
      { rating: 1500, rd: 200, score: 1 },
      { rating: 1500, rd: 200, score: 1 },
      { rating: 1500, rd: 200, score: 1 },
    ];
    const result = updateRating(player, opponents);
    expect(result.rating).toBeGreaterThan(1500);
    expect(result.rd).toBeLessThan(200);
  });

  it('all losses - rating falls, RD shrinks', () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponents = [
      { rating: 1500, rd: 200, score: 0 },
      { rating: 1500, rd: 200, score: 0 },
      { rating: 1500, rd: 200, score: 0 },
    ];
    const result = updateRating(player, opponents);
    expect(result.rating).toBeLessThan(1500);
    expect(result.rd).toBeLessThan(200);
  });

  it('RD at floor (e.g. 30) does not break', () => {
    const player = { rating: 1800, rd: 30, volatility: 0.06 };
    const opponents = [{ rating: 1700, rd: 30, score: 1 }];
    const result = updateRating(player, opponents);
    expect(result.rating).toBeGreaterThan(1800);
    expect(result.rd).toBeGreaterThan(0);
    expect(Number.isFinite(result.rating)).toBe(true);
    expect(Number.isFinite(result.rd)).toBe(true);
  });

  it('all draws at equal rating - rating stays the same', () => {
    const player = { rating: 1500, rd: 200, volatility: 0.06 };
    const opponents = [
      { rating: 1500, rd: 200, score: 0.5 },
      { rating: 1500, rd: 200, score: 0.5 },
    ];
    const result = updateRating(player, opponents);
    expect(result.rating).toBeCloseTo(1500, 1);
  });
});

describe('updateRdForInactivity', () => {
  it('one period widens RD identically to updateRating with no opponents', () => {
    const player = { rating: 1600, rd: 150, volatility: 0.06 };
    const fromInactivity = updateRdForInactivity(player, 1);
    const fromNoOpponents = updateRating(player, []);
    expect(fromInactivity.rd).toBeCloseTo(fromNoOpponents.rd, 8);
    expect(fromInactivity.rating).toBe(fromNoOpponents.rating);
    expect(fromInactivity.volatility).toBe(fromNoOpponents.volatility);
  });

  it('multiple periods widen RD more than one period', () => {
    const player = { rating: 1500, rd: 100, volatility: 0.06 };
    const one = updateRdForInactivity(player, 1);
    const five = updateRdForInactivity(player, 5);
    expect(five.rd).toBeGreaterThan(one.rd);
  });
});
