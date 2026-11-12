import path from "node:path";

export interface SidecarFlavor {
  /** Normalized, e.g. `en` or `pt-BR`. */
  readonly language: string;
  readonly forced: boolean;
  readonly hearingImpaired: boolean;
  /** Without the dot: `srt`, `ass`. */
  readonly extension: string;
}

/**
 * Where a subtitle for `videoPath` lives, in the convention Jellyfin, Plex and most players
 * read: `Movie (2020).en.srt`, `Movie (2020).en.forced.srt`, `Movie (2020).en.sdh.srt`.
 */
export function sidecarPath(videoPath: string, flavor: SidecarFlavor): string {
  const { dir, name } = path.parse(videoPath);
  const flags = [flavor.forced ? "forced" : null, flavor.hearingImpaired ? "sdh" : null].filter((flag) => flag !== null);
  return path.join(dir, [name, flavor.language, ...flags].join(".") + `.${flavor.extension}`);
}

const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "vtt", "sub"]);
const FLAG_WORDS = new Map([
  ["forced", "forced"],
  ["sdh", "hearingImpaired"],
  ["hi", "hearingImpaired"],
  ["cc", "hearingImpaired"],
] as const);

/**
 * Reads a subtitle file's name back into what it is, given the video it sits beside, so the
 * scan can recognise sidecars somebody (or another tool) put there. Null when the file isn't a
 * subtitle for this video. The language must already be a normalized code, so a name like
 * `Movie.directors.cut.srt` isn't mistaken for a subtitle in some language.
 */
export function parseSidecarName(
  videoFileName: string,
  subtitleFileName: string,
  normalizeLanguage: (code: string) => string | null,
): SidecarFlavor | null {
  const base = path.parse(videoFileName).name;
  const { name, ext } = path.parse(subtitleFileName);
  const extension = ext.slice(1).toLowerCase();
  if (!SUBTITLE_EXTENSIONS.has(extension) || !name.startsWith(base)) return null;
  const rest = name.slice(base.length);
  if (rest !== "" && !rest.startsWith(".")) return null;

  let language: string | null = null;
  let forced = false;
  let hearingImpaired = false;
  for (const token of rest.split(".").filter(Boolean)) {
    const flag = FLAG_WORDS.get(token.toLowerCase() as "forced");
    if (flag === "forced") forced = true;
    else if (flag === "hearingImpaired") hearingImpaired = true;
    else language ??= normalizeLanguage(token);
  }
  return language ? { language, forced, hearingImpaired, extension } : null;
}
