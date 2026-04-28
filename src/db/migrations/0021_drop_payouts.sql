-- Drop creator payout infrastructure. Payout feature removed for v0 launch;
-- no monetisation pipeline will be live at release. The creator_payouts table
-- and the payout_email / payout_iban columns on users are no longer referenced
-- by any application code after this migration.
--
-- CASCADE on DROP TABLE covers the creator_payouts_creator_id_users_id_fk FK
-- constraint added in migration 0019. The columns on users have no dependent
-- indexes or FKs beyond the column definition itself.

DROP TABLE IF EXISTS creator_payouts CASCADE;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "payout_email";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "payout_iban";
--> statement-breakpoint

-- Remove the revenue row from game_rules. The category is now dead code;
-- leaving it would confuse future admins viewing the rules editor.
DELETE FROM "game_rules" WHERE category = 'revenue';
