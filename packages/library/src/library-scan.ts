import { access, readdir } from "node:fs/promises";
import type { LibraryFolder, LibraryRepository, MediaAvailabilityRepository } from "@tessatv/domain";
import { autoIdentifyLibrary, type AutoIdentifySummary } from "./auto-identify.js";
import { importMovies, importShows } from "./importer.js";
import { mergeDuplicateSeries, type MergeDuplicateSeriesSummary } from "./merge-duplicate-series.js";
import type { MetadataProvidersByKind } from "./metadata-sweep.js";
import { scanMoviesDirectory } from "./scan-movies.js";
import { scanShowsDirectory } from "./scan-shows.js";

export interface ImportFoldersResult {
  movies?: { created: number; skipped: number; skippedFolders: { path: string; reason: string }[] };
  shows?: { created: number; skipped: number; seriesFound: number };
  identify?: AutoIdentifySummary;
  duplicateSeries?: MergeDuplicateSeriesSummary;
}

/**
 * The whole import pipeline, shared by the manual `POST /api/library/import` and the
 * scheduled scan: scan folders, create anything new, identify it, merge duplicate series.
 */
export async function importFolders(
  repository: LibraryRepository,
  providers: MetadataProvidersByKind,
  folders: { readonly moviesPaths: readonly string[]; readonly showsPaths: readonly string[] },
): Promise<ImportFoldersResult> {
  const result: ImportFoldersResult = {};

  for (const path of folders.moviesPaths) {
    const scanned = await scanMoviesDirectory(path);
    const counts = await importMovies(repository, scanned.movies);
    result.movies = {
      created: (result.movies?.created ?? 0) + counts.created,
      skipped: (result.movies?.skipped ?? 0) + counts.skipped,
      skippedFolders: [...(result.movies?.skippedFolders ?? []), ...scanned.skipped],
    };
  }

  for (const path of folders.showsPaths) {
    const scanned = await scanShowsDirectory(path);
    const counts = await importShows(repository, scanned.series);
    result.shows = {
      created: (result.shows?.created ?? 0) + counts.created,
      skipped: (result.shows?.skipped ?? 0) + counts.skipped,
      seriesFound: (result.shows?.seriesFound ?? 0) + scanned.series.length,
    };
  }

  // Newly-imported items get identified automatically — the sweep skips anything already
  // identified, so this is cheap to run every time.
  if (providers.movie || providers.series) {
    result.identify = await autoIdentifyLibrary(repository, providers);
  }
  // Two source folders for one real show get merged when unambiguous; ambiguous cases are
  // reported for `POST /api/library/merge-duplicates/confirm`.
  if (providers.series) {
    result.duplicateSeries = await mergeDuplicateSeries(repository, providers.series);
  }
  return result;
}

export interface LibraryScanSummary {
  readonly import: ImportFoldersResult;
  readonly markedMissing: number;
  readonly restored: number;
  readonly skippedFolders: readonly { readonly path: string; readonly reason: string }[];
}

export interface LibraryScanDependencies {
  readonly repository: LibraryRepository;
  readonly availability: MediaAvailabilityRepository;
  readonly providers: MetadataProvidersByKind;
  /** Test seam. */
  readonly exists?: (path: string) => Promise<boolean>;
}

const pathExists = (path: string) => access(path).then(() => true, () => false);

/**
 * Why a folder can't be trusted this run, or null if it can. An empty folder counts as
 * unreachable: an unmounted drive usually looks like an empty mount point, and treating it
 * as "every file was deleted" would hide that whole part of the library.
 */
async function folderProblem(path: string): Promise<string | null> {
  try {
    const entries = await readdir(path);
    return entries.length === 0 ? "folder is empty (drive not mounted?)" : null;
  } catch (error) {
    return `can't read folder: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
}

/**
 * One scheduled (or "Scan now") pass: imports new files from every reachable folder, then
 * checks every known file under those folders — missing ones are hidden, returning ones
 * come back. Nothing is deleted, so watch history survives a file going away and back.
 */
export async function scanLibrary(folders: readonly LibraryFolder[], deps: LibraryScanDependencies): Promise<LibraryScanSummary> {
  const exists = deps.exists ?? pathExists;
  const skippedFolders: { path: string; reason: string }[] = [];
  const reachable: LibraryFolder[] = [];
  for (const folder of folders) {
    const problem = await folderProblem(folder.path);
    if (problem) skippedFolders.push({ path: folder.path, reason: problem });
    else reachable.push(folder);
  }

  const imported = await importFolders(deps.repository, deps.providers, {
    moviesPaths: reachable.filter((folder) => folder.mediaType === "movie").map((folder) => folder.path),
    showsPaths: reachable.filter((folder) => folder.mediaType === "series").map((folder) => folder.path),
  });

  const missing: string[] = [];
  const restored: string[] = [];
  for (const folder of reachable) {
    for (const file of await deps.availability.listFilesUnder(folder.path)) {
      const present = await exists(file.path);
      if (!present && file.availability === "available") missing.push(file.unitId);
      if (present && file.availability === "missing") restored.push(file.unitId);
    }
  }
  await deps.availability.setAvailability(missing, "missing");
  await deps.availability.setAvailability(restored, "available");

  return { import: imported, markedMissing: missing.length, restored: restored.length, skippedFolders };
}
