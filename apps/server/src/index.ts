import { AuthService } from "@tessatv/auth";
import { loadConfig } from "@tessatv/config";
import { type MetadataProvidersByKind, refreshLibraryMetadata } from "@tessatv/library";
import { deriveServerId } from "@tessatv/jellyfin-compat";
import { JobRunner } from "@tessatv/jobs";
import { CachedMetadataProvider, TmdbClient, TmdbMetadataProvider, TvdbClient, TvdbMetadataProvider } from "@tessatv/metadata";
import {
  createDatabase,
  DrizzleAuthSessionRepository,
  DrizzleJobRepository,
  DrizzleLibraryRepository,
  DrizzleMetadataCacheRepository,
  DrizzleUserRepository,
} from "@tessatv/persistence";
import { selectHardwareAccel, TranscodeManager } from "@tessatv/streaming";
import { buildApp } from "./app.js";
import { loadWebUiHandler } from "./routes/web-ui.js";

const METADATA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // matches CachedMetadataProvider's default TTL

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const libraryRepository = new DrizzleLibraryRepository(db);
const metadataCacheRepository = new DrizzleMetadataCacheRepository(db);
const auth = new AuthService(new DrizzleUserRepository(db), new DrizzleAuthSessionRepository(db));

const tmdbProvider = config.TMDB_API_KEY
  ? new CachedMetadataProvider(new TmdbMetadataProvider(new TmdbClient({ apiKey: config.TMDB_API_KEY })), metadataCacheRepository)
  : null;

const tvdbProvider = config.TVDB_API_KEY
  ? new CachedMetadataProvider(new TvdbMetadataProvider(new TvdbClient({ apiKey: config.TVDB_API_KEY })), metadataCacheRepository)
  : null;

// Default split: movies -> TMDB, TV -> TheTVDB (chosen for TheTVDB's more reliable season/
// episode numbering). An explicit `?provider=`/`{provider}` on the metadata routes can
// still request the other one directly.
const metadataProviders: MetadataProvidersByKind = {
  ...(tmdbProvider ? { movie: tmdbProvider } : {}),
  ...(tvdbProvider ? { series: tvdbProvider } : {}),
};

// Resolved up front so a misconfigured explicit `vaapi` stops startup, not the first playback.
const hardwareAccel = await selectHardwareAccel(config.HARDWARE_ACCEL, {
  ...(config.VAAPI_DEVICE ? { vaapiDevice: config.VAAPI_DEVICE } : {}),
});
const transcodes = new TranscodeManager({
  directory: config.TRANSCODE_DIR,
  accel: hardwareAccel,
  maxConcurrent: config.MAX_CONCURRENT_TRANSCODES,
});

const webUiHandler = await loadWebUiHandler();

const app = buildApp({
  auth,
  libraryRepository,
  metadataProviders,
  jellyfin: { serverId: deriveServerId(config.APP_SECRET), serverName: "TessaTV" },
  ...(webUiHandler ? { webUiHandler } : {}),
});

const jobRunner = new JobRunner(new DrizzleJobRepository(db));
jobRunner.register({
  name: "metadata-refresh",
  intervalMs: METADATA_REFRESH_INTERVAL_MS,
  handler: async () => {
    const summary = await refreshLibraryMetadata(libraryRepository, metadataProviders);
    if (summary.errors.length > 0) {
      app.log.warn({ errors: summary.errors }, "metadata-refresh job completed with errors");
    }
  },
});

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then(async () => {
    app.log.info(`TessaTV server listening on port ${config.PORT}`);
    if (!webUiHandler) app.log.warn("Web UI build not found — run `pnpm --filter @tessatv/web build`; the UI will 404 until then");
    if (!tmdbProvider) app.log.warn("TMDB_API_KEY not set — movie metadata routes will return 503 until it is configured");
    if (!tvdbProvider) app.log.warn("TVDB_API_KEY not set — series metadata routes will return 503 until it is configured");
    app.log.info(`Transcoding with hardware accel: ${hardwareAccel.kind}`);
    await transcodes.start();
    await jobRunner.start();
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Leaves no ffmpeg behind writing into a directory nothing will clean up until next boot.
    void transcodes.shutdown().finally(() => process.exit(0));
  });
}
