import type { AuthSession, AuthSessionRepository, User, UserRepository } from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { AuthError, AuthService } from "./auth-service.js";
import { hashToken } from "./token.js";

class InMemoryUsers implements UserRepository {
  readonly users: User[] = [];
  async countUsers() {
    return this.users.length;
  }
  async getUserByOidcSubject(subject: string) {
    return this.users.find((user) => user.oidcSubject === subject) ?? null;
  }
  async listUsers() {
    return [...this.users];
  }
  async updateOidcLogin(id: string, changes: { oidcSubject: string; isAdmin: boolean; updatedAt: Date }) {
    const index = this.users.findIndex((user) => user.id === id);
    if (index >= 0) this.users[index] = { ...this.users[index]!, ...changes };
  }
  async getUser(id: string) {
    return this.users.find((user) => user.id === id) ?? null;
  }
  async getUserByUsername(username: string) {
    return this.users.find((user) => user.username.toLowerCase() === username.toLowerCase()) ?? null;
  }
  async createFirstUser(user: User) {
    if (this.users.length > 0) return false;
    this.users.push(user);
    return true;
  }
  async createUser(user: User) {
    this.users.push(user);
  }
  async updatePasswordHash(id: string, passwordHash: string, updatedAt: Date) {
    const index = this.users.findIndex((user) => user.id === id);
    if (index >= 0) this.users[index] = { ...this.users[index]!, passwordHash, updatedAt };
  }
}

class InMemorySessions implements AuthSessionRepository {
  readonly sessions = new Map<string, AuthSession>();
  touches = 0;
  async createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
  }
  async getSessionByTokenHash(tokenHash: string) {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async touchSession(id: string, lastSeenAt: Date) {
    this.touches++;
    const session = this.sessions.get(id);
    if (session) this.sessions.set(id, { ...session, lastSeenAt });
  }
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
}

function setup(now = () => new Date()) {
  const users = new InMemoryUsers();
  const sessions = new InMemorySessions();
  return { users, sessions, auth: new AuthService(users, sessions, { now }) };
}

const expectAuthError = (code: string) => expect.objectContaining({ name: "AuthError", code });

describe("AuthService", () => {
  it("needs setup until the first user exists", async () => {
    const { auth } = setup();
    expect(await auth.needsSetup()).toBe(true);
    await auth.completeSetup("tessa", "hunter2hunter2");
    expect(await auth.needsSetup()).toBe(false);
  });

  it("first-run setup creates an admin and logs them in", async () => {
    const { auth, users, sessions } = setup();
    const result = await auth.completeSetup("  Tessa ", "hunter2hunter2", "Firefox");
    expect(result.user).toEqual({ id: users.users[0]!.id, username: "Tessa", isAdmin: true });
    expect(users.users[0]?.passwordHash).not.toContain("hunter2");
    const [session] = sessions.sessions.values();
    expect(session).toMatchObject({ userId: result.user.id, clientName: "Firefox", tokenHash: hashToken(result.token) });
    expect(session?.tokenHash).not.toBe(result.token);
  });

  it("refuses a second setup", async () => {
    const { auth } = setup();
    await auth.completeSetup("tessa", "hunter2hunter2");
    await expect(auth.completeSetup("mallory", "hunter2hunter2")).rejects.toEqual(expectAuthError("setup_already_completed"));
  });

  it("validates usernames and passwords", async () => {
    const { auth } = setup();
    await expect(auth.completeSetup("", "hunter2hunter2")).rejects.toEqual(expectAuthError("invalid_username"));
    await expect(auth.completeSetup("two words", "hunter2hunter2")).rejects.toEqual(expectAuthError("invalid_username"));
    await expect(auth.completeSetup("tessa", "short")).rejects.toEqual(expectAuthError("weak_password"));
    expect(await auth.needsSetup()).toBe(true);
  });

  it("logs in case-insensitively by username and issues a distinct token per session", async () => {
    const { auth } = setup();
    const first = await auth.completeSetup("Tessa", "hunter2hunter2");
    const second = await auth.login("tessa", "hunter2hunter2");
    expect(second.user.id).toBe(first.user.id);
    expect(second.token).not.toBe(first.token);
  });

  it("upgrades a legacy scrypt hash to Argon2id on successful login", async () => {
    const { users, auth } = setup();
    const now = new Date();
    users.users.push({
      id: "legacy",
      username: "old-timer",
      // "legacy password" hashed by the pre-Argon2 scrypt code.
      passwordHash:
        "scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA==$IbaAHYC6LGP6AdIGYpO90hmeSs8RSTupJrMFD431IZRsVygrRS0Yb5F581vxfQUkquWyyudJXzTgGEwC+/HtQA==",
      oidcSubject: null,
      isAdmin: true,
      createdAt: now,
      updatedAt: now,
    });
    await auth.login("old-timer", "legacy password");
    expect(users.users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(auth.login("old-timer", "legacy password")).resolves.toBeDefined();
  });

  it("gives the same error for a wrong password and an unknown user", async () => {
    const { auth } = setup();
    await auth.completeSetup("tessa", "hunter2hunter2");
    const wrongPassword = auth.login("tessa", "nope-nope-nope").catch((error: unknown) => error);
    const unknownUser = auth.login("nobody", "hunter2hunter2").catch((error: unknown) => error);
    const [a, b] = (await Promise.all([wrongPassword, unknownUser])) as AuthError[];
    expect(a?.code).toBe("invalid_credentials");
    expect(b?.code).toBe("invalid_credentials");
    expect(a?.message).toBe(b?.message);
  });

  it("authenticates a live token and rejects unknown or logged-out ones", async () => {
    const { auth } = setup();
    const { token, user } = await auth.completeSetup("tessa", "hunter2hunter2");
    expect((await auth.authenticate(token))?.user).toEqual(user);
    expect(await auth.authenticate("not-a-token")).toBeNull();
    await auth.logout(token);
    expect(await auth.authenticate(token)).toBeNull();
  });

  it("only rewrites lastSeenAt every few minutes", async () => {
    let clock = new Date("2026-10-20T12:00:00Z");
    const { auth, sessions } = setup(() => clock);
    const { token } = await auth.completeSetup("tessa", "hunter2hunter2");
    await auth.authenticate(token);
    expect(sessions.touches).toBe(0);
    clock = new Date("2026-10-20T12:06:00Z");
    await auth.authenticate(token);
    await auth.authenticate(token);
    expect(sessions.touches).toBe(1);
  });

  describe("signInWithOidc", () => {
    const policy = { adminGroup: "tv-admins", requiredGroup: null };
    const alex = { subject: "sub-alex", username: "alex", groups: ["family"] };

    it("creates a password-less account on first sign-in and finds it by subject afterwards", async () => {
      const { users, auth } = setup();
      const first = await auth.signInWithOidc(alex, policy);
      expect(first).toMatchObject({ created: true, user: { username: "alex", isAdmin: false } });
      expect(users.users[0]).toMatchObject({ passwordHash: null, oidcSubject: "sub-alex" });
      // Renamed at the provider: still the same account.
      const again = await auth.signInWithOidc({ ...alex, username: "alexandra" }, policy);
      expect(again).toMatchObject({ created: false, user: { id: first.user.id } });
      await expect(auth.login("alex", "anything at all")).rejects.toMatchObject({ code: "invalid_credentials" });
    });

    it("links the existing local admin by username, and never demotes an account that has a password", async () => {
      const { users, auth } = setup();
      const local = await auth.completeSetup("tessa", "hunter2hunter2");
      const sso = await auth.signInWithOidc({ subject: "sub-tessa", username: "Tessa", groups: [] }, policy);
      expect(sso).toMatchObject({ created: false, user: { id: local.user.id, isAdmin: true } });
      expect(users.users[0]!.oidcSubject).toBe("sub-tessa");
      await expect(auth.login("tessa", "hunter2hunter2")).resolves.toBeDefined();
    });

    it("lets the admin group grant and revoke admin on SSO-only accounts", async () => {
      const { auth } = setup();
      expect((await auth.signInWithOidc({ ...alex, groups: ["tv-admins"] }, policy)).user.isAdmin).toBe(true);
      expect((await auth.signInWithOidc(alex, policy)).user.isAdmin).toBe(false);
      expect((await auth.signInWithOidc({ ...alex, groups: ["tv-admins"] }, { adminGroup: null, requiredGroup: null })).user.isAdmin).toBe(false);
    });

    it("refuses people outside the required group, and a username held by another SSO account", async () => {
      const { auth } = setup();
      await expect(auth.signInWithOidc(alex, { ...policy, requiredGroup: "tv" })).rejects.toMatchObject({ code: "not_in_required_group" });
      await auth.signInWithOidc(alex, policy);
      await expect(auth.signInWithOidc({ ...alex, subject: "someone-else" }, policy)).rejects.toMatchObject({ code: "username_taken" });
    });
  });
});
