import {
  FILE_HEALTH_RECHECK_DAYS,
  type FileHealthRepository,
  type FileHealthStatusResponse,
  type ServerSettingsRepository,
} from "@tessatv/domain";
import type { FileHealthMonitorStatus } from "@tessatv/streaming";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../require-admin.js";

export interface FileHealthDependencies {
  readonly repository: FileHealthRepository;
  readonly settings: ServerSettingsRepository;
  readonly status: () => FileHealthMonitorStatus;
}

const DAMAGED_FILES_SHOWN = 100;

/** Progress and findings of the background decode check, for the settings page. Admin-only. */
export function registerFileHealthRoutes(app: FastifyInstance, deps: FileHealthDependencies): void {
  app.get("/api/file-health", { preHandler: requireAdmin }, async (): Promise<FileHealthStatusResponse> => {
    const staleBefore = new Date(Date.now() - FILE_HEALTH_RECHECK_DAYS * 24 * 60 * 60 * 1000);
    const [enabled, summary, damaged] = await Promise.all([
      deps.settings.get().then((settings) => settings.fileHealthCheck),
      deps.repository.summary(staleBefore),
      deps.repository.listDamaged(DAMAGED_FILES_SHOWN),
    ]);
    const { state, current } = deps.status();
    return {
      enabled,
      // The monitor notices a change to the setting within seconds; don't show stale activity meanwhile.
      state: enabled ? state : "disabled",
      current: enabled && current ? { path: current.path, startedAt: current.startedAt.toISOString() } : null,
      ...summary,
      damagedFiles: damaged.map(({ path, error, checkedAt }) => ({ path, error, checkedAt: checkedAt.toISOString() })),
    };
  });
}
