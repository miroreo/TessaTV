import type { SecretBox } from "@tessatv/auth";
import type {
  JellyfinImportResponse,
  LibraryRepository,
  ServerSettingsRepository,
  UserRepository,
  WatchProgressRepository,
} from "@tessatv/domain";
import { importWatchHistory, type JellyfinHistorySource } from "@tessatv/jellyfin-import";
import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../require-admin.js";

export interface JellyfinImportDependencies {
  readonly settings: ServerSettingsRepository;
  readonly library: LibraryRepository;
  readonly users: UserRepository;
  readonly progress: WatchProgressRepository;
  readonly apiKeys: SecretBox;
  readonly sourceFor: (url: string, apiKey: string) => JellyfinHistorySource;
}

/** Pulls watch history from the Jellyfin server saved in settings, onto TessaTV accounts with the same usernames. */
export function registerJellyfinImportRoutes(app: FastifyInstance, deps: JellyfinImportDependencies): void {
  let running = false;
  app.post("/api/jellyfin/import", { preHandler: requireAdmin }, async (_request, reply): Promise<JellyfinImportResponse | undefined> => {
    const saved = (await deps.settings.get()).jellyfin;
    const apiKey = saved ? deps.apiKeys.open(saved.apiKeySealed) : null;
    if (!saved || apiKey === null) {
      await reply.code(409).send({ error: "jellyfin_not_configured", message: "Save the Jellyfin address and API key first" });
      return undefined;
    }
    if (running) {
      await reply.code(409).send({ error: "import_running", message: "An import is already running" });
      return undefined;
    }
    running = true;
    try {
      return await importWatchHistory({
        source: deps.sourceFor(saved.url, apiKey),
        library: deps.library,
        users: deps.users,
        progress: deps.progress,
      });
    } catch (error) {
      await reply.code(502).send({ error: "jellyfin_import_failed", message: (error as Error).message });
      return undefined;
    } finally {
      running = false;
    }
  });
}
