import type { LibraryRepository } from "@tessatv/domain";
import { importFolders, type MetadataProvidersByKind } from "@tessatv/library";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const importBody = z
  .object({ moviesPath: z.string().min(1).optional(), showsPath: z.string().min(1).optional() })
  .refine((body) => body.moviesPath || body.showsPath, "provide at least one of moviesPath or showsPath");

export function registerLibraryImportRoutes(
  server: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProviders: MetadataProvidersByKind,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post("/api/library/import", { schema: { body: importBody } }, async (request) => {
    const { moviesPath, showsPath } = request.body;
    const result = await importFolders(libraryRepository, metadataProviders, {
      moviesPaths: moviesPath ? [moviesPath] : [],
      showsPaths: showsPath ? [showsPath] : [],
    });
    return result;
  });
}
