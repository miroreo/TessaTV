import type { LibraryFolderSummary, LibraryScanStatus, ServerSettings } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const [folders, scan, settings] = await Promise.all([
    api<LibraryFolderSummary[]>(fetch, "/api/library/folders"),
    api<LibraryScanStatus>(fetch, "/api/library/scan"),
    api<ServerSettings>(fetch, "/api/settings"),
  ]);
  return { folders, scan, settings };
};
