import { loadConfig } from "@tessatv/config";
import { CachedMetadataProvider, TmdbClient, TmdbMetadataProvider } from "@tessatv/metadata";
import { createDatabase, DrizzleLibraryRepository, DrizzleMetadataCacheRepository } from "@tessatv/persistence";
import { buildApp } from "./app.js";

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const libraryRepository = new DrizzleLibraryRepository(db);

const metadataProvider = config.TMDB_API_KEY
  ? new CachedMetadataProvider(
      new TmdbMetadataProvider(new TmdbClient({ apiKey: config.TMDB_API_KEY })),
      new DrizzleMetadataCacheRepository(db),
    )
  : null;

const app = buildApp({ libraryRepository, metadataProvider });

app
  .listen({ port: config.PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`TessaTV server listening on port ${config.PORT}`);
    if (!metadataProvider) {
      app.log.warn("TMDB_API_KEY not set — metadata routes will return 503 until it is configured");
    }
  })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
