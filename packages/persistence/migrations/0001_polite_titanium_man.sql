CREATE TABLE "metadata_cache" (
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metadata_cache_provider_external_id_pk" PRIMARY KEY("provider","external_id")
);
