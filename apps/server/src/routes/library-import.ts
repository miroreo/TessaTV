import type { LibraryRepository } from "@tessatv/domain";
import {
  autoIdentifyLibrary,
  importMovies,
  importShows,
  mergeDuplicateSeries,
  scanMoviesDirectory,
  scanShowsDirectory,
  type AutoIdentifySummary,
  type MergeDuplicateSeriesSummary,
  type MetadataProvidersByKind,
} from "@tessatv/library";
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

    const result: {
      movies?: { created: number; skipped: number; skippedFolders: { path: string; reason: string }[] };
      shows?: { created: number; skipped: number; seriesFound: number };
      identify?: AutoIdentifySummary;
      duplicateSeries?: MergeDuplicateSeriesSummary;
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

    // Two source folders for the same real show (now sharing an external id after the
    // identify step above) get merged automatically when unambiguous; ambiguous cases are
    // reported in `duplicateSeries.pending` for POST /api/library/merge-duplicates/confirm.
    if (metadataProviders.series) {
      result.duplicateSeries = await mergeDuplicateSeries(libraryRepository, metadataProviders.series);
    }

    return result;
  });
}
