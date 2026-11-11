import { AuthService, OidcClient, SecretBox } from "@tessatv/auth";
import type {
  AuthSession,
  AuthSessionRepository,
  ServerSettings,
  ServerSettingsRepository,
  User,
  UserRepository,
} from "@tessatv/domain";
import { OAuth2Server } from "oauth2-mock-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

class Users implements UserRepository {
  users: User[] = [];
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
    if (this.users.length) return false;
    this.users.push(user);
    return true;
  }
  async createUser(user: User) {
    this.users.push(user);
  }
  async updatePasswordHash() {}
}

class Sessions implements AuthSessionRepository {
  private readonly sessions: AuthSession[] = [];
  async createSession(session: AuthSession) {
    this.sessions.push(session);
  }
  async getSessionByTokenHash(tokenHash: string) {
    return this.sessions.find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async touchSession() {}
  async deleteSession() {}
}

class Settings implements ServerSettingsRepository {
  settings: ServerSettings = { maxStreamHeight: null, oidc: null, jellyfin: null, fileHealthCheck: true, fileHealthFullSpeed: false };
  async get() {
    return this.settings;
  }
  async update(changes: Partial<ServerSettings>) {
    this.settings = { ...this.settings, ...changes };
    return this.settings;
  }
}

const APP_SECRET = "x".repeat(32);
const PUBLIC_URL = "http://tv.test";

/** Pulls `name=value` for one cookie out of a response's Set-Cookie headers. */
function cookie(setCookie: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = headers.map((header) => header.split(";")[0]!).find((pair) => pair.startsWith(`${name}=`));
  return match && match !== `${name}=` ? match : null;
}

describe("single sign-on", () => {
  const provider = new OAuth2Server();
  /** Claims the fake provider puts in the next ID token. */
  let claims: Record<string, unknown>;
  let users: Users;
  let app: ReturnType<typeof buildApp>;
  let adminCookie: string;
  const created: string[] = [];

  beforeAll(async () => {
    await provider.issuer.keys.generate("RS256");
    await provider.start(0, "127.0.0.1");
    provider.service.on("beforeTokenSigning", (token) => Object.assign(token.payload, claims));
  });
  afterAll(() => provider.stop());

  beforeEach(async () => {
    users = new Users();
    created.length = 0;
    const settings = new Settings();
    const auth = new AuthService(users, new Sessions());
    app = buildApp({
      libraryRepository: {} as never,
      metadataProviders: {},
      auth,
      settings,
      users,
      sso: {
        settings,
        client: new OidcClient(),
        clientSecrets: new SecretBox(APP_SECRET, "oidc-client-secret"),
        pendingSignIns: new SecretBox(APP_SECRET, "oidc-pending-sign-in"),
        onAccountCreated: async (user) => void created.push(user.username),
      },
    });
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "tessa", password: "hunter2hunter2" } });
    adminCookie = cookie(setup.headers["set-cookie"], "tessatv_session")!;
    claims = { sub: "sub-alex", preferred_username: "alex", groups: ["family"] };
  });

  async function configure(overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "PATCH",
      url: "/api/settings",
      headers: { cookie: adminCookie },
      payload: {
        oidc: {
          enabled: true,
          publicUrl: `${PUBLIC_URL}/`,
          issuerUrl: provider.issuer.url!,
          clientId: "tessatv",
          clientSecret: "client-secret",
          adminGroup: "tv-admins",
          requiredGroup: "",
          buttonLabel: "Sign in with Authentik",
          ...overrides,
        },
      },
    });
  }

  /** Runs a whole sign-in the way a browser does; returns where TessaTV finally sends it, and its session cookie. */
  async function signIn(): Promise<{ location: string; session: string | null }> {
    const start = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(start.statusCode).toBe(302);
    const pending = cookie(start.headers["set-cookie"], "tessatv_oidc");
    const atProvider = await fetch(start.headers.location!, { redirect: "manual" });
    const back = new URL(atProvider.headers.get("location")!);
    expect(back.origin + back.pathname).toBe(`${PUBLIC_URL}/api/auth/oidc/callback`);
    const callback = await app.inject({
      method: "GET",
      url: back.pathname + back.search,
      headers: pending ? { cookie: pending } : {},
    });
    expect(callback.statusCode).toBe(302);
    return { location: callback.headers.location!, session: cookie(callback.headers["set-cookie"], "tessatv_session") };
  }

  it("is off until configured, and refuses an issuer that doesn't answer", async () => {
    expect((await app.inject({ method: "GET", url: "/api/auth/session" })).json().sso).toBeNull();
    const unreachable = await configure({ issuerUrl: "http://127.0.0.1:9/" });
    expect(unreachable.statusCode).toBe(422);
    const login = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    expect(login.headers.location).toMatch(/^\/login\?error=/);
  });

  it("signs a new person in, creating their account, and never returns the client secret", async () => {
    // Typed without the trailing slash the provider's issuer has: accepted, and stored as the provider states it.
    const saved = await configure({ issuerUrl: provider.issuer.url!.replace(/\/$/, "") });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().oidc).toMatchObject({
      enabled: true,
      publicUrl: PUBLIC_URL,
      issuerUrl: provider.issuer.url,
      hasClientSecret: true,
      requiredGroup: null,
    });
    expect(JSON.stringify(saved.json())).not.toContain("client-secret");
    expect((await app.inject({ method: "GET", url: "/api/auth/session" })).json().sso).toEqual({ buttonLabel: "Sign in with Authentik" });

    const { location, session } = await signIn();
    expect(location).toBe("/");
    const me = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: session! } });
    expect(me.json().user).toMatchObject({ username: "alex", isAdmin: false });
    expect(created).toEqual(["alex"]);
    expect(users.users.find((user) => user.username === "alex")).toMatchObject({ passwordHash: null, oidcSubject: "sub-alex" });

    // Saving again without a secret keeps the saved one.
    expect((await configure({ clientSecret: undefined, buttonLabel: "SSO" })).statusCode).toBe(200);
    expect((await signIn()).location).toBe("/");
    expect(created).toEqual(["alex"]);
  });

  it("makes admin-group members admins, and links the local admin by username", async () => {
    await configure();
    claims = { sub: "sub-tessa", preferred_username: "tessa", groups: [] };
    const { session } = await signIn();
    const me = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: session! } });
    expect(me.json().user).toMatchObject({ username: "tessa", isAdmin: true });
    expect(created).toEqual([]);

    claims = { sub: "sub-sam", preferred_username: "sam", groups: ["tv-admins"] };
    const sam = await signIn();
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: sam.session! } })).json().user.isAdmin).toBe(true);

    const list = (await app.inject({ method: "GET", url: "/api/users", headers: { cookie: adminCookie } })).json();
    expect(list.map((user: { username: string; hasPassword: boolean; usesSso: boolean }) => [user.username, user.hasPassword, user.usesSso])).toEqual([
      ["tessa", true, true],
      ["sam", false, true],
    ]);
  });

  it("sends people outside the required group back to the login page with a reason", async () => {
    await configure({ requiredGroup: "tv" });
    const { location, session } = await signIn();
    expect(session).toBeNull();
    expect(decodeURIComponent(location)).toContain('isn\'t in the "tv" group');
  });

  it("rejects a callback without the sign-in cookie (another browser, or forged)", async () => {
    await configure();
    const start = await app.inject({ method: "GET", url: "/api/auth/oidc/login" });
    const atProvider = await fetch(start.headers.location!, { redirect: "manual" });
    const back = new URL(atProvider.headers.get("location")!);
    const callback = await app.inject({ method: "GET", url: back.pathname + back.search });
    expect(callback.headers.location).toMatch(/^\/login\?error=/);
    expect(cookie(callback.headers["set-cookie"], "tessatv_session")).toBeNull();
  });
});
