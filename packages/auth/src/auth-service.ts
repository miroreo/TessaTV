import { randomUUID } from "node:crypto";
import type { AuthSession, AuthSessionRepository, User, UserRepository } from "@tessatv/domain";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { generateToken, hashToken } from "./token.js";

export const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 64;
/** `lastSeenAt` is only rewritten this often, so authenticated reads aren't all DB writes. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type AuthErrorCode = "setup_already_completed" | "invalid_username" | "weak_password" | "invalid_credentials";

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** A user as it's safe to send to a client — no password hash. */
export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

export interface LoginResult {
  /** The bearer token. Only ever returned here; the server keeps just its hash. */
  readonly token: string;
  readonly user: PublicUser;
}

export interface Authenticated {
  readonly user: PublicUser;
  readonly session: AuthSession;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

export interface AuthServiceOptions {
  readonly now?: () => Date;
}

/**
 * Accounts and sessions for every client — TessaTV's UI today, Jellyfin-API clients
 * later. Callers only ever see tokens and `PublicUser`s.
 */
export class AuthService {
  private readonly now: () => Date;
  /** Verified against for unknown usernames so response time doesn't reveal which exist. */
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: AuthSessionRepository,
    options: AuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.dummyHash = hashPassword(generateToken());
  }

  async needsSetup(): Promise<boolean> {
    return (await this.users.countUsers()) === 0;
  }

  /** First-run: creates the initial admin and logs them in. Fails once any user exists. */
  async completeSetup(username: string, password: string, clientName: string | null = null): Promise<LoginResult> {
    const user = await this.buildUser(username, password, true);
    if (!(await this.users.createFirstUser(user))) {
      throw new AuthError("setup_already_completed", "Setup has already been completed");
    }
    return this.startSession(user, clientName);
  }

  async login(username: string, password: string, clientName: string | null = null): Promise<LoginResult> {
    const user = await this.users.getUserByUsername(username.trim());
    const valid = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !valid) throw new AuthError("invalid_credentials", "Invalid username or password");
    if (needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await hashPassword(password), this.now());
    }
    return this.startSession(user, clientName);
  }

  /** Resolves a bearer token to its user, or null if it's unknown/revoked. */
  async authenticate(token: string): Promise<Authenticated | null> {
    const session = await this.sessions.getSessionByTokenHash(hashToken(token));
    if (!session) return null;
    const user = await this.users.getUser(session.userId);
    if (!user) return null;
    const now = this.now();
    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.sessions.touchSession(session.id, now);
    }
    return { user: toPublicUser(user), session };
  }

  async logout(token: string): Promise<void> {
    const session = await this.sessions.getSessionByTokenHash(hashToken(token));
    if (session) await this.sessions.deleteSession(session.id);
  }

  private async buildUser(username: string, password: string, isAdmin: boolean): Promise<User> {
    const trimmed = username.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_LENGTH || /[\s\p{Cc}]/u.test(trimmed)) {
      throw new AuthError("invalid_username", `Username must be 1–${MAX_USERNAME_LENGTH} characters with no spaces`);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError("weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const now = this.now();
    return {
      id: randomUUID(),
      username: trimmed,
      passwordHash: await hashPassword(password),
      isAdmin,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async startSession(user: User, clientName: string | null): Promise<LoginResult> {
    const token = generateToken();
    const now = this.now();
    await this.sessions.createSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(token),
      clientName,
      createdAt: now,
      lastSeenAt: now,
    });
    return { token, user: toPublicUser(user) };
  }
}
