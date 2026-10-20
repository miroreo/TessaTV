import type { LibraryRepository } from "@tessatv/domain";
import {
  autoIdentifyLibrary,
  importMovies,
  importShows,
  scanMoviesDirectory,
  scanShowsDirectory,
  type AutoIdentifySummary,
  type MetadataProvidersByKind,
} from "@tessatv/library";
import type { FastifyInstance } from "fastify";

interface ImportRequestBody {
  moviesPath?: string;
  showsPath?: string;
}

export function registerLibraryImportRoutes(
  app: FastifyInstance,
  libraryRepository: LibraryRepository,
  metadataProviders: MetadataProvidersByKind,
): void {
  app.post<{ Body: ImportRequestBody }>("/api/library/import", async (request, reply) => {
    const { moviesPath, showsPath } = request.body ?? {};
    if (!moviesPath && !showsPath) {
      reply.code(400);
      return { error: "provide at least one of moviesPath or showsPath" };
    }

    const result: {
      movies?: { created: number; skipped: number; skippedFolders: { path: string; reason: string }[] };
      shows?: { created: number; skipped: number; seriesFound: number };
      identify?: AutoIdentifySummary;
    } = {};

    if (moviesPath) {
      const scanned = await scanMoviesDirectory(moviesPath);
      const counts = await importMovies(libraryRepository, scanned.movies);
      result.movies = { ...counts, skippedFolders: scanned.skipped };
    }

    if (showsPath) {
      const scanned = await scanShowsDirectory(showsPath);
      const counts = await importShows(libraryRepository, scanned.series);
      result.shows = { ...counts, seriesFound: scanned.series.length };
    }

    // Newly-imported items get identified against metadata automatically — the sweep
    // already skips anything already identified, so this is cheap to run every time.
    if (metadataProviders.movie || metadataProviders.series) {
      result.identify = await autoIdentifyLibrary(libraryRepository, metadataProviders);
    }

    return result;
  });
}
