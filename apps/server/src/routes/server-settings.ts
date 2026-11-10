import type { OidcClient, SecretBox } from "@tessatv/auth";
import {
  MAX_STREAM_HEIGHTS,
  type OidcSettings,
  type ServerSettings,
  type ServerSettingsRepository,
  type ServerSettingsResponse,
  type UserRepository,
  type UserSummary,
} from "@tessatv/domain";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { requireAdmin } from "../require-admin.js";
import { redirectUri } from "../sso.js";

export interface ServerSettingsDependencies {
  readonly settings: ServerSettingsRepository;
  readonly users?: UserRepository;
  /** Needed to save single sign-on settings. */
  readonly sso?: { readonly client: OidcClient; readonly clientSecrets: SecretBox };
}

const maxStreamHeight = z.union([z.null(), ...MAX_STREAM_HEIGHTS.map((height) => z.literal(height))] as const);
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), "Must be an http(s) address");
const groupName = z
  .string()
  .trim()
  .transform((value) => value || null)
  .nullable();

const oidcInput = z.object({
  enabled: z.boolean(),
  publicUrl: httpUrl,
  issuerUrl: httpUrl,
  clientId: z.string().trim().min(1),
  clientSecret: z.string().min(1).optional(),
  adminGroup: groupName,
  requiredGroup: groupName,
  buttonLabel: z.string().trim().min(1).max(60),
});

/** Never sends a secret back, sealed or not: only whether one is set. */
function publicView(settings: ServerSettings): ServerSettingsResponse {
  const { oidc } = settings;
  return {
    maxStreamHeight: settings.maxStreamHeight,
    oidc: oidc
      ? {
          enabled: oidc.enabled,
          publicUrl: oidc.publicUrl,
          issuerUrl: oidc.issuerUrl,
          clientId: oidc.clientId,
          hasClientSecret: oidc.clientSecretSealed !== "",
          adminGroup: oidc.adminGroup,
          requiredGroup: oidc.requiredGroup,
          buttonLabel: oidc.buttonLabel,
        }
      : null,
  };
}

/** Server-wide settings and accounts: admin-only, like everything else on the settings page. */
export function registerServerSettingsRoutes(server: FastifyInstance, deps: ServerSettingsDependencies): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const admin = { preHandler: requireAdmin };
  const { settings } = deps;

  app.get("/api/settings", admin, async (): Promise<ServerSettingsResponse> => publicView(await settings.get()));

  app.patch(
    "/api/settings",
    {
      ...admin,
      schema: { body: z.object({ maxStreamHeight: maxStreamHeight.optional(), oidc: oidcInput.optional() }).strict() },
    },
    async (request, reply) => {
      const { maxStreamHeight: height, oidc: input } = request.body;
      const changes: { -readonly [K in keyof ServerSettings]?: ServerSettings[K] } = {};
      if (height !== undefined) changes.maxStreamHeight = height;
      if (input) {
        if (!deps.sso) return reply.code(503).send({ error: "sso_unavailable", message: "Single sign-on isn't available on this server" });
        const saved = (await settings.get()).oidc;
        const clientSecretSealed = input.clientSecret ? deps.sso.clientSecrets.seal(input.clientSecret) : (saved?.clientSecretSealed ?? "");
        const clientSecret = deps.sso.clientSecrets.open(clientSecretSealed);
        if (clientSecret === null) {
          return reply.code(400).send({ error: "missing_client_secret", message: "Enter the client secret from your provider" });
        }
        const oidc: OidcSettings = {
          enabled: input.enabled,
          publicUrl: input.publicUrl.replace(/\/+$/, ""),
          issuerUrl: input.issuerUrl,
          clientId: input.clientId,
          clientSecretSealed,
          adminGroup: input.adminGroup,
          requiredGroup: input.requiredGroup,
          buttonLabel: input.buttonLabel,
        };
        // Turning it on with an issuer that doesn't answer would only show up as failed sign-ins.
        if (oidc.enabled) {
          try {
            await deps.sso.client.check({ issuerUrl: oidc.issuerUrl, clientId: oidc.clientId, clientSecret, redirectUri: redirectUri(oidc.publicUrl) });
          } catch (error) {
            return reply.code(422).send({
              error: "issuer_unreachable",
              message: `Couldn't load the provider's OpenID configuration from ${oidc.issuerUrl}: ${(error as Error).message}`,
            });
          }
        }
        changes.oidc = oidc;
      }
      return publicView(await settings.update(changes));
    },
  );

  if (deps.users) {
    const users = deps.users;
    app.get("/api/users", admin, async (): Promise<UserSummary[]> =>
      (await users.listUsers()).map((user) => ({
        id: user.id,
        username: user.username,
        isAdmin: user.isAdmin,
        hasPassword: user.passwordHash !== null,
        usesSso: user.oidcSubject !== null,
        createdAt: user.createdAt.toISOString(),
      })),
    );
  }
}
