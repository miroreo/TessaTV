import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseEpisodeFilename } from "./parse-episode.js";
import { normalizeSeriesTitle } from "./parse-title-year.js";
import { fileExtension, isVideoFile } from "./video-extensions.js";

export interface ScannedEpisode {
  readonly season: number;
  readonly episode: number;
  readonly title: string;
  readonly filePath: string;
  readonly sizeBytes: number;
  readonly container: string;
}

export interface ScannedSeries {
  readonly title: string;
  readonly episodes: readonly ScannedEpisode[];
}

export interface ScanShowsResult {
  readonly series: ScannedSeries[];
}

async function findEpisodeFiles(dirPath: string): Promise<ScannedEpisode[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const found: ScannedEpisode[] = [];

  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await findEpisodeFiles(entryPath)));
      continue;
    }
    if (!entry.isFile() || !isVideoFile(entry.name)) continue;

    const parsed = parseEpisodeFilename(entry.name);
    if (!parsed) continue;

    const stats = await stat(entryPath);
    found.push({ ...parsed, filePath: entryPath, sizeBytes: stats.size, container: fileExtension(entry.name) });
  }

  return found;
}

/** Keeps the largest file when the same (season, episode) turns up more than once — real
 * libraries routinely have duplicate/legacy season folders sitting next to the real one. */
function dedupeBySeasonEpisode(episodes: readonly ScannedEpisode[]): ScannedEpisode[] {
  const bySeasonEpisode = new Map<string, ScannedEpisode>();
  for (const episode of episodes) {
    const key = `${episode.season}:${episode.episode}`;
    const existing = bySeasonEpisode.get(key);
    if (!existing || episode.sizeBytes > existing.sizeBytes) {
      bySeasonEpisode.set(key, episode);
    }
  }
  return Array.from(bySeasonEpisode.values());
}

/**
 * Each immediate subdirectory of `rootPath` is treated as one series. Season/episode
 * identity is read directly from each video file's own "SxxExx" token rather than from
 * the folder structure — real libraries mix "S01", "Season 1", and empty leftover folders
 * for the same season, and the filename token is the one thing that's reliably present.
 */
export async function scanShowsDirectory(rootPath: string): Promise<ScanShowsResult> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const series: ScannedSeries[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const seriesPath = join(rootPath, entry.name);
    const episodes = dedupeBySeasonEpisode(await findEpisodeFiles(seriesPath));
    if (episodes.length === 0) continue;
    series.push({ title: normalizeSeriesTitle(entry.name), episodes });
  }

  return { series };
}
