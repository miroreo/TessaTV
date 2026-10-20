import type { LibraryRepository, MediaTypeId } from "@tessatv/domain";
import { autoIdentifyLibrary, type MetadataProvidersByKind } from "@tessatv/library";
import { type MetadataMediaKind, type MetadataProvider, toMetadataMediaKind } from "@tessatv/metadata";
import type { FastifyInstance } from "fastify";

/**
 * `toMetadataMediaKind` alone isn't enough here: "series" is also used for season
 * collection nodes, which aren't independently identifiable against a metadata provider —
 * only root-level nodes (movies, and top-level series) are.
 */
function toIdentifiableMediaKind(mediaType: MediaTypeId, parentId: string | null): MetadataMediaKind | null {
  if (parentId !== null) return null;
  return toMetadataMediaKind(mediaType);
}

/** Explicit `?provider=`/`{provider}` override wins; otherwise falls back to the default
 * provider for this media kind (movies -> TMDB, series -> TheTVDB, per providers config). */
function resolveProvider(
  providers: MetadataProvidersByKind,
  mediaKind: MetadataMediaKind,
  explicitProviderId: string | undefined,
): MetadataProvider | null {
  if (explicitProviderId) {
    return Object.values(providers).find((provider) => provider?.id === explicitProviderId) ?? null;
  }
  return providers[mediaKind] ?? null;
}

const DISABLED_RESPONSE = {
  error: "metadata_disabled",
  message: "No metadata provider configured for this media type — set TMDB_API_KEY and/or TVDB_API_KEY",
};

export function registerLibraryMetadataRoutes(
  app: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProviders: MetadataProvidersByKind,
): void {
  app.get<{ Params: { id: string }; Querystring: { year?: string; provider?: string } }>(
    "/api/library/:id/metadata/candidates",
    async (request, reply) => {
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
      const provider = resolveProvider(metadataProviders, mediaKind, request.query.provider);
      if (!provider) {
        reply.code(503);
        return DISABLED_RESPONSE;
      }

      const year = request.query.year ? Number(request.query.year) : null;
      const candidates = await provider.search({ title: node.title, year, mediaKind });
      return { provider: provider.id, items: candidates };
    },
  );

  app.post<{ Params: { id: string }; Body: { externalId: string; provider?: string } }>(
    "/api/library/:id/metadata/identify",
    async (request, reply) => {
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
      const provider = resolveProvider(metadataProviders, mediaKind, request.body.provider);
      if (!provider) {
        reply.code(503);
        return DISABLED_RESPONSE;
      }

      const { externalId } = request.body;
      const details = await provider.fetchDetails(externalId, mediaKind);
      if (!details) {
        reply.code(404);
        return { error: "external_id_not_found" };
      }

      const externalIds = [
        ...node.externalIds.filter((existing) => existing.provider !== provider.id),
        { provider: provider.id, entityType: "library_node" as const, entityId: node.id, providerId: externalId },
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

  app.get<{ Params: { id: string }; Querystring: { provider?: string } }>(
    "/api/library/:id/metadata",
    async (request, reply) => {
      const node = await libraryRepository.getNode(request.params.id);
      if (!node) {
        reply.code(404);
        return { error: "not_found" };
      }
      const mediaKind = toIdentifiableMediaKind(node.mediaType, node.parentId);
      const provider = mediaKind ? resolveProvider(metadataProviders, mediaKind, request.query.provider) : null;
      const existing = provider && node.externalIds.find((externalId) => externalId.provider === provider.id);
      if (!mediaKind || !provider || !existing) {
        reply.code(404);
        return { error: "not_identified" };
      }

      const details = await provider.fetchDetails(existing.providerId, mediaKind);
      if (!details) {
        reply.code(404);
        return { error: "external_id_not_found" };
      }
      return { details };
    },
  );

  app.post("/api/library/auto-identify", async (_request, reply) => {
    if (!metadataProviders.movie && !metadataProviders.series) {
      reply.code(503);
      return DISABLED_RESPONSE;
    }

    return autoIdentifyLibrary(libraryRepository, metadataProviders);
  });
}
