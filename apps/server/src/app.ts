import type { LibraryRepository } from "@tessatv/domain";
import { type JellyfinCompatOptions, registerJellyfinCompat } from "@tessatv/jellyfin-compat";
import type { MetadataProvidersByKind } from "@tessatv/library";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLibraryImportRoutes } from "./routes/library-import.js";
import { registerLibraryMergeRoutes } from "./routes/library-merge.js";
import { registerLibraryMetadataRoutes } from "./routes/library-metadata.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { type NodeRequestHandler, registerWebUiRoutes } from "./routes/web-ui.js";

export interface AppDependencies {
  libraryRepository: LibraryRepository;
  /** Default provider per media kind — e.g. `{ movie: tmdb, series: tvdb }`. A kind with
   * no entry means that kind's metadata routes return 503 until it's configured. */
  metadataProviders: MetadataProvidersByKind;
  /** Mounts the Jellyfin-compatible API at the root. Omitted only in tests that don't need it. */
  jellyfin?: JellyfinCompatOptions;
  /** SvelteKit's built handler, served at the root for any path no explicit route claims. Omitted when the web app isn't built. */
  webUiHandler?: NodeRequestHandler;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  // Case-insensitive routing is required by Jellyfin clients (see registerJellyfinCompat);
  // it applies router-wide, so TessaTV's own /api routes match case-insensitively too.
  const app = Fastify({ logger: true, routerOptions: { caseSensitive: false } });

  app.get("/health", async () => ({ status: "ok" }));

  registerLibraryRoutes(app, deps.libraryRepository);
  registerLibraryImportRoutes(app, deps.libraryRepository, deps.metadataProviders);
  registerLibraryMetadataRoutes(app, deps.libraryRepository, deps.metadataProviders);
  registerLibraryMergeRoutes(app, deps.libraryRepository, deps.metadataProviders);

  if (deps.jellyfin) registerJellyfinCompat(app, deps.jellyfin);
  if (deps.webUiHandler) registerWebUiRoutes(app, deps.webUiHandler);

  return app;
}
