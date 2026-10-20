import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseTitleAndYear } from "./parse-title-year.js";
import { fileExtension, isVideoFile } from "./video-extensions.js";

export interface ScannedMovie {
  readonly title: string;
  readonly year: number | null;
  /** Raw scanned folder name — a stable identity for matching on re-import, since `title`
   * gets overwritten with a provider's canonical name once this movie is identified. */
  readonly folderName: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly container: string;
}

export interface ScanSkip {
  readonly path: string;
  readonly reason: string;
}

export interface ScanMoviesResult {
  readonly movies: ScannedMovie[];
  readonly skipped: ScanSkip[];
}

async function findDirectVideoFiles(dirPath: string): Promise<{ path: string; sizeBytes: number }[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const found: { path: string; sizeBytes: number }[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !isVideoFile(entry.name)) continue;
    const entryPath = join(dirPath, entry.name);
    const stats = await stat(entryPath);
    found.push({ path: entryPath, sizeBytes: stats.size });
  }

  return found;
}

/**
 * Each immediate subdirectory of `rootPath` is treated as one movie, named "Title (Year)",
 * per the Radarr/Jellyfin convention that a movie's file(s) sit directly inside its folder
 * — deliberately NOT recursive. A folder with no video file directly inside it (an empty
 * placeholder, or — as happens in practice — an entire nested library root sitting inside
 * what looks like a movie folder) is reported as skipped rather than guessing at a file
 * from somewhere underneath it. When a folder has more than one video file directly inside
 * it (e.g. the same release re-muxed to a second container), the largest is taken as the
 * real one.
 */
export async function scanMoviesDirectory(rootPath: string): Promise<ScanMoviesResult> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const movies: ScannedMovie[] = [];
  const skipped: ScanSkip[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderPath = join(rootPath, entry.name);
    const videoFiles = await findDirectVideoFiles(folderPath);

    if (videoFiles.length === 0) {
      skipped.push({ path: folderPath, reason: "no video file found" });
      continue;
    }

    const largest = videoFiles.reduce((best, candidate) => (candidate.sizeBytes > best.sizeBytes ? candidate : best));
    const { title, year } = parseTitleAndYear(entry.name);
    movies.push({
      title,
      year,
      folderName: entry.name,
      filePath: largest.path,
      sizeBytes: largest.sizeBytes,
      container: fileExtension(largest.path),
    });
  }

  return { movies, skipped };
}
