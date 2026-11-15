import type { FileHealthStatusResponse, HardwareAccelStatusResponse, LibraryFolderSummary, LibraryScanStatus, ServerSettingsResponse, UserSummary } from "@tessatv/domain";
import { api } from "$lib/api.js";
import type { PageLoad } from "./$types.js";

export const load: PageLoad = async ({ fetch }) => {
  const [folders, scan, settings, users, fileHealth, hardware] = await Promise.all([
    api<LibraryFolderSummary[]>(fetch, "/api/library/folders"),
    api<LibraryScanStatus>(fetch, "/api/library/scan"),
    api<ServerSettingsResponse>(fetch, "/api/settings"),
    api<UserSummary[]>(fetch, "/api/users"),
    api<FileHealthStatusResponse>(fetch, "/api/file-health"),
    api<HardwareAccelStatusResponse>(fetch, "/api/hardware-accel"),
  ]);
  return { folders, scan, settings, users, fileHealth, hardware };
};
