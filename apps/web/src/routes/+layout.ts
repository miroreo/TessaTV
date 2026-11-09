import { redirect } from "@sveltejs/kit";
import type { SessionResponse } from "@tessatv/domain";
import type { LayoutLoad } from "./$types.js";

const SETUP_PATH = "/setup";
const LOGIN_PATH = "/login";

/**
 * Routes every page through the session state: first-run setup until an account exists,
 * then login until there's a session. The server enforces this on `/api` regardless —
 * this just sends people to the right page instead of a wall of 401s.
 */
export const load: LayoutLoad = async ({ fetch, url }) => {
  const session = (await (await fetch("/api/auth/session")).json()) as SessionResponse;
  const path = url.pathname;
  if (session.needsSetup) {
    if (path !== SETUP_PATH) redirect(307, SETUP_PATH);
  } else if (!session.user) {
    if (path !== LOGIN_PATH) redirect(307, LOGIN_PATH);
  } else if (path === SETUP_PATH || path === LOGIN_PATH) {
    redirect(307, "/");
  }
  return { session };
};
