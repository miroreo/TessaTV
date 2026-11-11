import { AuthService } from "@tessatv/auth";
import type { AuthSession, User, UserRepository } from "@tessatv/domain";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerJellyfinCompat } from "../jellyfin-compat.js";

function memoryUsers(): UserRepository {
  const users: User[] = [];
  return {
    countUsers: async () => users.length,
    getUser: async (id) => users.find((u) => u.id === id) ?? null,
    getUserByUsername: async (name) => users.find((u) => u.username.toLowerCase() === name.toLowerCase()) ?? null,
    getUserByOidcSubject: async () => null,
    listUsers: async () => [...users],
    createFirstUser: async (user) => (users.length > 0 ? false : (users.push(user), true)),
    createUser: async (user) => void users.push(user),
    updatePasswordHash: async () => {},
    updateOidcLogin: async () => {},
  } as UserRepository;
}

function setup() {
  const sessions = new Map<string, AuthSession>();
  const auth = new AuthService(memoryUsers(), {
    createSession: async (s) => void sessions.set(s.id, s),
    getSessionByTokenHash: async (hash) => [...sessions.values()].find((s) => s.tokenHash === hash) ?? null,
    touchSession: async () => {},
    deleteSession: async (id) => void sessions.delete(id),
  });
  const app = Fastify({ routerOptions: { caseSensitive: false } });
  registerJellyfinCompat(app, { serverId: "0123456789abcdef0123456789abcdef", serverName: "TessaTV", auth });
  return { app, auth };
}

const TV = 'MediaBrowser Client="Android TV", Device="Living room", DeviceId="tv-1", Version="0.18"';

describe("Jellyfin sign-in", () => {
  it("signs in by name and returns a token that identifies the user", async () => {
    const { app, auth } = setup();
    await auth.completeSetup("tessa", "hunter2hunter2");
    const login = await app.inject({
      method: "POST",
      url: "/Users/AuthenticateByName",
      headers: { authorization: TV },
      payload: { Username: "tessa", Pw: "hunter2hunter2" },
    });
    expect(login.statusCode).toBe(200);
    const result = login.json();
    expect(result.User.Name).toBe("tessa");
    expect(result.SessionInfo.DeviceName).toBe("Living room");

    const me = await app.inject({ method: "GET", url: "/Users/Me", headers: { "x-emby-token": result.AccessToken } });
    expect(me.json().Id).toBe(result.User.Id);
  });

  it("rejects bad passwords and missing tokens with 401", async () => {
    const { app, auth } = setup();
    await auth.completeSetup("tessa", "hunter2hunter2");
    const bad = await app.inject({ method: "POST", url: "/Users/AuthenticateByName", payload: { Username: "tessa", Pw: "nope" } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/Users/Me" })).statusCode).toBe(401);
  });

  it("completes the Quick Connect flow: TV shows a code, a signed-in session approves it", async () => {
    const { app, auth } = setup();
    const { token } = await auth.completeSetup("tessa", "hunter2hunter2");

    expect((await app.inject({ method: "GET", url: "/QuickConnect/Enabled" })).json()).toBe(true);
    const initiated = (await app.inject({ method: "POST", url: "/QuickConnect/Initiate", headers: { authorization: TV } })).json();
    expect(initiated).toMatchObject({ Authenticated: false, AppName: "Android TV", DeviceName: "Living room" });
    expect(initiated.Code).toMatch(/^\d{6}$/);

    const poll = () => app.inject({ method: "GET", url: `/QuickConnect/Connect?secret=${initiated.Secret}` });
    expect((await poll()).json().Authenticated).toBe(false);

    // Approving needs a session.
    const anonymous = await app.inject({ method: "POST", url: `/QuickConnect/Authorize?code=${initiated.Code}` });
    expect(anonymous.statusCode).toBe(401);
    const approved = await app.inject({
      method: "POST",
      url: `/QuickConnect/Authorize?code=${initiated.Code}`,
      headers: { "x-emby-token": token },
    });
    expect(approved.json()).toBe(true);
    expect((await poll()).json().Authenticated).toBe(true);

    const redeem = () =>
      app.inject({ method: "POST", url: "/Users/AuthenticateWithQuickConnect", headers: { authorization: TV }, payload: { Secret: initiated.Secret } });
    const signedIn = await redeem();
    expect(signedIn.statusCode).toBe(200);
    expect(signedIn.json().User.Name).toBe("tessa");
    expect((await redeem()).statusCode).toBe(401);
  });

  it("answers an unknown code with false and an unknown secret with 404", async () => {
    const { app, auth } = setup();
    const { token } = await auth.completeSetup("tessa", "hunter2hunter2");
    const wrong = await app.inject({ method: "POST", url: "/QuickConnect/Authorize?code=000000", headers: { "x-emby-token": token } });
    expect(wrong.json()).toBe(false);
    expect((await app.inject({ method: "GET", url: "/QuickConnect/Connect?secret=nope" })).statusCode).toBe(404);
  });
});
