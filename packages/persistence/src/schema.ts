import {
  boolean,
  integer,
  bigint,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * One generic tree table for every media type's browsable entries (Movie, Series, Season).
 * "collection" rows have children; "leaf" rows own exactly one row in `unit`.
 */
export const libraryNode = pgTable("library_node", {
  id: uuid("id").primaryKey().defaultRandom(),
  mediaType: text("media_type").notNull(),
  kind: text("kind").notNull(),
  parentId: uuid("parent_id"),
  title: text("title").notNull(),
  sortTitle: text("sort_title").notNull(),
  monitored: boolean("monitored").notNull().default(true),
  qualityProfileId: uuid("quality_profile_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const unit = pgTable("unit", {
  id: uuid("id").primaryKey().defaultRandom(),
  libraryNodeId: uuid("library_node_id")
    .notNull()
    .references(() => libraryNode.id, { onDelete: "cascade" }),
  mediaType: text("media_type").notNull(),
  title: text("title").notNull(),
  sequencePath: jsonb("sequence_path").notNull().$type<number[]>(),
  availability: text("availability").notNull().default("missing"),
  mediaFileId: uuid("media_file_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mediaFile = pgTable("media_file", {
  id: uuid("id").primaryKey().defaultRandom(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => unit.id, { onDelete: "cascade" }),
  path: text("path").notNull(),
  container: text("container").notNull(),
  videoCodec: text("video_codec"),
  audioCodec: text("audio_codec"),
  resolutionWidth: integer("resolution_width"),
  resolutionHeight: integer("resolution_height"),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  checksum: text("checksum"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Polymorphic id-mapping table shared by every entity and every metadata provider —
 * avoids a `tmdb_id`/`tvdb_id` column per table that would grow with each new provider.
 */
export const externalId = pgTable(
  "external_id",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id").notNull(),
    providerId: text("provider_id").notNull(),
  },
  (table) => [uniqueIndex("external_id_provider_entity").on(table.provider, table.entityType, table.entityId)],
);

export const qualityDefinition = pgTable("quality_definition", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  rank: integer("rank").notNull(),
});

export const qualityProfile = pgTable("quality_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  allowedQualityIds: jsonb("allowed_quality_ids").notNull().$type<string[]>(),
  cutoffQualityId: uuid("cutoff_quality_id").notNull(),
});

/** Raw per-provider lookup results, keyed by (provider, externalId) — read by artwork/detail
 * endpoints instead of hitting the provider's API on every request. */
export const metadataCache = pgTable(
  "metadata_cache",
  {
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.externalId] })],
);
