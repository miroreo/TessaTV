import type { LibraryFolderSummary, LibraryScanStatus } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const [folders, scan] = await Promise.all([
    api<LibraryFolderSummary[]>(fetch, "/api/library/folders"),
    api<LibraryScanStatus>(fetch, "/api/library/scan"),
  ]);
  return { folders, scan };
};
