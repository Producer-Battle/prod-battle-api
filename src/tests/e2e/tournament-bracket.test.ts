// Full tournament cycle end-to-end:
//   register entrants -> close registration -> openRound1 pairs the bracket
//   -> each round-1 match plays out (lobby -> submit -> vote -> results)
//   -> advanceRound seeds the final -> final plays out
//   -> advanceRound marks the tournament finished + sets winner_id +
//      awards the tournament_winner achievement.
//
// We drive the schedule helpers directly (openRound1, advanceRound) rather
// than waiting for the tick worker so the test is deterministic. The
// production tick still calls these via tournamentScheduleScan; this test
// pins their contract.

import { sql } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/client.js';
import { advanceRound, openRound1 } from '../../realtime/tick.js';
import { advancePhase } from '../../room/transitions.js';
import { buildTestApp, getMatch, postJson, submitTrack, uniqueHandle } from '../harness.js';
import { TEST_GENRE_SLUG, resetMatchState, seedTestFixtures, seedTestUser } from '../seed.js';

async function genreId(): Promise<string> {
  const rows = (await db().execute<{ id: string }>(
    sql`SELECT id FROM genres WHERE slug = ${TEST_GENRE_SLUG} LIMIT 1`,
  )) as Array<{ id: string }>;
  if (!rows[0]) throw new Error('test genre not seeded');
  return rows[0].id;
}

async function insertOpenTournament(): Promise<string> {
  // status='open', registration window open for 1h, max_entrants=4.
  const id = (
    (await db().execute<{ id: string }>(
      sql`INSERT INTO tournaments
            (name, genre_id, starts_at, registration_closes_at, max_entrants,
             auto_created, created_by, status)
          VALUES
            ('Test bracket', ${await genreId()},
             now() + interval '2 hours', now() + interval '1 hour',
             4, true, NULL, 'open')
          RETURNING id`,
    )) as Array<{ id: string }>
  )[0]?.id;
  if (!id) throw new Error('failed to insert tournament');
  return id;
}

async function backdateRegistration(tournamentId: string): Promise<void> {
  await db().execute(
    sql`UPDATE tournaments
           SET registration_closes_at = now() - interval '1 minute'
         WHERE id = ${tournamentId}`,
  );
}

// Drive a single bracket match through the full submit+vote cycle so the
// winner gets s.final_rank=1 and advanceRound can pick them up.
async function playMatch(
  tournamentId: string,
  matchId: string,
  winnerHandle: string,
  loserHandle: string,
): Promise<void> {
  // Look up the match's room_code so the harness HTTP helpers can target it.
  const [matchRow] = (await db().execute<{ room_code: string }>(
    sql`SELECT room_code FROM matches WHERE id = ${matchId}`,
  )) as Array<{ room_code: string }>;
  if (!matchRow) throw new Error(`match ${matchId} not found`);
  const code = matchRow.room_code;

  // openRound1 inserted the match at status='lobby' with battle_phases set
  // to 'lobby' transitioning 24h ahead. Force it forward to 'submit' so the
  // submit flow accepts uploads.
  await advancePhase(matchId, 'lobby', 'submit', 300);

  // The submit handler also gates on match_status; matches inserted at
  // status='lobby' need a bump for the harness submit to work.
  await db().execute(sql`UPDATE matches SET status = 'submit' WHERE id = ${matchId}`);

  // Use a fresh app per call so any session-bound logic re-resolves.
  const app = buildTestApp();
  const winnerSubId = await submitTrack(app, code, winnerHandle);
  const loserSubId = await submitTrack(app, code, loserHandle);

  // Both submitted -> match auto-advances to vote. Sanity check.
  expect((await getMatch(app, code)).currentPhase).toBe('vote');

  // Each producer scores the other a 5; self-vote drops silently.
  await postJson(app, `/rooms/${code}/vote`, {
    user: winnerHandle,
    votes: [{ submissionId: loserSubId, score: 1 }],
  });
  await postJson(app, `/rooms/${code}/vote`, {
    user: loserHandle,
    votes: [{ submissionId: winnerSubId, score: 5 }],
  });

  // Force the tally so winner gets final_rank=1 and the match status flips
  // to 'results' (advanceRound's exclusion clause keys off this).
  await advancePhase(matchId, 'vote', 'results', 0);

  // Sanity: the producer we wanted to win is rank 1.
  const [winnerRow] = (await db().execute<{ handle: string }>(
    sql`SELECT u.handle
          FROM submissions s
          JOIN users u ON u.id = s.user_id
         WHERE s.match_id = ${matchId} AND s.final_rank = 1`,
  )) as Array<{ handle: string }>;
  expect(winnerRow?.handle).toBe(winnerHandle);

  // Touch tournamentId so the parameter is used (helps a future caller
  // grep for which match belongs to which bracket).
  void tournamentId;
}

describe('tournament bracket cycle', () => {
  beforeAll(async () => {
    await seedTestFixtures();
  });

  beforeEach(async () => {
    await resetMatchState();
    await seedTestFixtures();
    await db().execute(sql`DELETE FROM tournament_entries`);
    await db().execute(sql`DELETE FROM tournaments WHERE auto_created = true`);
  });

  it('4 entrants -> two round-1 matches -> final -> champion', async () => {
    const tournamentId = await insertOpenTournament();

    // Seed 4 producers and register each via the public endpoint.
    const producers = await Promise.all(
      ['p1', 'p2', 'p3', 'p4'].map((tag) =>
        seedTestUser(uniqueHandle(`tn-${tag}`), { plan: 'free', role: 'producer' }),
      ),
    );

    for (const p of producers) {
      const app = buildTestApp({ asUser: p });
      const res = await postJson(app, `/tournaments/${tournamentId}/register`, {});
      expect(res.status).toBe(201);
    }

    // Sanity: 4 entries recorded.
    const entryCount = Number(
      (
        (await db().execute<{ n: string }>(
          sql`SELECT COUNT(*)::text AS n FROM tournament_entries WHERE tournament_id = ${tournamentId}`,
        )) as Array<{ n: string }>
      )[0]?.n ?? '0',
    );
    expect(entryCount).toBe(4);

    // Close the registration window the same way the tick scan would see it,
    // then run openRound1 directly. Two round-1 matches should appear.
    await backdateRegistration(tournamentId);
    await openRound1(tournamentId);

    // Assertions on the seeded bracket.
    const round1Matches = (await db().execute<{
      id: string;
      status: string;
      tournament_round: number;
    }>(
      sql`SELECT id, status, tournament_round
            FROM matches
           WHERE tournament_id = ${tournamentId}
             AND tournament_round = 1
           ORDER BY created_at ASC`,
    )) as Array<{ id: string; status: string; tournament_round: number }>;
    expect(round1Matches).toHaveLength(2);
    for (const m of round1Matches) {
      expect(m.status).toBe('lobby');
      expect(m.tournament_round).toBe(1);
    }

    // The tournament itself flipped to in_progress with effective_size=4.
    const [tRow] = (await db().execute<{ status: string; effective_size: number }>(
      sql`SELECT status, effective_size FROM tournaments WHERE id = ${tournamentId}`,
    )) as Array<{ status: string; effective_size: number }>;
    expect(tRow?.status).toBe('in_progress');
    expect(Number(tRow?.effective_size)).toBe(4);

    // Pick a deterministic winner per round-1 match. The seating shuffle
    // means we don't know which producer is in which match, so look the
    // pairs up by querying match_players.
    type Pair = { matchId: string; players: string[] };
    const pairs: Pair[] = [];
    for (const m of round1Matches) {
      const players = (
        (await db().execute<{ handle: string }>(
          sql`SELECT u.handle
                FROM match_players mp
                JOIN users u ON u.id = mp.user_id
               WHERE mp.match_id = ${m.id}
               ORDER BY mp.joined_at ASC`,
        )) as Array<{ handle: string }>
      ).map((r) => r.handle);
      pairs.push({ matchId: m.id, players });
    }
    expect(pairs.flatMap((p) => p.players).sort()).toEqual(producers.map((p) => p.handle).sort());

    // First listed player wins each round-1 match, second one loses.
    for (const pair of pairs) {
      const [winner, loser] = pair.players;
      if (!winner || !loser) throw new Error('round1 pair missing players');
      await playMatch(tournamentId, pair.matchId, winner, loser);
    }

    // advanceRound should now create the final (round 2) with the two
    // round-1 winners.
    await advanceRound(tournamentId);

    const round2Matches = (await db().execute<{
      id: string;
      tournament_round: number;
    }>(
      sql`SELECT id, tournament_round FROM matches
           WHERE tournament_id = ${tournamentId}
             AND tournament_round = 2`,
    )) as Array<{ id: string; tournament_round: number }>;
    expect(round2Matches).toHaveLength(1);

    const finalMatchId = round2Matches[0]?.id;
    if (!finalMatchId) throw new Error('final match missing');

    const finalists = (
      (await db().execute<{ handle: string }>(
        sql`SELECT u.handle
              FROM match_players mp
              JOIN users u ON u.id = mp.user_id
             WHERE mp.match_id = ${finalMatchId}
             ORDER BY mp.joined_at ASC`,
      )) as Array<{ handle: string }>
    ).map((r) => r.handle);
    expect(finalists).toHaveLength(2);

    // Round-1 winners should be exactly the round-1 first-listed players.
    const expectedFinalists = pairs.map((p) => p.players[0] as string).sort();
    expect([...finalists].sort()).toEqual(expectedFinalists);

    // Final: first listed wins.
    const [champ, runnerUp] = finalists;
    if (!champ || !runnerUp) throw new Error('finalists missing');
    await playMatch(tournamentId, finalMatchId, champ, runnerUp);

    // advanceRound now sees one winner = champion.
    await advanceRound(tournamentId);

    const [finalRow] = (await db().execute<{ status: string; winner_id: string | null }>(
      sql`SELECT status, winner_id FROM tournaments WHERE id = ${tournamentId}`,
    )) as Array<{ status: string; winner_id: string | null }>;
    expect(finalRow?.status).toBe('finished');
    expect(finalRow?.winner_id).toBeTruthy();

    const [winnerHandleRow] = (await db().execute<{ handle: string }>(
      sql`SELECT handle FROM users WHERE id = ${finalRow?.winner_id}`,
    )) as Array<{ handle: string }>;
    expect(winnerHandleRow?.handle).toBe(champ);

    // Achievement awarded.
    const [ach] = (await db().execute<{ achievement_key: string }>(
      sql`SELECT achievement_key FROM achievements
            WHERE user_id = ${finalRow?.winner_id}
              AND achievement_key = 'tournament_winner'
            LIMIT 1`,
    )) as Array<{ achievement_key: string }>;
    expect(ach?.achievement_key).toBe('tournament_winner');
  });

  it('cancels a tournament with fewer than 2 entrants when round 1 opens', async () => {
    const tournamentId = await insertOpenTournament();
    // Only one producer registers.
    const lonely = await seedTestUser(uniqueHandle('tn-lonely'), {
      plan: 'free',
      role: 'producer',
    });
    const app = buildTestApp({ asUser: lonely });
    expect((await postJson(app, `/tournaments/${tournamentId}/register`, {})).status).toBe(201);

    await backdateRegistration(tournamentId);
    await openRound1(tournamentId);

    const [tRow] = (await db().execute<{ status: string }>(
      sql`SELECT status FROM tournaments WHERE id = ${tournamentId}`,
    )) as Array<{ status: string }>;
    expect(tRow?.status).toBe('cancelled');
  });

  it('rejects registration when honor is below the gate', async () => {
    const tournamentId = await insertOpenTournament();
    const lowHonor = await seedTestUser(uniqueHandle('tn-low'), {
      plan: 'free',
      role: 'producer',
    });
    await db().execute(sql`UPDATE users SET honor = 10 WHERE id = ${lowHonor.id}`);

    const app = buildTestApp({ asUser: lowHonor });
    const res = await postJson(app, `/tournaments/${tournamentId}/register`, {});
    expect(res.status).toBe(403);
    expect((res.json as { error: string }).error).toBe('low_honor');
  });
});
