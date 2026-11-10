/**
 * One account, shared by TessaTV's own UI and (later) Jellyfin-API clients — there is no
 * second, Jellyfin-specific user table.
 */
export interface User {
  readonly id: string;
  /** Display form as entered. Uniqueness is case-insensitive. */
  readonly username: string;
  /**
   * Self-describing hash string produced by `packages/auth` — never a plaintext password.
   * Null for an account that only signs in through SSO.
   */
  readonly passwordHash: string | null;
  /** The SSO provider's stable `sub` for this person, once they've signed in through it. */
  readonly oidcSubject: string | null;
  readonly isAdmin: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A logged-in device/browser. Only a hash of the bearer token is stored, so a database
 * leak doesn't hand out working sessions. Revoked by deleting the row.
 */
export interface AuthSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  /** Free-form client description (e.g. user agent or Jellyfin `Client`/`Device`). */
  readonly clientName: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}
