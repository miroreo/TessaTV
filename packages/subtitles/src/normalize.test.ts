import { strToU8, zipSync } from "fflate";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import { detectEncoding, normalizeSubtitle } from "./normalize.js";

const SRT = "1\n00:00:01,000 --> 00:00:02,000\nCafé crème\n";

describe("normalizeSubtitle", () => {
  it("passes UTF-8 through and drops a byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(SRT)]);
    expect(normalizeSubtitle({ bytes, fileName: "a.srt" })).toEqual({ text: SRT, format: "srt" });
  });

  it("decodes UTF-16", () => {
    const bytes = new Uint8Array([0xff, 0xfe, ...iconv.encode(SRT, "utf-16le")]);
    expect(normalizeSubtitle({ bytes, fileName: "a.srt" }).text).toBe(SRT);
  });

  it("decodes Windows-1252 instead of mangling it", () => {
    const bytes = new Uint8Array(iconv.encode(SRT, "windows-1252"));
    expect(normalizeSubtitle({ bytes, fileName: "a.srt" }).text).toBe(SRT);
  });

  it("picks the SRT out of a zip, over an ASS and the junk", () => {
    const bytes = zipSync({ "readme.txt": strToU8("hi"), "show.ass": strToU8("[Script Info]"), "show.srt": strToU8(SRT), "__MACOSX/show.srt": strToU8("x") });
    expect(normalizeSubtitle({ bytes, fileName: "subs.zip" })).toEqual({ text: SRT, format: "srt" });
  });

  it("rejects a zip with no subtitle, an empty file and an unknown format", () => {
    expect(() => normalizeSubtitle({ bytes: zipSync({ "a.txt": strToU8("x") }), fileName: "s.zip" })).toThrow(/no text subtitle/);
    expect(() => normalizeSubtitle({ bytes: strToU8("  \n"), fileName: "a.srt" })).toThrow(/empty/);
    expect(() => normalizeSubtitle({ bytes: strToU8("x"), fileName: "a.idx" })).toThrow(/Unsupported/);
  });

  it("names the encoding for ffmpeg", () => {
    expect(detectEncoding(strToU8(SRT))).toBe("utf-8");
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0]))).toBe("utf-16le");
    expect(detectEncoding(new Uint8Array(iconv.encode(SRT.repeat(5), "windows-1252")))).toMatch(/1252|8859-1|ISO-8859/i);
  });
});
