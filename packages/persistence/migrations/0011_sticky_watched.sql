ALTER TABLE "watch_progress" ADD COLUMN "watched_at" timestamp with time zone;--> statement-breakpoint
-- Everything already finished counts as watched; updated_at is the closest record of when.
UPDATE "watch_progress" SET "watched_at" = "updated_at" WHERE "completed";
