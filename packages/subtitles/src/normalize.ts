import chardet from "chardet";
import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import type { SubtitleDownload, SubtitleFormat } from "./subtitle-provider.js";

export interface SubtitleFile {
  /** UTF-8, no byte order mark. */
  readonly text: string;
  readonly format: Exclude<SubtitleFormat, "zip">;
}

const TEXT_FORMATS = ["srt", "ass", "ssa", "vtt"] as const;
type TextFormat = (typeof TEXT_FORMATS)[number];

function formatOf(fileName: string): TextFormat | null {
  const ext = fileName.split(".").pop()?.toLowerCase();
  return TEXT_FORMATS.find((format) => format === ext) ?? null;
}

function isZip(download: SubtitleDownload): boolean {
  const { bytes, fileName } = download;
  return (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) || fileName.toLowerCase().endsWith(".zip");
}

/** Providers like Subdl ship zips; picks the subtitle inside, preferring SRT and then the largest. */
function unpack(download: SubtitleDownload): { bytes: Uint8Array; fileName: string } {
  if (!isZip(download)) return download;
  const entries = Object.entries(unzipSync(download.bytes))
    .filter(([name]) => !name.endsWith("/") && !name.startsWith("__MACOSX") && formatOf(name) !== null)
    .sort(([nameA, a], [nameB, b]) => TEXT_FORMATS.indexOf(formatOf(nameA)!) - TEXT_FORMATS.indexOf(formatOf(nameB)!) || b.length - a.length);
  const best = entries[0];
  if (!best) throw new Error("The archive has no text subtitle in it");
  return { fileName: best[0], bytes: best[1] };
}

/** Subtitles in the wild are UTF-8, UTF-16, cp1252, cp1250, GBK ...; ffmpeg assumes UTF-8 and mangles the rest. */
function decode(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return Buffer.from(bytes.subarray(3)).toString("utf8");
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return iconv.decode(Buffer.from(bytes), "utf-16le").replace(/^\uFEFF/, "");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return iconv.decode(Buffer.from(bytes), "utf-16be").replace(/^\uFEFF/, "");

  const strict = new TextDecoder("utf-8", { fatal: true });
  try {
    return strict.decode(bytes);
  } catch {
    // Not valid UTF-8: ask the detector, and fall back to Western European, the most common case.
    const detected = chardet.analyse(bytes).find((match) => iconv.encodingExists(match.name))?.name;
    return iconv.decode(Buffer.from(bytes), detected ?? "windows-1252");
  }
}

/** Turns what a provider handed over (maybe zipped, in any charset) into UTF-8 subtitle text. */
export function normalizeSubtitle(download: SubtitleDownload): SubtitleFile {
  const file = unpack(download);
  const format = formatOf(file.fileName);
  if (!format) throw new Error(`Unsupported subtitle file "${file.fileName}"`);
  const text = decode(file.bytes);
  if (text.trim() === "") throw new Error("The subtitle file is empty");
  return { text, format };
}
