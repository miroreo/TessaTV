import type { LibraryNode } from "./library-node.js";
import type { Unit } from "./unit.js";

/**
 * Wire shapes of TessaTV's own `/api`, shared by the server (which returns them) and the
 * web UI (which reads them), so the two can't drift apart.
 */

/** A user as it's safe to send to a client — no password hash. */
export interface PublicUser {
  readonly id: string;
  readonly username: string;
  readonly isAdmin: boolean;
}

/** What a value looks like after JSON.stringify: Dates become ISO strings. */
export type Jsonified<T> = T extends Date
  ? string
  : T extends readonly (infer Item)[]
    ? Jsonified<Item>[]
    : T extends object
      ? { [Key in keyof T]: Jsonified<T[Key]> }
      : T;

/** `GET /api/auth/session` */
export interface SessionResponse {
  readonly needsSetup: boolean;
  readonly user: PublicUser | null;
}

/** `POST /api/auth/setup` and `POST /api/auth/login` */
export interface LoginResponse {
  readonly user: PublicUser;
  readonly token: string;
}

/** Every `/api` error body. */
export interface ApiErrorResponse {
  readonly error: string;
  readonly message?: string;
}

/** `GET /api/library` and `GET /api/library/:id/children` */
export interface LibraryNodesResponse {
  readonly items: readonly LibraryNode[];
}

/** `GET /api/library/:id/units` */
export interface UnitsResponse {
  readonly items: readonly Unit[];
}
