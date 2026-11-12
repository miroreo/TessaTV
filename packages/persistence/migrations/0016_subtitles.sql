CREATE TABLE "subtitle_blacklist" (
	"unit_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subtitle_blacklist_unit_id_provider_provider_id_pk" PRIMARY KEY("unit_id","provider","provider_id")
);
--> statement-breakpoint
CREATE TABLE "subtitle_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"media_file_id" uuid NOT NULL,
	"language" text NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"hearing_impaired" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"provider_id" text,
	"score" integer,
	"path" text NOT NULL,
	"format" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitle_search" (
	"unit_id" uuid NOT NULL,
	"slot_key" text NOT NULL,
	"outcome" text NOT NULL,
	"attempts" integer NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"retry_after" timestamp with time zone NOT NULL,
	CONSTRAINT "subtitle_search_unit_id_slot_key_pk" PRIMARY KEY("unit_id","slot_key")
);
--> statement-breakpoint
ALTER TABLE "subtitle_blacklist" ADD CONSTRAINT "subtitle_blacklist_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_file" ADD CONSTRAINT "subtitle_file_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_file" ADD CONSTRAINT "subtitle_file_media_file_id_media_file_id_fk" FOREIGN KEY ("media_file_id") REFERENCES "public"."media_file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subtitle_search" ADD CONSTRAINT "subtitle_search_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subtitle_file_path" ON "subtitle_file" USING btree ("path");--> statement-breakpoint
CREATE INDEX "subtitle_file_unit" ON "subtitle_file" USING btree ("unit_id");