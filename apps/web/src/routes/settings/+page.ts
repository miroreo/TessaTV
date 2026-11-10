import type { LibraryFolderSummary, LibraryScanStatus, ServerSettingsResponse, UserSummary } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const [folders, scan, settings, users] = await Promise.all([
    api<LibraryFolderSummary[]>(fetch, "/api/library/folders"),
    api<LibraryScanStatus>(fetch, "/api/library/scan"),
    api<ServerSettingsResponse>(fetch, "/api/settings"),
    api<UserSummary[]>(fetch, "/api/users"),
  ]);
  return { folders, scan, settings, users };
};
