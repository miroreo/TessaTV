CREATE TABLE "audio_loudness" (
	"media_file_id" uuid PRIMARY KEY NOT NULL,
	"stream_index" integer NOT NULL,
	"integrated_lufs" double precision,
	"true_peak_dbtp" double precision,
	"measured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "audio_loudness" ADD CONSTRAINT "audio_loudness_media_file_id_media_file_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_file"("id") ON DELETE cascade ON UPDATE no action;