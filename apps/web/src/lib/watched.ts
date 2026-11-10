import { api } from "./api.js";

/** Marks episodes or movies watched or unwatched, in viewing order. */
export function setWatched(unitIds: readonly string[], watched: boolean): Promise<void> {
  return api<void>(fetch, "/api/progress/watched", { method: "POST", body: JSON.stringify({ unitIds, watched }) });
}

/** Discards a saved position, so the next play starts from the beginning. */
export function forgetPosition(unitId: string): Promise<void> {
  return api<void>(fetch, `/api/progress/${unitId}/position`, { method: "DELETE" });
}
