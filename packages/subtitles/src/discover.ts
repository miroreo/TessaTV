import { randomUUID } from "node:crypto";
import path from "node:path";
import type { SubtitleRepository } from "@tessatv/domain";
import { normalizeLanguage } from "./language.js";
import { parseSidecarName } from "./naming.js";

export interface SidecarDiscoveryDeps {
  readonly subtitles: Pick<SubtitleRepository, "listAll" | "listPlayableFiles" | "add" | "remove" | "blacklist">;
  /** The file names in a directory, or null when it can't be read (gone, or not mounted right now). */
  readonly listDirectory: (directory: string) => Promise<readonly string[] | null>;
  readonly now?: () => Date;
}

export interface SidecarDiscoverySummary {
  readonly added: number;
  readonly removed: number;
}

/**
 * Keeps the subtitle records in step with the disk: subtitle files found beside a video (put
 * there by hand or another tool) get recorded, and records whose file is gone are dropped. A
 * *downloaded* subtitle that was deleted is also blacklisted, so a person throwing away a bad
 * one isn't handed the same one again. Reads each directory once, and never drops a record
 * for a directory it couldn't read, so a media share that is offline doesn't wipe the records.
 */
export async function discoverSidecars(deps: SidecarDiscoveryDeps): Promise<SidecarDiscoverySummary> {
  const now = deps.now ?? (() => new Date());
  const listings = new Map<string, Promise<readonly string[] | null>>();
  const list = (directory: string) => {
    if (!listings.has(directory)) listings.set(directory, deps.listDirectory(directory));
    return listings.get(directory)!;
  };

  const known = await deps.subtitles.listAll();
  let removed = 0;
  for (const record of known) {
    const names = await list(path.dirname(record.path));
    if (!names || names.includes(path.basename(record.path))) continue;
    await deps.subtitles.remove(record.id);
    if (record.source === "downloaded" && record.provider && record.providerId) {
      await deps.subtitles.blacklist(record.unitId, record.provider, record.providerId);
    }
    removed++;
  }
  const knownPaths = new Set(known.map((record) => record.path));

  const byDirectory = new Map<string, Awaited<ReturnType<SubtitleRepository["listPlayableFiles"]>>>();
  for (const video of await deps.subtitles.listPlayableFiles()) {
    const directory = path.dirname(video.videoPath);
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), video]);
  }

  let added = 0;
  for (const [directory, videos] of byDirectory) {
    const names = await list(directory);
    if (!names) continue;
    for (const video of videos) {
      const videoName = path.basename(video.videoPath);
      for (const name of names) {
        const flavor = parseSidecarName(videoName, name, normalizeLanguage);
        const subtitlePath = path.join(directory, name);
        if (!flavor || knownPaths.has(subtitlePath)) continue;
        knownPaths.add(subtitlePath);
        await deps.subtitles.add({
          id: randomUUID(), unitId: video.unitId, mediaFileId: video.mediaFileId, language: flavor.language, forced: flavor.forced,
          hearingImpaired: flavor.hearingImpaired, source: "sidecar-found", provider: null, providerId: null, score: null,
          path: subtitlePath, format: flavor.extension, createdAt: now(),
        });
        added++;
      }
    }
  }
  return { added, removed };
}
