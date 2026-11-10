import type { LibraryRepository } from "@tessatv/domain";
import { confirmSeriesMerge, InvalidSeriesMergeError, mergeDuplicateSeries, type MetadataProvidersByKind } from "@tessatv/library";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

const confirmBody = z.object({ primaryNodeId: z.string().min(1), duplicateNodeId: z.string().min(1) });

export function registerLibraryMergeRoutes(
  server: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProviders: MetadataProvidersByKind,
): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  app.post("/api/library/merge-duplicates", async () => {
    return mergeDuplicateSeries(libraryRepository, metadataProviders.series);
  });

  app.post(
    "/api/library/merge-duplicates/confirm",
    { schema: { body: confirmBody } },
    async (request, reply) => {
      const { primaryNodeId, duplicateNodeId } = request.body;
      const [primary, duplicate] = await Promise.all([
        libraryRepository.getNode(primaryNodeId),
        libraryRepository.getNode(duplicateNodeId),
      ]);
      if (!primary || !duplicate) {
        reply.code(404);
        return { error: "not_found" };
      }

      try {
        await confirmSeriesMerge(libraryRepository, primaryNodeId, duplicateNodeId);
      } catch (error) {
        if (!(error instanceof InvalidSeriesMergeError)) throw error;
        reply.code(400);
        return { error: "invalid_merge", message: error.message };
      }
      return { merged: { primaryNodeId, duplicateNodeId } };
    },
  );
}
