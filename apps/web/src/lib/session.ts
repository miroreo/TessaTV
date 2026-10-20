export interface SessionUser {
  id: string;
  username: string;
  isAdmin: boolean;
}

export interface SessionState {
  needsSetup: boolean;
  user: SessionUser | null;
}

/** POSTs credentials to an auth endpoint; returns an error message, or null on success. */
export async function submitCredentials(
  url: "/api/auth/setup" | "/api/auth/login",
  username: string,
  password: string,
): Promise<string | null> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (response.ok) return null;
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `Request failed (${response.status})`;
}
