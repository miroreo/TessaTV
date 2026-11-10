import { randomUUID } from "node:crypto";
import type { AuthSession, AuthSessionRepository, LoginResponse, PublicUser, User, UserRepository } from "@tessatv/domain";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";
import { generateToken, hashToken } from "./token.js";

export const MIN_PASSWORD_LENGTH = 8;
const MAX_USERNAME_LENGTH = 64;
/** `lastSeenAt` is only rewritten this often, so authenticated reads aren't all DB writes. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type AuthErrorCode =
  | "setup_already_completed"
  | "invalid_username"
  | "weak_password"
  | "invalid_credentials"
  | "not_in_required_group"
  | "username_taken";

export class AuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface Authenticated {
  readonly user: PublicUser;
  readonly session: AuthSession;
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

/** Who the SSO provider says signed in. */
export interface OidcIdentity {
  /** The provider's stable id for this person. */
  readonly subject: string;
  /** `preferred_username`, falling back to email or the subject. */
  readonly username: string;
  readonly groups: readonly string[];
}

export interface OidcPolicy {
  readonly adminGroup: string | null;
  readonly requiredGroup: string | null;
}

export interface AuthServiceOptions {
  readonly now?: () => Date;
}

/**
 * Accounts and sessions for every client — TessaTV's UI today, Jellyfin-API clients
 * later. Callers only ever see tokens and `PublicUser`s.
 */
function validUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_USERNAME_LENGTH || /[\s\p{Cc}]/u.test(trimmed)) {
    throw new AuthError("invalid_username", `Username must be 1–${MAX_USERNAME_LENGTH} characters with no spaces`);
  }
  return trimmed;
}

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
  async completeSetup(username: string, password: string, clientName: string | null = null): Promise<LoginResponse> {
    const user = await this.buildUser(username, password, true);
    if (!(await this.users.createFirstUser(user))) {
      throw new AuthError("setup_already_completed", "Setup has already been completed");
    }
    return this.startSession(user, clientName);
  }

  async login(username: string, password: string, clientName: string | null = null): Promise<LoginResponse> {
    const user = await this.users.getUserByUsername(username.trim());
    // An SSO-only account has no password; checked against the dummy so timing doesn't say so.
    const valid = await verifyPassword(password, user?.passwordHash ?? (await this.dummyHash));
    if (!user?.passwordHash || !valid) throw new AuthError("invalid_credentials", "Invalid username or password");
    if (needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await hashPassword(password), this.now());
    }
    return this.startSession(user, clientName);
  }

  /**
   * Signs in someone the SSO provider vouched for. Their account is found by the provider's
   * subject; failing that, an account with the same username that isn't linked to SSO yet
   * becomes theirs (how an existing local admin starts using SSO); failing that, one is
   * created with no password. `created` says which, e.g. to apply held watch history.
   *
   * Admin comes from `policy.adminGroup` on every sign-in, so removing someone from the
   * group demotes them — except an account that also has a password (the local admin),
   * which SSO can make admin but never demote, so a provider mistake can't lock it out.
   */
  async signInWithOidc(
    identity: OidcIdentity,
    policy: OidcPolicy,
    clientName: string | null = null,
  ): Promise<LoginResponse & { created: boolean }> {
    if (policy.requiredGroup && !identity.groups.includes(policy.requiredGroup)) {
      throw new AuthError("not_in_required_group", `Your account isn't in the "${policy.requiredGroup}" group, which TessaTV requires`);
    }
    const inAdminGroup = policy.adminGroup !== null && identity.groups.includes(policy.adminGroup);
    const now = this.now();
    let user = await this.users.getUserByOidcSubject(identity.subject);
    if (!user) {
      const sameName = await this.users.getUserByUsername(identity.username);
      if (sameName?.oidcSubject) {
        throw new AuthError("username_taken", `The username "${identity.username}" already belongs to a different SSO account`);
      }
      user = sameName;
    }
    if (user) {
      const isAdmin = user.passwordHash ? user.isAdmin || inAdminGroup : inAdminGroup;
      if (user.oidcSubject !== identity.subject || user.isAdmin !== isAdmin) {
        await this.users.updateOidcLogin(user.id, { oidcSubject: identity.subject, isAdmin, updatedAt: now });
        user = { ...user, oidcSubject: identity.subject, isAdmin };
      }
      return { ...(await this.startSession(user, clientName)), created: false };
    }
    const created: User = {
      id: randomUUID(),
      username: validUsername(identity.username),
      passwordHash: null,
      oidcSubject: identity.subject,
      isAdmin: inAdminGroup,
      createdAt: now,
      updatedAt: now,
    };
    await this.users.createUser(created);
    return { ...(await this.startSession(created, clientName)), created: true };
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
    const trimmed = validUsername(username);
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new AuthError("weak_password", `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const now = this.now();
    return {
      id: randomUUID(),
      username: trimmed,
      passwordHash: await hashPassword(password),
      oidcSubject: null,
      isAdmin,
      createdAt: now,
      updatedAt: now,
    };
  }

  private async startSession(user: User, clientName: string | null): Promise<LoginResponse> {
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
