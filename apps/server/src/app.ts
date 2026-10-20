import type { LibraryRepository } from "@tessatv/domain";
import type { MetadataProvider } from "@tessatv/metadata";
import Fastify, { type FastifyInstance } from "fastify";
import { registerLibraryImportRoutes } from "./routes/library-import.js";
import { registerLibraryMetadataRoutes } from "./routes/library-metadata.js";
import { registerLibraryRoutes } from "./routes/library.js";

export interface AppDependencies {
  libraryRepository: LibraryRepository;
  metadataProvider: MetadataProvider | null;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ status: "ok" }));

  registerLibraryRoutes(app, deps.libraryRepository);
  registerLibraryImportRoutes(app, deps.libraryRepository);
  registerLibraryMetadataRoutes(app, deps.libraryRepository, deps.metadataProvider);

  return app;
}
