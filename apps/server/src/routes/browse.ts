import type {
  HomeResponse,
  LibraryRepository,
  MediaAvailabilityRepository,
  TitleResponse,
  WatchProgressRepository,
} from "@tessatv/domain";
import { continueWatching, listUnitsUnder, nextUp, pickNextUnit } from "@tessatv/library";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { type Catalog, unitSummary } from "./catalog.js";

export interface BrowseDependencies {
  readonly libraryRepository: LibraryRepository;
  readonly progressRepository: WatchProgressRepository;
  readonly catalog: Catalog;
  readonly availability?: MediaAvailabilityRepository;
}

/** Read-only views shaped for the UI's pages, so a page is one request rather than dozens. */
export function registerBrowseRoutes(server: FastifyInstance, deps: BrowseDependencies): void {
  const app = server.withTypeProvider<ZodTypeProvider>();
  const { libraryRepository, progressRepository, catalog } = deps;

  app.get("/api/browse/home", async (request): Promise<HomeResponse> => {
    const userId = request.user!.id;
    const [allRoots, playableRoots, resume, upNext] = await Promise.all([
      libraryRepository.listChildren(null),
      deps.availability?.listRootsWithPlayableUnits(),
      continueWatching(libraryRepository, progressRepository, userId),
      nextUp(libraryRepository, progressRepository, userId),
    ]);
    // Titles whose files have all gone missing stay in the database (with their watch
    // history) but drop out of the library until a scan finds them again.
    const roots = playableRoots ? allRoots.filter((root) => playableRoots.has(root.id)) : allRoots;
    const sorted = [...roots].sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
    const titles = await catalog.titles(sorted);
    return {
      continueWatching: await catalog.entries(resume),
      nextUp: await catalog.entries(upNext),
      movies: titles.filter((title) => !title.isSeries),
      shows: titles.filter((title) => title.isSeries),
    };
  });

  app.get("/api/browse/title/:id", { schema: { params: z.object({ id: z.string() }) } }, async (request, reply) => {
    const node = await libraryRepository.getNode(request.params.id);
    if (!node || node.parentId !== null) return reply.code(404).send({ error: "not_found" });

    const units = await listUnitsUnder(libraryRepository, node.id);
    const progress = await progressRepository.listForUnits(request.user!.id, units.map((unit) => unit.id));
    const progressByUnit = new Map(progress.map((entry) => [entry.unitId, entry]));
    const summaries = units.map((unit) => unitSummary(unit, progressByUnit.get(unit.id) ?? null));

    // Grouped by the sequence's season number rather than by season nodes: merged series
    // can have two nodes for one season.
    const seasons = new Map<number, typeof summaries>();
    for (const summary of summaries) {
      const number = summary.season ?? 0;
      seasons.set(number, [...(seasons.get(number) ?? []), summary]);
    }
    const next = pickNextUnit(units, progress);

    const response: TitleResponse = {
      title: await catalog.title(node),
      seasons: node.kind === "collection" ? [...seasons].map(([number, episodes]) => ({ number, episodes })) : [],
      units: summaries,
      next: next ? unitSummary(next, progressByUnit.get(next.id) ?? null) : null,
    };
    return response;
  });
}
