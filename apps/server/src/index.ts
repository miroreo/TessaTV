import { AuthService } from "@tessatv/auth";
import { loadConfig } from "@tessatv/config";
import { type MetadataProvidersByKind, refreshLibraryMetadata } from "@tessatv/library";
import { deriveServerId } from "@tessatv/jellyfin-compat";
import { JobScheduler } from "@tessatv/jobs";
import { CachedMetadataProvider, TmdbClient, TmdbMetadataProvider, TvdbClient, TvdbMetadataProvider } from "@tessatv/metadata";
import {
  createDatabase,
  DrizzleAuthSessionRepository,
  DrizzleLibraryRepository,
  DrizzleMetadataCacheRepository,
  DrizzleUserRepository,
  DrizzleLoudnessRepository,
  DrizzleWatchProgressRepository,
  runMigrations,
} from "@tessatv/persistence";
import { measureMissingLoudness, selectHardwareAccel, TranscodeManager } from "@tessatv/streaming";
import { buildApp } from "./app.js";
import { loadWebUiHandler } from "./routes/web-ui.js";

// Daily, matching CachedMetadataProvider's default TTL.
const METADATA_REFRESH_CRON = "0 4 * * *";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
await runMigrations(db);
const libraryRepository = new DrizzleLibraryRepository(db);
const metadataCacheRepository = new DrizzleMetadataCacheRepository(db);
const loudnessRepository = new DrizzleLoudnessRepository(db);
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
  onFallback: (error, plan) =>
    app.log.warn({ error: error.message, path: plan.path }, `${hardwareAccel.kind} transcode failed; retrying on the CPU`),
});

const webUiHandler = await loadWebUiHandler();

const app = buildApp({
  auth,
  libraryRepository,
  metadataProviders,
  playback: {
    progressRepository: new DrizzleWatchProgressRepository(db),
    metadataCache: metadataCacheRepository,
    transcodes,
    loudnessRepository,
  },
  jellyfin: { serverId: deriveServerId(config.APP_SECRET), serverName: "TessaTV" },
  ...(webUiHandler ? { webUiHandler } : {}),
});

const jobs = new JobScheduler(config.DATABASE_URL, {
  onError: (error) => app.log.error(error, "job scheduler error"),
});
// Every 15 minutes, measure loudness for files that haven't been yet (newest first), for
// playback's volume normalization. Each run stops starting new files after 10 minutes so it
// finishes inside pg-boss's default 15-minute job expiry; a full library catches up over
// several runs, then only new imports need measuring.
jobs.register({
  name: "loudness-scan",
  cron: "*/15 * * * *",
  handler: async () => {
    const summary = await measureMissingLoudness({ repository: loudnessRepository, budgetMs: 10 * 60 * 1000 });
    if (summary.measured || summary.failed) app.log.info(summary, "loudness-scan measured files");
  },
});

jobs.register({
  name: "metadata-refresh",
  cron: METADATA_REFRESH_CRON,
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
    await jobs.start();
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    // Leaves no ffmpeg behind writing into a directory nothing will clean up until next boot.
    void Promise.allSettled([transcodes.shutdown(), jobs.stop()]).finally(() => process.exit(0));
  });
}
