// Preference-gated email sender.
//
// Separated from send.ts so that mocking send.ts in tests (to capture
// sendEmail calls) works correctly via static imports: when a test
// vi.mocks send.ts, this module's static import of sendEmail is replaced
// by the mock, so sendIfOptedIn transparently calls the spy.
//
// Callers should fire-and-forget: `void sendIfOptedIn(...).catch(log)`.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { type EmailPrefKey, type SendEmailInput, sendEmail } from './send.js';

export type { EmailPrefKey, SendEmailInput };

/**
 * Send an email only if the user has not opted out of the given category.
 *
 * Accepts either a userId (uuid string) or an email address. If the user
 * row is not found the mail is skipped (fire-and-forget safety).
 *
 * Preference lookup is shape-defensive: a missing key defaults to true so a
 * schema gap never silently mutes mail.
 */
export async function sendIfOptedIn(
  userIdOrEmail: string,
  prefKey: EmailPrefKey,
  input: SendEmailInput,
): Promise<void> {
  const d = db();

  // Determine whether the argument looks like a UUID (userId) or an email.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    userIdOrEmail,
  );

  const [row] = isUuid
    ? await d
        .select({ id: users.id, emailPrefs: users.emailPrefs })
        .from(users)
        .where(eq(users.id, userIdOrEmail))
        .limit(1)
    : await d
        .select({ id: users.id, emailPrefs: users.emailPrefs })
        .from(users)
        .where(eq(users.email, userIdOrEmail))
        .limit(1);

  if (!row) {
    console.log(
      `[mail] skipped (user not found) { prefKey: ${prefKey}, lookup: ${userIdOrEmail} }`,
    );
    return;
  }

  // Shape-defensive: if the prefs blob is missing the key, default to true.
  const prefs = row.emailPrefs ?? {};
  const optedIn: boolean = (prefs as Record<string, boolean>)[prefKey] ?? true;

  if (!optedIn) {
    console.log(`[mail] skipped (opted out) { prefKey: ${prefKey}, userId: ${row.id} }`);
    return;
  }

  await sendEmail(input);
}
