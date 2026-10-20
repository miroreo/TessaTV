import type { LibraryRepository } from "@tessatv/domain";
import type { MetadataProvidersByKind } from "@tessatv/library";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLibraryImportRoutes } from "./routes/library-import.js";
import { registerLibraryMetadataRoutes } from "./routes/library-metadata.js";
import { registerLibraryRoutes } from "./routes/library.js";

export interface AppDependencies {
  libraryRepository: LibraryRepository;
  /** Default provider per media kind — e.g. `{ movie: tmdb, series: tvdb }`. A kind with
   * no entry means that kind's metadata routes return 503 until it's configured. */
  metadataProviders: MetadataProvidersByKind;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  registerLibraryRoutes(app, deps.libraryRepository);
  registerLibraryImportRoutes(app, deps.libraryRepository);
  registerLibraryMetadataRoutes(app, deps.libraryRepository, deps.metadataProviders);

  return app;
}
