import { randomInt } from "node:crypto";
import { LRUCache } from "lru-cache";
import { generateToken } from "./token.js";

/** How long a TV's code stays usable, matching Jellyfin's own Quick Connect timeout. */
export const QUICK_CONNECT_TTL_MS = 10 * 60 * 1000;
/** Bounds memory if something floods `Initiate`; the oldest pending requests go first. */
const MAX_PENDING_REQUESTS = 500;
const CODE_DIGITS = 6;

/** What the device asking to sign in says about itself (from its Jellyfin auth header). */
export interface QuickConnectClient {
  readonly appName: string;
  readonly appVersion: string;
  readonly deviceId: string;
  readonly deviceName: string;
}

/**
 * One device waiting to be signed in. The device holds `secret` and polls with it; the
 * person types `code` into an already signed-in session to approve it.
 */
export interface QuickConnectRequest {
  readonly secret: string;
  readonly code: string;
  readonly client: QuickConnectClient;
  readonly createdAt: Date;
  /** Set once someone approves the code; the device then redeems `secret` for a session. */
  readonly authorizedUserId: string | null;
}

/**
 * Pending sign-ins by code ("Quick Connect" in Jellyfin's terms), held in memory like
 * Jellyfin does: they last minutes, there's one process, and a restart only means the TV
 * shows a new code. No session token is created until the device redeems its secret, so
 * nothing usable ever sits in this cache.
 */
export class QuickConnectRequests {
  private readonly bySecret: LRUCache<string, QuickConnectRequest>;

  constructor(private readonly now: () => Date) {
    this.bySecret = new LRUCache({
      max: MAX_PENDING_REQUESTS,
      ttl: QUICK_CONNECT_TTL_MS,
      perf: { now: () => this.now().getTime() },
    });
  }

  create(client: QuickConnectClient): QuickConnectRequest {
    let code: string;
    do {
      code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
    } while (this.byCode(code));
    const request: QuickConnectRequest = { secret: generateToken(), code, client, createdAt: this.now(), authorizedUserId: null };
    this.bySecret.set(request.secret, request);
    return request;
  }

  get(secret: string): QuickConnectRequest | null {
    return this.bySecret.get(secret) ?? null;
  }

  /** Approves a code for `userId`. Null if no device is waiting with that code. */
  authorize(code: string, userId: string): QuickConnectRequest | null {
    const pending = this.byCode(code.trim());
    if (!pending || pending.authorizedUserId) return null;
    const authorized = { ...pending, authorizedUserId: userId };
    // noUpdateTTL: approving doesn't extend how long the request lives.
    this.bySecret.set(pending.secret, authorized, { noUpdateTTL: true });
    return authorized;
  }

  /** Removes and returns an approved request, so a secret can be redeemed only once. */
  take(secret: string): QuickConnectRequest | null {
    const request = this.get(secret);
    if (!request?.authorizedUserId) return null;
    this.bySecret.delete(secret);
    return request;
  }

  private byCode(code: string): QuickConnectRequest | undefined {
    return this.bySecret.find((request) => request.code === code);
  }
}
