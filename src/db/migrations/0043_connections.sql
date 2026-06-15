-- Friend connections: mutual, approval-based (distinct from one-way follows).
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TABLE "connections" (
	"requester_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"addressee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "connections_requester_id_addressee_id_pk" PRIMARY KEY("requester_id","addressee_id")
);
