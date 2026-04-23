CREATE TABLE "flip_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"genre_id" uuid,
	"url" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"duration_sec" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flip_sources" ADD CONSTRAINT "flip_sources_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flip_sources" ADD CONSTRAINT "flip_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;