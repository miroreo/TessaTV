CREATE TABLE "file_health" (
	"media_file_id" uuid PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"size_bytes" bigint NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "file_health" ADD CONSTRAINT "file_health_media_file_id_media_file_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_file"("id") ON DELETE cascade ON UPDATE no action;