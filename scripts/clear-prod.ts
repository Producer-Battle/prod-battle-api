// clear-prod.ts
//
// Wipe all matches + producer users from a database while leaving
// admin and A&R users intact.
//
// Usage:
//   pnpm clear-prod                   # dry-run (default): prints counts, exits 0
//   pnpm clear-prod --dry-run         # same as above, explicit
//   pnpm clear-prod --confirm         # requires CONFIRM_CLEAR=yes; runs destructive SQL
//   pnpm clear-prod --confirm --wipe-s3  # also deletes S3 objects under affected prefixes
//
// Safety rails:
//   - DATABASE_URL must contain "test" OR CONFIRM_CLEAR=yes must be set.
//   - --confirm requires CONFIRM_CLEAR=yes in env.
//   - --wipe-s3 is silently ignored without --confirm.

import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from '@aws-sdk/client-s3';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { env } from '../src/env.js';

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = !args.includes('--confirm');
const wipeS3 = args.includes('--wipe-s3');
const confirmFlag = args.includes('--confirm');

// ---------------------------------------------------------------------------
// Safety checks (run before any DB connection)
// ---------------------------------------------------------------------------

const dbUrl = env.DATABASE_URL ?? '';
const confirmEnv = process.env['CONFIRM_CLEAR'];

if (confirmFlag && confirmEnv !== 'yes') {
  console.error('Refusing: set CONFIRM_CLEAR=yes to proceed');
  process.exit(1);
}

if (!dbUrl.includes('test') && confirmEnv !== 'yes') {
  console.error(
    'Refusing: DATABASE_URL does not look like a test DB; ' +
      'set CONFIRM_CLEAR=yes if you REALLY want this on prod',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Count queries
// ---------------------------------------------------------------------------

interface CountRow extends Record<string, unknown> {
  count: string;
}

async function countAll(): Promise<void> {
  const d = db();

  const queries: Array<{ label: string; q: Promise<CountRow[]> }> = [
    { label: 'matches', q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM matches`) },
    {
      label: 'battle_phases',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM battle_phases`),
    },
    {
      label: 'match_teams',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM match_teams`),
    },
    {
      label: 'match_players',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM match_players`),
    },
    {
      label: 'submissions',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM submissions`),
    },
    {
      label: 'submission_likes',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM submission_likes`),
    },
    {
      label: 'submission_tags',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM submission_tags`),
    },
    { label: 'votes', q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM votes`) },
    // Users broken down by role and status so the operator sees how many
    // active producers will be wiped vs. soft-deleted rows that are already
    // hidden (hard DELETE removes them all regardless).
    {
      label: 'users (producer, active)',
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM users WHERE role = 'producer' AND status = 'active'`,
      ),
    },
    {
      label: 'users (producer, archived)',
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM users WHERE role = 'producer' AND status = 'archived'`,
      ),
    },
    {
      label: 'users (producer, deleted)',
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM users WHERE role = 'producer' AND status = 'deleted'`,
      ),
    },
    {
      label: 'users (ar)',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM users WHERE role = 'ar'`),
    },
    {
      label: 'users (admin)',
      q: d.execute<CountRow>(sql`SELECT COUNT(*)::text FROM users WHERE role = 'admin'`),
    },
    // sample_packs by kind
    {
      label: "sample_packs (kind='uploaded')",
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM sample_packs WHERE kind = 'uploaded'`,
      ),
    },
    {
      label: "sample_packs (kind='generated')",
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM sample_packs WHERE kind = 'generated'`,
      ),
    },
    {
      label: "sample_packs (kind='pool')",
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM sample_packs WHERE kind = 'pool'`,
      ),
    },
    // flip_sources by source
    {
      label: "flip_sources (source='upload')",
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM flip_sources WHERE source = 'upload'`,
      ),
    },
    {
      label: "flip_sources (source='freesound')",
      q: d.execute<CountRow>(
        sql`SELECT COUNT(*)::text FROM flip_sources WHERE source = 'freesound'`,
      ),
    },
  ];

  const results = await Promise.all(queries.map(async ({ label, q }) => ({ label, rows: await q })));

  for (const { label, rows } of results) {
    const count = rows[0]?.count ?? '?';
    console.log(`  ${label.padEnd(40)} ${count}`);
  }
}

// ---------------------------------------------------------------------------
// Destructive SQL
// ---------------------------------------------------------------------------

async function runDestructiveSQL(): Promise<void> {
  const d = db();

  console.log('');
  console.warn(`⚠  RUNNING DESTRUCTIVE SQL AGAINST ${dbUrl}`);
  console.log('  Waiting 3 seconds - Ctrl-C to abort...');
  await new Promise((resolve) => setTimeout(resolve, 3000));

  await d.transaction(async (tx) => {
    // Truncate match-related tables (CASCADE handles child FK rows)
    await tx.execute(
      sql`TRUNCATE TABLE matches, battle_phases, match_teams, match_players,
                       submissions, submission_likes, submission_tags, votes
            RESTART IDENTITY CASCADE`,
    );

    // Delete producer users (admin + ar survive)
    await tx.execute(sql`DELETE FROM users WHERE role = 'producer'`);

    // Orphaned sample packs (uploaded, no longer owned)
    await tx.execute(
      sql`DELETE FROM sample_packs WHERE kind = 'uploaded' AND created_by IS NULL`,
    );

    // Orphaned flip sources (uploaded, no longer owned)
    await tx.execute(
      sql`DELETE FROM flip_sources WHERE source = 'upload' AND created_by IS NULL`,
    );
  });

  console.log('  Database transaction committed.');
}

// ---------------------------------------------------------------------------
// S3 wipe
// ---------------------------------------------------------------------------

const S3_PREFIXES = ['matches/', 'submissions/', 'user-packs/', 'flips/'];

function buildS3Client(): S3Client {
  return new S3Client({
    region: env.S3_REGION ?? 'fr-par',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials:
      env.S3_ACCESS_KEY && env.S3_SECRET_KEY
        ? { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY }
        : undefined,
  });
}

async function wipeS3Objects(): Promise<void> {
  if (!env.S3_BUCKET) {
    console.warn('  S3_BUCKET not set - skipping S3 wipe');
    return;
  }

  const client = buildS3Client();
  const bucket = env.S3_BUCKET;

  console.log('');
  console.log('S3 wipe:');

  for (const prefix of S3_PREFIXES) {
    let totalDeleted = 0;
    let continuationToken: string | undefined;

    do {
      const listResp = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: 1000,
          ContinuationToken: continuationToken,
        }),
      );

      const objects: ObjectIdentifier[] = (listResp.Contents ?? [])
        .filter((o) => o.Key !== undefined)
        .map((o) => ({ Key: o.Key as string }));

      if (objects.length > 0) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        totalDeleted += objects.length;
      }

      continuationToken = listResp.IsTruncated ? listResp.NextContinuationToken : undefined;
    } while (continuationToken !== undefined);

    console.log(`  ${prefix.padEnd(20)} ${totalDeleted} objects deleted`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`clear-prod  [mode: ${isDryRun ? 'DRY RUN' : 'DESTRUCTIVE'}]`);
  console.log(`DATABASE_URL: ${dbUrl}`);
  console.log('');

  console.log('--- Before counts ---');
  await countAll();

  if (isDryRun) {
    console.log('');
    console.log('Dry-run complete. Pass --confirm with CONFIRM_CLEAR=yes to actually run.');
    return;
  }

  await runDestructiveSQL();

  if (wipeS3) {
    await wipeS3Objects();
  }

  console.log('');
  console.log('--- After counts ---');
  await countAll();

  console.log('');
  console.log('Done.');
}

main().catch((err) => {
  console.error('clear-prod failed:', err);
  process.exit(1);
});
