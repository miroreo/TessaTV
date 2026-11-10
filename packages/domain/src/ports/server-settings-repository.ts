import type { ServerSettings } from "../server-settings.js";

export interface ServerSettingsRepository {
  /** Every setting, with defaults for any never saved. */
  get(): Promise<ServerSettings>;
  /** Saves the given settings, leaving the rest as they are; returns the result. */
  update(changes: Partial<ServerSettings>): Promise<ServerSettings>;
}
