/**
 * The Jellyfin server version TessaTV reports. Clients gate features (and sometimes refuse
 * to connect) on this, so it names the API surface the compat layer is written against —
 * bump it only alongside the routes it implies.
 */
export const JELLYFIN_API_VERSION = "10.10.7";

export interface JellyfinServerInfo {
  /** 32-hex stable id — see `deriveServerId`. */
  readonly id: string;
  readonly name: string;
  readonly version: string;
}
