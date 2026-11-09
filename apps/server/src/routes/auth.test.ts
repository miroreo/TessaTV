import { AuthService } from "@tessatv/auth";
import type {
  AuthSession,
  AuthSessionRepository,
  LibraryNode,
  LibraryRepository,
  MediaFile,
  Unit,
  User,
  UserRepository,
} from "@tessatv/domain";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

class InMemoryUsers implements UserRepository {
  private readonly users: User[] = [];
  async countUsers() {
    return this.users.length;
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
  private readonly sessions = new Map<string, AuthSession>();
  async createSession(session: AuthSession) {
    this.sessions.set(session.id, session);
  }
  async getSessionByTokenHash(tokenHash: string) {
    return [...this.sessions.values()].find((session) => session.tokenHash === tokenHash) ?? null;
  }
  async touchSession() {}
  async deleteSession(id: string) {
    this.sessions.delete(id);
  }
}

class EmptyLibrary implements LibraryRepository {
  async getNode(): Promise<LibraryNode | null> {
    return null;
  }
  async listChildren(): Promise<LibraryNode[]> {
    return [];
  }
  async createNode() {}
  async updateNode() {}
  async deleteNode() {}
  async getUnit(): Promise<Unit | null> {
    return null;
  }
  async listUnits(): Promise<Unit[]> {
    return [];
  }
  async createUnit() {}
  async updateUnit() {}
  async getMediaFile(): Promise<MediaFile | null> {
    return null;
  }
  async createMediaFile() {}
}

function buildTestApp() {
  return buildApp({
    libraryRepository: new EmptyLibrary(),
    metadataProviders: {},
    auth: new AuthService(new InMemoryUsers(), new InMemorySessions()),
  });
}

const ADMIN = { username: "tessa", password: "hunter2hunter2" };

function sessionCookie(setCookie: string | string[] | number | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return header!.split(";")[0]!;
}

describe("auth routes", () => {
  it("reports that setup is needed on a fresh install", async () => {
    const response = await buildTestApp().inject({ method: "GET", url: "/api/auth/session" });
    expect(response.json()).toEqual({ needsSetup: true, user: null });
  });

  it("first-run setup creates the admin, sets an HttpOnly cookie, and can't be repeated", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "POST", url: "/api/auth/setup", payload: ADMIN });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: "tessa", isAdmin: true });
    const setCookie = String(response.headers["set-cookie"]);
    expect(setCookie).toMatch(/^tessatv_session=[^;]+;/);
    expect(setCookie.split("; ").slice(1).sort()).toEqual(["HttpOnly", `Max-Age=${400 * 24 * 60 * 60}`, "Path=/", "SameSite=Lax"]);

    const session = await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie: sessionCookie(response.headers["set-cookie"]) },
    });
    expect(session.json()).toMatchObject({ needsSetup: false, user: { username: "tessa" } });

    const again = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "mallory", password: "x".repeat(12) } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("setup_already_completed");
  });

  it("rejects malformed and weak setup input", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "tessa" } })).statusCode).toBe(400);
    const weak = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "tessa", password: "short" } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error).toBe("weak_password");
  });

  it("locks every other /api route behind a session, in any casing", async () => {
    const app = buildTestApp();
    for (const url of ["/api/library", "/API/Library", "/api/library/x/children", "/api/nonexistent"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it("leaves non-/api routes public", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
  });

  it("accepts the session cookie or a bearer token, and logout revokes it", async () => {
    const app = buildTestApp();
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: ADMIN });
    const cookie = sessionCookie(setup.headers["set-cookie"]);
    const { token } = setup.json() as { token: string };

    expect((await app.inject({ method: "GET", url: "/api/library", headers: { cookie } })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/library", headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers["set-cookie"])).toMatch(/^tessatv_session=;.*Expires=Thu, 01 Jan 1970/);
    expect((await app.inject({ method: "GET", url: "/api/library", headers: { cookie } })).statusCode).toBe(401);
  });

  it("logs in with the right password only", async () => {
    const app = buildTestApp();
    await app.inject({ method: "POST", url: "/api/auth/setup", payload: ADMIN });
    const bad = await app.inject({ method: "POST", url: "/api/auth/login", payload: { ...ADMIN, password: "wrong-wrong" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    const good = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "TESSA", password: ADMIN.password } });
    expect(good.statusCode).toBe(200);
    expect(String(good.headers["set-cookie"])).toMatch(/^tessatv_session=/);
  });
});
