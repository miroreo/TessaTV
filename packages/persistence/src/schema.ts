import {
  boolean,
  doublePrecision,
  index,
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
import { sql } from "drizzle-orm";

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
  sourceKey: text("source_key").notNull(),
  sourceAliases: jsonb("source_aliases").notNull().$type<string[]>().default([]),
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

/** `user` is reserved in Postgres, hence `app_user`. One account table for TessaTV's UI and
 * Jellyfin-API clients alike. */
export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("app_user_username_lower").on(sql`lower(${table.username})`)],
);

/** Only the SHA-256 of each bearer token is stored; deleting a row revokes that session. */
export const authSession = pgTable(
  "auth_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    clientName: text("client_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("auth_session_token_hash").on(table.tokenHash)],
);

/**
 * One row per (user, unit), overwritten as playback progresses — see `WatchProgress`.
 * Both references are `restrict`, so the database refuses to delete a user or unit that
 * still has watch history: code that removes one must move its history first
 * (`LibraryRepository.moveWatchProgress`), and nothing can lose it by cascade.
 */
export const watchProgress = pgTable(
  "watch_progress",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => appUser.id, { onDelete: "restrict" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unit.id, { onDelete: "restrict" }),
    positionSeconds: doublePrecision("position_seconds").notNull(),
    durationSeconds: doublePrecision("duration_seconds"),
    completed: boolean("completed").notNull().default(false),
    watchedAt: timestamp("watched_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.unitId] }),
    index("watch_progress_user_recent").on(table.userId, table.updatedAt),
  ],
);

/** One loudness measurement per media file — see `LoudnessMeasurement`. */
export const audioLoudness = pgTable("audio_loudness", {
  mediaFileId: uuid("media_file_id")
    .primaryKey()
    .references(() => mediaFile.id, { onDelete: "cascade" }),
  streamIndex: integer("stream_index").notNull(),
  integratedLufs: doublePrecision("integrated_lufs"),
  truePeakDbtp: doublePrecision("true_peak_dbtp"),
  measuredAt: timestamp("measured_at", { withTimezone: true }).notNull().defaultNow(),
  error: text("error"),
});

/** Folders the scheduled library scan imports from — see `LibraryFolder`. */
export const libraryFolder = pgTable(
  "library_folder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mediaType: text("media_type").notNull(),
    path: text("path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("library_folder_path").on(table.path)],
);

/**
 * Admin settings as key/value rows (see `ServerSettings`), so adding a setting needs no
 * migration. Values are validated when read; a missing or unrecognised one means the default.
 */
export const serverSetting = pgTable("server_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
