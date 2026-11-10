CREATE TABLE "held_watch_history" (
	"username_lower" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"position_seconds" double precision NOT NULL,
	"duration_seconds" double precision,
	"completed" boolean DEFAULT false NOT NULL,
	"watched_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "held_watch_history_username_lower_unit_id_pk" PRIMARY KEY("username_lower","unit_id")
);
--> statement-breakpoint
ALTER TABLE "held_watch_history" ADD CONSTRAINT "held_watch_history_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;