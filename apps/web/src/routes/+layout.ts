import { redirect } from "@sveltejs/kit";
import type { SessionResponse } from "@tessatv/domain";
import type { LayoutLoad } from "./$types.js";

const SETUP_PATH = "/setup";
const LOGIN_PATH = "/login";
const LINK_PATH = "/link";

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
    if (path !== LOGIN_PATH) {
      // Someone who opened the code page from a TV's prompt comes back to it after signing in.
      const next = path === LINK_PATH ? `?next=${encodeURIComponent(path + url.search)}` : "";
      redirect(307, LOGIN_PATH + next);
    }
  } else if (path === SETUP_PATH || path === LOGIN_PATH) {
    redirect(307, "/");
  }
  return { session };
};
