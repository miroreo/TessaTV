import {
  DEFAULT_SERVER_SETTINGS,
  MAX_STREAM_HEIGHTS,
  type JellyfinImportSettings,
  type OidcSettings,
  type ServerSettings,
  type ServerSettingsRepository,
} from "@tessatv/domain";
import { sql } from "drizzle-orm";
import type { Database } from "./db.js";
import { serverSetting } from "./schema.js";

/** Accepts a stored value only if it's still one the setting allows (the options may change). */
const PARSERS: { [K in keyof ServerSettings]: (value: unknown) => ServerSettings[K] | undefined } = {
  maxStreamHeight: (value) =>
    value === null ? null : MAX_STREAM_HEIGHTS.find((height) => height === value),
  oidc: (value) => (value === null ? null : parseOidc(value)),
  jellyfin: (value) => (value === null ? null : parseJellyfin(value)),
};

function parseJellyfin(value: unknown): JellyfinImportSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { url, apiKeySealed } = value as Record<string, unknown>;
  return typeof url === "string" && typeof apiKeySealed === "string" ? { url, apiKeySealed } : undefined;
}

function parseOidc(value: unknown): OidcSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : undefined);
  const optional = (key: string) => (v[key] === null ? null : text(key));
  const [publicUrl, issuerUrl, clientId, clientSecretSealed, buttonLabel] = [
    text("publicUrl"), text("issuerUrl"), text("clientId"), text("clientSecretSealed"), text("buttonLabel"),
  ];
  const adminGroup = optional("adminGroup");
  const requiredGroup = optional("requiredGroup");
  if (
    typeof v.enabled !== "boolean" || publicUrl === undefined || issuerUrl === undefined || clientId === undefined ||
    clientSecretSealed === undefined || buttonLabel === undefined || adminGroup === undefined || requiredGroup === undefined
  ) {
    return undefined;
  }
  return { enabled: v.enabled, publicUrl, issuerUrl, clientId, clientSecretSealed, adminGroup, requiredGroup, buttonLabel };
}

export class DrizzleServerSettingsRepository implements ServerSettingsRepository {
  constructor(private readonly db: Database) {}

  async get(): Promise<ServerSettings> {
    const rows = await this.db.select().from(serverSetting);
    const settings: Record<string, unknown> = { ...DEFAULT_SERVER_SETTINGS };
    for (const { key, value } of rows) {
      const parse = PARSERS[key as keyof ServerSettings];
      const parsed = parse?.(value);
      if (parsed !== undefined) settings[key] = parsed;
    }
    return settings as unknown as ServerSettings;
  }

  async update(changes: Partial<ServerSettings>): Promise<ServerSettings> {
    const rows = Object.entries(changes)
      .filter(([, value]) => value !== undefined)
      // A JS null would become SQL NULL; "no cap" and the like are stored as JSON null.
      .map(([key, value]) => ({ key, value: value === null ? sql`'null'::jsonb` : value, updatedAt: new Date() }));
    if (rows.length > 0) {
      await this.db
        .insert(serverSetting)
        .values(rows)
        .onConflictDoUpdate({ target: serverSetting.key, set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` } });
    }
    return this.get();
  }
}
