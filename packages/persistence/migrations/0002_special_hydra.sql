CREATE TABLE "scheduled_job" (
	"name" text PRIMARY KEY NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_error" text
);
