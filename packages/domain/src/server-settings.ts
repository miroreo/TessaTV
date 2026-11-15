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

/** Hardware video acceleration, chosen on the settings page. */
export interface HardwareAccelSettings {
  readonly enabled: boolean;
  /**
   * VAAPI render nodes (e.g. `/dev/dri/renderD128`), most wanted first: the first one that
   * works is used. Empty means every render node the machine has, in name order. When none
   * works, transcodes run on the CPU.
   */
  readonly devices: readonly string[];
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
  /**
   * Decode every file in the background to find damaged ones (see `FileHealth`). Turning it
   * off also stops damaged results from changing how files play.
   */
  readonly fileHealthCheck: boolean;
  /**
   * Run the file health check flat out: no read-rate throttle, every CPU core, and no pausing
   * while a transcode runs (it still runs at the lowest priority). For catching up on a
   * library, then switching back; it doesn't switch itself off.
   */
  readonly fileHealthFullSpeed: boolean;
  /** Null until an admin chooses: the `HARDWARE_ACCEL` / `VAAPI_DEVICE` environment variables apply. */
  readonly hardwareAccel: HardwareAccelSettings | null;
}

export const DEFAULT_SERVER_SETTINGS: ServerSettings = { maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false, hardwareAccel: null };
