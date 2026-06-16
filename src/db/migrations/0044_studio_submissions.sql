-- Community-submitted Sample Flips + vote signals for flips and packs.

-- Flip sources gain a review state. Existing admin-generated rows are already
-- active=true; backfill reviewed_at so they are never seen as pending.
ALTER TABLE "flip_sources" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flip_sources" ADD COLUMN "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
UPDATE "flip_sources" SET "reviewed_at" = "created_at" WHERE "reviewed_at" IS NULL;--> statement-breakpoint

CREATE TABLE "flip_source_votes" (
	"flip_source_id" uuid NOT NULL REFERENCES "flip_sources"("id") ON DELETE cascade,
	"voter_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flip_source_votes_flip_source_id_voter_id_pk" PRIMARY KEY("flip_source_id","voter_id")
);--> statement-breakpoint

CREATE TABLE "sample_pack_votes" (
	"pack_id" uuid NOT NULL REFERENCES "sample_packs"("id") ON DELETE cascade,
	"voter_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sample_pack_votes_pack_id_voter_id_pk" PRIMARY KEY("pack_id","voter_id")
);--> statement-breakpoint

-- Pack review state (symmetric with flip_sources). Existing pool/generated
-- packs (and any pre-existing uploaded ones) are backfilled so they are not
-- treated as pending.
ALTER TABLE "sample_packs" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sample_packs" ADD COLUMN IF NOT EXISTS "reviewed_by" uuid REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
UPDATE "sample_packs" SET "reviewed_at" = "created_at" WHERE "reviewed_at" IS NULL AND "kind" <> 'uploaded';
