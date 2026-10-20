CREATE TABLE "external_id" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_node" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_type" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" uuid,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"monitored" boolean DEFAULT true NOT NULL,
	"quality_profile_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"path" text NOT NULL,
	"container" text NOT NULL,
	"video_codec" text,
	"audio_codec" text,
	"resolution_width" integer,
	"resolution_height" integer,
	"size_bytes" bigint NOT NULL,
	"checksum" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"rank" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"allowed_quality_ids" jsonb NOT NULL,
	"cutoff_quality_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"library_node_id" uuid NOT NULL,
	"media_type" text NOT NULL,
	"title" text NOT NULL,
	"sequence_path" jsonb NOT NULL,
	"availability" text DEFAULT 'missing' NOT NULL,
	"media_file_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_file" ADD CONSTRAINT "media_file_unit_id_unit_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."unit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit" ADD CONSTRAINT "unit_library_node_id_library_node_id_fk" FOREIGN KEY ("library_node_id") REFERENCES "public"."library_node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "external_id_provider_entity" ON "external_id" USING btree ("provider","entity_type","entity_id");