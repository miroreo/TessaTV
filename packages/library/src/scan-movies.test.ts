import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanMoviesDirectory } from "./scan-movies.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tessatv-scan-movies-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeMovieFolder(name: string, files: Record<string, string | number>): Promise<void> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  for (const [fileName, content] of Object.entries(files)) {
    await writeFile(join(folder, fileName), typeof content === "number" ? Buffer.alloc(content) : content);
  }
}

describe("scanMoviesDirectory", () => {
  it("finds the video file directly inside a movie folder", async () => {
    await makeMovieFolder("Some Movie (2000)", { "movie.mkv": 100, "movie.srt": "subtitle" });

    const result = await scanMoviesDirectory(root);

    expect(result.movies).toEqual([
      expect.objectContaining({
        title: "Some Movie",
        year: 2000,
        folderName: "Some Movie (2000)",
        container: "mkv",
        sizeBytes: 100,
      }),
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("picks the largest video file when a folder has more than one directly inside it", async () => {
    await makeMovieFolder("Another Movie (2001)", { "a.mkv": 50, "b.mp4": 200 });

    const result = await scanMoviesDirectory(root);

    expect(result.movies[0]).toMatchObject({ container: "mp4", sizeBytes: 200 });
  });

  it("skips a folder with no video file directly inside it, rather than recursing into subdirectories", async () => {
    // Simulates a real-world case: a "movie" folder that actually contains an entire
    // nested library root (many other movie folders), not a video file of its own.
    await makeMovieFolder("Nested Root", {});
    await makeMovieFolder(join("Nested Root", "Some Other Movie (1999)"), { "movie.mkv": 100 });

    const result = await scanMoviesDirectory(root);

    expect(result.movies).toEqual([]);
    expect(result.skipped).toEqual([{ path: join(root, "Nested Root"), reason: "no video file found" }]);
  });

  it("skips a genuinely empty folder", async () => {
    await makeMovieFolder("Empty Movie (2002)", {});

    const result = await scanMoviesDirectory(root);

    expect(result.movies).toEqual([]);
    expect(result.skipped).toEqual([{ path: join(root, "Empty Movie (2002)"), reason: "no video file found" }]);
  });
});
