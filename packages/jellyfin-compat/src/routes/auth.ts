import type { AuthService, QuickConnectRequest } from "@tessatv/auth";
import { AuthError } from "@tessatv/auth";
import type { LoginResponse, PublicUser } from "@tessatv/domain";
import type { AuthenticationResult, QuickConnectResult, UserDto } from "@jellyfin/sdk/lib/generated-client/models/index.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readClientIdentity } from "../auth-header.js";
import { toJellyfinId } from "../ids.js";
import type { JellyfinServerInfo } from "../server-info.js";

/** Jellyfin deserializes JSON property names case-insensitively, and clients rely on it. */
function readBody(body: unknown): Map<string, unknown> {
  const fields = new Map<string, unknown>();
  if (body && typeof body === "object") {
    for (const [key, value] of Object.entries(body)) fields.set(key.toLowerCase(), value);
  }
  return fields;
}

function field(body: unknown, name: string): string | null {
  const value = readBody(body).get(name.toLowerCase());
  return typeof value === "string" ? value : null;
}

function clientLabel(request: FastifyRequest): string {
  const { client, device } = readClientIdentity(request.headers, request.query as Record<string, unknown>);
  return [client, device].filter(Boolean).join(" on ") || "Jellyfin client";
}

function userDto(user: PublicUser, server: JellyfinServerInfo): UserDto {
  return {
    Name: user.username,
    ServerId: server.id,
    Id: toJellyfinId(user.id),
    HasPassword: true,
    HasConfiguredPassword: true,
    HasConfiguredEasyPassword: false,
    EnableAutoLogin: false,
    Configuration: {
      PlayDefaultAudioTrack: true,
      SubtitleMode: "Default",
      DisplayMissingEpisodes: false,
      GroupedFolders: [],
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
    },
    Policy: {
      IsAdministrator: user.isAdmin,
      IsHidden: false,
      IsDisabled: false,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: true,
      EnableVideoPlaybackTranscoding: true,
      EnablePlaybackRemuxing: true,
      EnableRemoteAccess: true,
      EnableAllFolders: true,
      EnableAllChannels: true,
      EnableAllDevices: true,
      AuthenticationProviderId: "TessaTV",
      PasswordResetProviderId: "TessaTV",
    },
  };
}

function authenticationResult(login: LoginResponse, server: JellyfinServerInfo, request: FastifyRequest): AuthenticationResult {
  const identity = readClientIdentity(request.headers, request.query as Record<string, unknown>);
  return {
    User: userDto(login.user, server),
    SessionInfo: {
      UserId: toJellyfinId(login.user.id),
      UserName: login.user.username,
      Client: identity.client ?? "Unknown",
      DeviceId: identity.deviceId ?? "",
      DeviceName: identity.device ?? "",
      ApplicationVersion: identity.version ?? "",
      ServerId: server.id,
      IsActive: true,
    },
    AccessToken: login.token,
    ServerId: server.id,
  };
}

function quickConnectResult(request: QuickConnectRequest): QuickConnectResult {
  return {
    Authenticated: request.authorizedUserId !== null,
    Secret: request.secret,
    Code: request.code,
    DeviceId: request.client.deviceId,
    DeviceName: request.client.deviceName,
    AppName: request.client.appName,
    AppVersion: request.client.appVersion,
    DateAdded: request.createdAt.toISOString(),
  };
}

const unauthorized = (reply: FastifyReply) => reply.code(401).send();

/**
 * Jellyfin-style sign-in: password, Quick Connect (a device shows a code, someone signed in
 * approves it), and "who am I". Tokens are TessaTV's own session tokens — the same account
 * and session table as the web UI — handed out as Jellyfin's `AccessToken`.
 */
export function registerAuthRoutes(app: FastifyInstance, server: JellyfinServerInfo, auth: AuthService): void {
  /** Resolves the token a Jellyfin client presented, whichever way it sent it. */
  const authenticate = async (request: FastifyRequest) => {
    const { token } = readClientIdentity(request.headers, request.query as Record<string, unknown>);
    return token ? auth.authenticate(token) : null;
  };

  app.post("/Users/AuthenticateByName", async (request, reply) => {
    const username = field(request.body, "Username");
    const password = field(request.body, "Pw") ?? field(request.body, "Password");
    if (username === null || password === null) return reply.code(400).send();
    try {
      return authenticationResult(await auth.login(username, password, clientLabel(request)), server, request);
    } catch (error) {
      if (error instanceof AuthError) return unauthorized(reply);
      throw error;
    }
  });

  app.get("/Users/Me", async (request, reply) => {
    const authenticated = await authenticate(request);
    return authenticated ? userDto(authenticated.user, server) : unauthorized(reply);
  });

  // Quick Connect. Jellyfin has a server-side switch; TessaTV always has it on.
  app.get("/QuickConnect/Enabled", async () => true);

  app.post("/QuickConnect/Initiate", async (request) => {
    const identity = readClientIdentity(request.headers, request.query as Record<string, unknown>);
    return quickConnectResult(
      auth.initiateQuickConnect({
        appName: identity.client ?? "Unknown",
        appVersion: identity.version ?? "",
        deviceId: identity.deviceId ?? "",
        deviceName: identity.device ?? "",
      }),
    );
  });

  // The device's poll: `Authenticated` flips to true once someone approves the code.
  app.get("/QuickConnect/Connect", async (request, reply) => {
    const secret = (request.query as Record<string, unknown>)["secret"];
    const pending = typeof secret === "string" ? auth.quickConnectStatus(secret) : null;
    return pending ? quickConnectResult(pending) : reply.code(404).send({ error: "Unknown quick connect secret" });
  });

  // Approval, from a client already signed in as the person who owns the TV.
  app.post("/QuickConnect/Authorize", async (request, reply) => {
    const authenticated = await authenticate(request);
    if (!authenticated) return unauthorized(reply);
    const code = (request.query as Record<string, unknown>)["code"];
    if (typeof code !== "string") return reply.code(400).send();
    try {
      auth.authorizeQuickConnect(code, authenticated.user.id);
      return true;
    } catch (error) {
      if (error instanceof AuthError) return false;
      throw error;
    }
  });

  app.post("/Users/AuthenticateWithQuickConnect", async (request, reply) => {
    const secret = field(request.body, "Secret");
    if (secret === null) return reply.code(400).send();
    try {
      return authenticationResult(await auth.redeemQuickConnect(secret, clientLabel(request)), server, request);
    } catch (error) {
      if (error instanceof AuthError) return unauthorized(reply);
      throw error;
    }
  });
}
