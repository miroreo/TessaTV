import type { OidcClient, OidcClientConfig, SecretBox } from "@tessatv/auth";
import type { OidcSettings, PublicUser, ServerSettingsRepository } from "@tessatv/domain";

export interface SsoDependencies {
  readonly settings: ServerSettingsRepository;
  readonly client: OidcClient;
  /** Seals the client secret saved in settings. */
  readonly clientSecrets: SecretBox;
  /** Seals the cookie that carries a sign-in's state while the person is at the provider. */
  readonly pendingSignIns: SecretBox;
  /** Runs after SSO creates an account, e.g. to hand it watch history imported for that username. */
  readonly onAccountCreated?: (user: PublicUser) => Promise<void>;
}

export const OIDC_CALLBACK_PATH = "/api/auth/oidc/callback";

export function redirectUri(publicUrl: string): string {
  return new URL(OIDC_CALLBACK_PATH, publicUrl).href;
}

/** The provider config to sign in with, or null when SSO is off or its secret can't be opened. */
export function oidcClientConfig(oidc: OidcSettings | null, clientSecrets: SecretBox): OidcClientConfig | null {
  if (!oidc?.enabled) return null;
  const clientSecret = clientSecrets.open(oidc.clientSecretSealed);
  if (clientSecret === null) return null;
  return { issuerUrl: oidc.issuerUrl, clientId: oidc.clientId, clientSecret, redirectUri: redirectUri(oidc.publicUrl) };
}
