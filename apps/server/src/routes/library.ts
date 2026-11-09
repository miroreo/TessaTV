import type { LibraryNodesResponse, LibraryRepository, UnitsResponse } from "@tessatv/domain";
import type { FastifyInstance } from "fastify";

export function registerLibraryRoutes(app: FastifyInstance, libraryRepository: LibraryRepository): void {
  app.get("/api/library", async (): Promise<LibraryNodesResponse> => {
    const roots = await libraryRepository.listChildren(null);
    return { items: roots };
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/children", async (request): Promise<LibraryNodesResponse> => {
    const children = await libraryRepository.listChildren(request.params.id);
    return { items: children };
  });

  app.get<{ Params: { id: string } }>("/api/library/:id/units", async (request, reply) => {
    const node = await libraryRepository.getNode(request.params.id);
    if (!node) {
      reply.code(404);
      return { error: "not_found" };
    }
    const units = await libraryRepository.listUnits(request.params.id);
    return { items: units } satisfies UnitsResponse;
  });
}
