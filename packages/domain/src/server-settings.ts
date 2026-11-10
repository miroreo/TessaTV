/** Heights offered for the stream resolution cap, tallest first. */
export const MAX_STREAM_HEIGHTS = [2160, 1440, 1080, 720, 480] as const;
export type MaxStreamHeight = (typeof MAX_STREAM_HEIGHTS)[number];

/**
 * Sign-in through an OpenID Connect provider (Authentik, Keycloak, Pocket ID, ...).
 * Anyone the provider lets through gets an account on first sign-in.
 */
export interface OidcSettings {
  readonly enabled: boolean;
  /** TessaTV's own address as people reach it, e.g. `https://tv.example.com`; the callback URL is built from it. */
  readonly publicUrl: string;
  /** The provider's issuer, e.g. `https://auth.example.com/application/o/tessatv/` for Authentik. */
  readonly issuerUrl: string;
  readonly clientId: string;
  /** Encrypted with a key derived from `APP_SECRET` — see `packages/auth`'s `SecretBox`. */
  readonly clientSecretSealed: string;
  /** Members of this group (from the `groups` claim) are admins. Null: nobody is made admin by SSO. */
  readonly adminGroup: string | null;
  /** When set, only members of this group may sign in. */
  readonly requiredGroup: string | null;
  /** The login page's button text, e.g. "Sign in with Authentik". */
  readonly buttonLabel: string;
}

/** A Jellyfin server to import watch history from (Settings page). */
export interface JellyfinImportSettings {
  /** e.g. `http://jellyfin.lan:8096` */
  readonly url: string;
  /** A Jellyfin API key (Dashboard → API Keys), sealed like the OIDC client secret. */
  readonly apiKeySealed: string;
}

/** Server-wide settings an admin changes on the settings page. */
export interface ServerSettings {
  /**
   * No stream is sent taller than this; a taller file is transcoded down rather than played
   * as-is. Null means no cap. Viewers' own quality choice can only go lower.
   */
  readonly maxStreamHeight: MaxStreamHeight | null;
  /** Null until an admin sets up single sign-on. */
  readonly oidc: OidcSettings | null;
  /** Null until an admin points TessaTV at a Jellyfin server. */
  readonly jellyfin: JellyfinImportSettings | null;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { maxStreamHeight: null, oidc: null, jellyfin: null };
