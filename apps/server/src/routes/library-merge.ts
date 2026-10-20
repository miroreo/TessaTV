import type { LibraryRepository } from "@tessatv/domain";
import { confirmSeriesMerge, mergeDuplicateSeries, type MetadataProvidersByKind } from "@tessatv/library";
import type { FastifyInstance } from "fastify";

export function registerLibraryMergeRoutes(
  app: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProviders: MetadataProvidersByKind,
): void {
  app.post("/api/library/merge-duplicates", async () => {
    return mergeDuplicateSeries(libraryRepository, metadataProviders.series);
  });

  app.post<{ Body: { primaryNodeId: string; duplicateNodeId: string } }>(
    "/api/library/merge-duplicates/confirm",
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

      await confirmSeriesMerge(libraryRepository, primaryNodeId, duplicateNodeId);
      return { merged: { primaryNodeId, duplicateNodeId } };
    },
  );
}
