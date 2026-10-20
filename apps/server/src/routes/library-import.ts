import type { LibraryRepository } from "@tessatv/domain";
import { importMovies, importShows, scanMoviesDirectory, scanShowsDirectory } from "@tessatv/library";
import type { FastifyInstance } from "fastify";

interface ImportRequestBody {
  moviesPath?: string;
  showsPath?: string;
}

export function registerLibraryImportRoutes(app: FastifyInstance, libraryRepository: LibraryRepository): void {
  app.post<{ Body: ImportRequestBody }>("/api/library/import", async (request, reply) => {
    const { moviesPath, showsPath } = request.body ?? {};
    if (!moviesPath && !showsPath) {
      reply.code(400);
      return { error: "provide at least one of moviesPath or showsPath" };
    }

    const result: {
      movies?: { created: number; skipped: number; skippedFolders: { path: string; reason: string }[] };
      shows?: { created: number; skipped: number; seriesFound: number };
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

    return result;
  });
}
