ALTER TABLE "file_health" ADD COLUMN "severity" text DEFAULT 'clean' NOT NULL;--> statement-breakpoint
ALTER TABLE "file_health" ADD COLUMN "video_errors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file_health" ADD COLUMN "audio_errors" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Results saved before grading have no severity (and stopped at the first error, so no counts).
-- Forget the flagged ones: the monitor re-checks them as never-checked and grades them this time.
DELETE FROM "file_health" WHERE "error" IS NOT NULL;