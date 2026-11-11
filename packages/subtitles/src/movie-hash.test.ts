import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { movieHash } from "./movie-hash.js";

describe("movieHash", () => {
  it("is the size plus the 64-bit words of the first and last 64 KiB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    try {
      const size = 200_000;
      const bytes = Buffer.alloc(size);
      bytes.writeBigUInt64LE(5n, 0);
      bytes.writeBigUInt64LE(7n, size - 8);
      bytes.writeBigUInt64LE(1000n, 70_000); // in the middle: must not count
      const file = path.join(dir, "video.mkv");
      await writeFile(file, bytes);
      expect(await movieHash(file)).toBe((BigInt(size) + 5n + 7n).toString(16).padStart(16, "0"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("wraps around 64 bits", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    try {
      const bytes = Buffer.alloc(70_000);
      bytes.writeBigUInt64LE((1n << 64n) - 1n, 0);
      const file = path.join(dir, "video.mkv");
      await writeFile(file, bytes);
      expect(await movieHash(file)).toBe((BigInt(70_000) - 1n).toString(16).padStart(16, "0"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("has no hash for a file smaller than 64 KiB", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hash-"));
    try {
      const file = path.join(dir, "tiny.mkv");
      await writeFile(file, "tiny");
      expect(await movieHash(file)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
