import * as client from "openid-client";
import type { OidcIdentity } from "./auth-service.js";

export interface OidcClientConfig {
  readonly issuerUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where the provider sends people back: TessaTV's `/api/auth/oidc/callback`. */
  readonly redirectUri: string;
}

/** What a sign-in has to remember between leaving for the provider and coming back. */
export interface PendingOidcSignIn {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

const DISCOVERY_TIMEOUT_SECONDS = 10;

/**
 * OpenID Connect sign-in through `openid-client`: authorization code flow with PKCE, state
 * and nonce. The provider's discovery document is fetched once per configuration.
 */
export class OidcClient {
  private cached: { key: string; configuration: Promise<client.Configuration> } | null = null;

  private configuration(config: OidcClientConfig): Promise<client.Configuration> {
    const key = JSON.stringify([config.issuerUrl, config.clientId, config.clientSecret]);
    if (this.cached?.key !== key) {
      const configuration = discover(new URL(config.issuerUrl), config);
      this.cached = { key, configuration };
      // A failed discovery (provider down, typo) shouldn't stick: the next sign-in retries.
      configuration.catch(() => {
        if (this.cached?.configuration === configuration) this.cached = null;
      });
    }
    return this.cached.configuration;
  }

  /**
   * Checks the issuer is reachable and is an OpenID provider, e.g. when an admin saves
   * settings. Returns the issuer as the provider itself states it, which is what to store.
   */
  async check(config: OidcClientConfig): Promise<{ issuer: string }> {
    return { issuer: (await this.configuration(config)).serverMetadata().issuer };
  }

  async start(config: OidcClientConfig): Promise<{ url: URL; pending: PendingOidcSignIn }> {
    const configuration = await this.configuration(config);
    const pending: PendingOidcSignIn = {
      state: client.randomState(),
      nonce: client.randomNonce(),
      codeVerifier: client.randomPKCECodeVerifier(),
    };
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: config.redirectUri,
      scope: "openid profile email",
      code_challenge: await client.calculatePKCECodeChallenge(pending.codeVerifier),
      code_challenge_method: "S256",
      state: pending.state,
      nonce: pending.nonce,
    });
    return { url, pending };
  }

  /** Exchanges the code the provider sent back to `callbackUrl` and says who signed in. */
  async finish(config: OidcClientConfig, callbackUrl: URL, pending: PendingOidcSignIn): Promise<OidcIdentity> {
    const configuration = await this.configuration(config);
    const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    let claims: Record<string, unknown> = { ...tokens.claims() };
    // Authentik puts groups in the ID token by default; other providers only in userinfo.
    if (!Array.isArray(claims.groups) || typeof claims.preferred_username !== "string") {
      claims = { ...(await client.fetchUserInfo(configuration, tokens.access_token, String(claims.sub))), ...claims };
    }
    return identityFromClaims(claims);
  }
}

/**
 * Discovery requires the issuer to match the provider's own statement exactly, and the
 * only way people get it wrong is the trailing slash (Authentik's issuers end in one, most
 * others' don't), so that's retried the other way round before giving up.
 */
async function discover(issuer: URL, config: OidcClientConfig): Promise<client.Configuration> {
  const attempt = (url: URL) =>
    client.discovery(url, config.clientId, config.clientSecret, undefined, {
      timeout: DISCOVERY_TIMEOUT_SECONDS,
      // A homelab provider on plain HTTP (LAN or Tailscale) is the admin's call to make.
      ...(url.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
    });
  try {
    return await attempt(issuer);
  } catch (error) {
    if (!/issuer/i.test((error as Error).message)) throw error;
    const toggled = new URL(issuer);
    toggled.pathname = toggled.pathname.endsWith("/") ? toggled.pathname.slice(0, -1) || "/" : `${toggled.pathname}/`;
    if (toggled.href === issuer.href) throw error;
    return attempt(toggled);
  }
}

export function identityFromClaims(claims: Record<string, unknown>): OidcIdentity {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const subject = text(claims.sub);
  if (!subject) throw new Error("The provider's ID token has no subject");
  const groups = Array.isArray(claims.groups) ? claims.groups.filter((group): group is string => typeof group === "string") : [];
  return { subject, username: text(claims.preferred_username) ?? text(claims.email) ?? subject, groups };
}
