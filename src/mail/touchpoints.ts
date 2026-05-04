// All outbound email touchpoints that are opt-outable.
//
// Each function builds subject + body then calls sendIfOptedIn so the
// user's email_prefs gate is checked in one consistent place. Call sites
// should fire-and-forget: `void notifyXxx(...).catch(log)`.
//
// Account-security and billing mail is NOT here - use sendEmail directly.

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sendIfOptedIn } from './gated.js';

const SITE_URL = 'https://prodbattle.com';
const FROM = 'support@prodbattle.com';

// ── Tournament 24h reminder ──────────────────────────────────────────────────

/**
 * Notify every entrant in a tournament that it starts in ~24 hours.
 * Called by tournamentStartReminderScan in tick.ts only for entries
 * whose (tournament_id, user_id) insert into tournament_reminders_sent
 * succeeded (ON CONFLICT DO NOTHING idempotency).
 */
export async function notifyTournamentStartIn24h(
  tournamentId: string,
  userId: string,
): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string; name: string; starts_at: string }>(
    sql`SELECT u.email, u.handle, t.name, t.starts_at::text
          FROM users u
          JOIN tournaments t ON t.id = ${tournamentId}
         WHERE u.id = ${userId}
         LIMIT 1`,
  );
  const row = (
    rows as Array<{ email: string; handle: string; name: string; starts_at: string }>
  )[0];
  if (!row) return;

  const startsAt = new Date(row.starts_at);
  const dateStr = startsAt.toUTCString();
  const tournamentUrl = `${SITE_URL}/tournaments/${tournamentId}`;

  await sendIfOptedIn(userId, 'tournament_activity', {
    from: FROM,
    to: row.email,
    subject: `Reminder: "${row.name}" starts in 24 hours`,
    text: [
      `Hi ${row.handle},`,
      '',
      `"${row.name}" kicks off in approximately 24 hours (${dateStr}).`,
      '',
      'Be ready to submit your track once the battle begins.',
      `Tournament page: ${tournamentUrl}`,
      '',
      '- The Producer Battle team',
    ].join('\n'),
    html: [
      `<p>Hi ${row.handle},</p>`,
      `<p><strong>"${row.name}"</strong> kicks off in approximately 24 hours (${dateStr}).</p>`,
      '<p>Be ready to submit your track once the battle begins.</p>',
      `<p><a href="${tournamentUrl}">View tournament</a></p>`,
      '<p>- The Producer Battle team</p>',
    ].join(''),
  });
}

// ── Showcase open ─────────────────────────────────────────────────────────────

/**
 * Notify every entrant that the showcase phase has opened - they can now
 * upload their showcase track for community scoring.
 */
export async function notifyShowcaseOpen(tournamentId: string): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string; user_id: string; name: string }>(
    sql`SELECT u.email, u.handle, u.id AS user_id, t.name
          FROM tournament_entries te
          JOIN users u ON u.id = te.user_id
          JOIN tournaments t ON t.id = ${tournamentId}
         WHERE te.tournament_id = ${tournamentId}`,
  );

  const arr = rows as Array<{ email: string; handle: string; user_id: string; name: string }>;
  if (arr.length === 0) return;

  const tournamentName = arr[0]?.name ?? 'Tournament';
  const showcaseUrl = `${SITE_URL}/tournaments/${tournamentId}`;

  for (const row of arr) {
    await sendIfOptedIn(row.user_id, 'tournament_activity', {
      from: FROM,
      to: row.email,
      subject: `Showcase is open for "${tournamentName}"`,
      text: [
        `Hi ${row.handle},`,
        '',
        `The showcase phase for "${tournamentName}" is now open.`,
        'Upload your showcase track so the community can score it before the bracket begins.',
        '',
        `Showcase page: ${showcaseUrl}`,
        '',
        '- The Producer Battle team',
      ].join('\n'),
      html: [
        `<p>Hi ${row.handle},</p>`,
        `<p>The showcase phase for <strong>"${tournamentName}"</strong> is now open.</p>`,
        '<p>Upload your showcase track so the community can score it before the bracket begins.</p>',
        `<p><a href="${showcaseUrl}">Go to showcase</a></p>`,
        '<p>- The Producer Battle team</p>',
      ].join(''),
    }).catch((err: Error) =>
      console.error(`[mail] notifyShowcaseOpen failed for ${row.user_id}: ${err.message}`),
    );
  }
}

// ── Champion ──────────────────────────────────────────────────────────────────

/**
 * Notify the tournament champion.
 */
export async function notifyChampion(tournamentId: string, winnerId: string): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string; name: string }>(
    sql`SELECT u.email, u.handle, t.name
          FROM users u
          JOIN tournaments t ON t.id = ${tournamentId}
         WHERE u.id = ${winnerId}
         LIMIT 1`,
  );
  const row = (rows as Array<{ email: string; handle: string; name: string }>)[0];
  if (!row) return;

  const tournamentUrl = `${SITE_URL}/tournaments/${tournamentId}`;

  await sendIfOptedIn(winnerId, 'tournament_activity', {
    from: FROM,
    to: row.email,
    subject: `You won "${row.name}"! Champion!`,
    text: [
      `Hi ${row.handle},`,
      '',
      `Congratulations - you are the champion of "${row.name}"!`,
      'Your tournament_winner achievement has been awarded.',
      '',
      `View tournament: ${tournamentUrl}`,
      '',
      '- The Producer Battle team',
    ].join('\n'),
    html: [
      `<p>Hi ${row.handle},</p>`,
      `<p>Congratulations - you are the <strong>champion</strong> of <strong>"${row.name}"</strong>!</p>`,
      '<p>Your <code>tournament_winner</code> achievement has been awarded.</p>',
      `<p><a href="${tournamentUrl}">View tournament</a></p>`,
      '<p>- The Producer Battle team</p>',
    ].join(''),
  });
}

// ── Runner-up ─────────────────────────────────────────────────────────────────

/**
 * Notify the runner-up (loser of the final match).
 */
export async function notifyRunnerUp(tournamentId: string, runnerUpUserId: string): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string; name: string }>(
    sql`SELECT u.email, u.handle, t.name
          FROM users u
          JOIN tournaments t ON t.id = ${tournamentId}
         WHERE u.id = ${runnerUpUserId}
         LIMIT 1`,
  );
  const row = (rows as Array<{ email: string; handle: string; name: string }>)[0];
  if (!row) return;

  const tournamentUrl = `${SITE_URL}/tournaments/${tournamentId}`;

  await sendIfOptedIn(runnerUpUserId, 'tournament_activity', {
    from: FROM,
    to: row.email,
    subject: `You reached the final of "${row.name}"`,
    text: [
      `Hi ${row.handle},`,
      '',
      `You made it to the final of "${row.name}" - an amazing run!`,
      'Runner-up is an incredible achievement. The community noticed.',
      '',
      `View tournament: ${tournamentUrl}`,
      '',
      '- The Producer Battle team',
    ].join('\n'),
    html: [
      `<p>Hi ${row.handle},</p>`,
      `<p>You made it to the <strong>final</strong> of <strong>"${row.name}"</strong> - an amazing run!</p>`,
      '<p>Runner-up is an incredible achievement. The community noticed.</p>',
      `<p><a href="${tournamentUrl}">View tournament</a></p>`,
      '<p>- The Producer Battle team</p>',
    ].join(''),
  });
}

// ── Ranked LP change ──────────────────────────────────────────────────────────

/**
 * Notify a ranked participant of their LP change after a match.
 */
export async function notifyRankedLpChange(
  matchId: string,
  userId: string,
  lpDelta: number,
  newLp: number,
  newTier: string,
): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string; room_code: string | null }>(
    sql`SELECT u.email, u.handle, m.room_code
          FROM users u
          JOIN matches m ON m.id = ${matchId}
         WHERE u.id = ${userId}
         LIMIT 1`,
  );
  const row = (rows as Array<{ email: string; handle: string; room_code: string | null }>)[0];
  if (!row) return;

  const sign = lpDelta >= 0 ? '+' : '';
  const matchUrl = row.room_code ? `${SITE_URL}/room/${row.room_code}` : `${SITE_URL}/play`;

  await sendIfOptedIn(userId, 'match_results', {
    from: FROM,
    to: row.email,
    subject: `Ranked result: ${sign}${lpDelta} LP (now ${newLp} LP - ${newTier})`,
    text: [
      `Hi ${row.handle},`,
      '',
      'Your ranked match just ended.',
      `LP change: ${sign}${lpDelta}`,
      `Current LP: ${newLp} (${newTier})`,
      '',
      `View match: ${matchUrl}`,
      '',
      '- The Producer Battle team',
    ].join('\n'),
    html: [
      `<p>Hi ${row.handle},</p>`,
      '<p>Your ranked match just ended.</p>',
      `<p>LP change: <strong>${sign}${lpDelta}</strong></p>`,
      `<p>Current LP: <strong>${newLp}</strong> (${newTier})</p>`,
      `<p><a href="${matchUrl}">View match</a></p>`,
      '<p>- The Producer Battle team</p>',
    ].join(''),
  });
}

// ── Honor warning ─────────────────────────────────────────────────────────────

/**
 * Notify a user that their honor has dropped below 50 (ranked-lock threshold).
 * Should only be called when oldHonor >= 50 && newHonor < 50.
 */
export async function notifyHonorBelow50(
  userId: string,
  oldHonor: number,
  newHonor: number,
): Promise<void> {
  const d = db();

  const rows = await d.execute<{ email: string; handle: string }>(
    sql`SELECT email, handle FROM users WHERE id = ${userId} LIMIT 1`,
  );
  const row = (rows as Array<{ email: string; handle: string }>)[0];
  if (!row) return;

  const settingsUrl = `${SITE_URL}/settings`;

  await sendIfOptedIn(userId, 'honor_alerts', {
    from: FROM,
    to: row.email,
    subject: 'Your honor dropped below 50 - ranked access locked',
    text: [
      `Hi ${row.handle},`,
      '',
      `Your honor dropped from ${oldHonor} to ${newHonor}.`,
      'Honor below 50 locks access to ranked, tournament, and private hosting.',
      '',
      'How to recover:',
      '  - Complete matches without abandoning',
      '  - Vote on every track in the vote phase',
      '  - Every clean match earns +1 honor (up to +6 with a 10-match streak)',
      '',
      `Manage email preferences: ${settingsUrl}`,
      '',
      '- The Producer Battle team',
    ].join('\n'),
    html: [
      `<p>Hi ${row.handle},</p>`,
      `<p>Your honor dropped from <strong>${oldHonor}</strong> to <strong>${newHonor}</strong>.</p>`,
      '<p>Honor below 50 locks access to <strong>ranked</strong>, <strong>tournament</strong>, and <strong>private hosting</strong>.</p>',
      '<p><strong>How to recover:</strong></p>',
      '<ul>',
      '<li>Complete matches without abandoning</li>',
      '<li>Vote on every track in the vote phase</li>',
      '<li>Every clean match earns +1 honor (up to +6 with a 10-match streak)</li>',
      '</ul>',
      `<p><a href="${settingsUrl}">Manage email preferences</a></p>`,
      '<p>- The Producer Battle team</p>',
    ].join(''),
  });
}
