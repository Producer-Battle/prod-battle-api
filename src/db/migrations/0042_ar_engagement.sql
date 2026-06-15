-- A&R engagement layer: picks (track ratings), contact requests ("a label is
-- interested"), and briefs (label-posted challenges) + their submissions.
CREATE TYPE "public"."ar_contact_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."ar_brief_status" AS ENUM('open', 'judging', 'closed');--> statement-breakpoint
CREATE TABLE "ar_picks" (
	"ar_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"submission_id" uuid NOT NULL REFERENCES "submissions"("id") ON DELETE cascade,
	"score" integer NOT NULL,
	"note" text,
	"cosign" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ar_picks_ar_user_id_submission_id_pk" PRIMARY KEY("ar_user_id","submission_id")
);
--> statement-breakpoint
CREATE TABLE "ar_contact_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ar_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"producer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"message" text NOT NULL,
	"status" "ar_contact_status" DEFAULT 'pending' NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ar_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ar_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"genre_id" uuid REFERENCES "genres"("id") ON DELETE set null,
	"bpm_hint" text,
	"reward" text,
	"deadline" timestamp with time zone NOT NULL,
	"status" "ar_brief_status" DEFAULT 'open' NOT NULL,
	"winner_submission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ar_brief_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL REFERENCES "ar_briefs"("id") ON DELETE cascade,
	"producer_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"audio_url" text NOT NULL,
	"title" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ar_brief_submissions_brief_producer_unique" ON "ar_brief_submissions" ("brief_id","producer_id");
