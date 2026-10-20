import type { LibraryRepository, MediaTypeId } from "@tessatv/domain";
import { autoIdentifyLibrary } from "@tessatv/library";
import { type MetadataMediaKind, type MetadataProvider, toMetadataMediaKind } from "@tessatv/metadata";
import type { FastifyInstance } from "fastify";

/**
 * `toMetadataMediaKind` alone isn't enough here: "series" is also used for season
 * collection nodes, which aren't independently identifiable against a metadata provider —
 * only root-level nodes (movies, and top-level series) are.
 */
function toIdentifiableMediaKind(
  mediaType: MediaTypeId,
  parentId: string | null,
): MetadataMediaKind | null {
  if (parentId !== null) return null;
  return toMetadataMediaKind(mediaType);
}

export function registerLibraryMetadataRoutes(
  app: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProvider: MetadataProvider | null,
): void {
  app.get<{ Params: { id: string }; Querystring: { year?: string } }>(
    "/api/library/:id/metadata/candidates",
    async (request, reply) => {
      if (!metadataProvider) {
        reply.code(503);
        return { error: "metadata_disabled", message: "Set TMDB_API_KEY to enable metadata identification" };
      }

      const node = await libraryRepository.getNode(request.params.id);
      if (!node) {
        reply.code(404);
        return { error: "not_found" };
      }
      const mediaKind = toIdentifiableMediaKind(node.mediaType, node.parentId);
      if (!mediaKind) {
        reply.code(400);
        return { error: "unsupported_media_type", mediaType: node.mediaType };
      }

      const year = request.query.year ? Number(request.query.year) : null;
      const candidates = await metadataProvider.search({ title: node.title, year, mediaKind });
      return { items: candidates };
    },
  );

  app.post<{ Params: { id: string }; Body: { externalId: string } }>(
    "/api/library/:id/metadata/identify",
    async (request, reply) => {
      if (!metadataProvider) {
        reply.code(503);
        return { error: "metadata_disabled", message: "Set TMDB_API_KEY to enable metadata identification" };
      }

      const node = await libraryRepository.getNode(request.params.id);
      if (!node) {
        reply.code(404);
        return { error: "not_found" };
      }
      const mediaKind = toIdentifiableMediaKind(node.mediaType, node.parentId);
      if (!mediaKind) {
        reply.code(400);
        return { error: "unsupported_media_type", mediaType: node.mediaType };
      }

      const { externalId } = request.body;
      const details = await metadataProvider.fetchDetails(externalId, mediaKind);
      if (!details) {
        reply.code(404);
        return { error: "external_id_not_found" };
      }

      const externalIds = [
        ...node.externalIds.filter((existing) => existing.provider !== metadataProvider.id),
        { provider: metadataProvider.id, entityType: "library_node" as const, entityId: node.id, providerId: externalId },
      ];

      await libraryRepository.updateNode({
        ...node,
        title: details.title,
        sortTitle: details.title.toLowerCase(),
        externalIds,
        updatedAt: new Date(),
      });

      return { node: { ...node, title: details.title, externalIds }, details };
    },
  );

  app.get<{ Params: { id: string } }>("/api/library/:id/metadata", async (request, reply) => {
    if (!metadataProvider) {
      reply.code(503);
      return { error: "metadata_disabled", message: "Set TMDB_API_KEY to enable metadata identification" };
    }

    const node = await libraryRepository.getNode(request.params.id);
    if (!node) {
      reply.code(404);
      return { error: "not_found" };
    }
    const mediaKind = toIdentifiableMediaKind(node.mediaType, node.parentId);
    const existing = node.externalIds.find((externalId) => externalId.provider === metadataProvider.id);
    if (!mediaKind || !existing) {
      reply.code(404);
      return { error: "not_identified" };
    }

    const details = await metadataProvider.fetchDetails(existing.providerId, mediaKind);
    if (!details) {
      reply.code(404);
      return { error: "external_id_not_found" };
    }
    return { details };
  });

  app.post("/api/library/auto-identify", async (_request, reply) => {
    if (!metadataProvider) {
      reply.code(503);
      return { error: "metadata_disabled", message: "Set TMDB_API_KEY to enable metadata identification" };
    }

    return autoIdentifyLibrary(libraryRepository, metadataProvider);
  });
}
