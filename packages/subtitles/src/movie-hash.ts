import { open } from "node:fs/promises";

const CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

/**
 * OpenSubtitles' file hash: the file's size plus every little-endian 64-bit word in its first
 * and last 64 KiB, wrapped to 64 bits, as 16 hex digits. Matches subtitles to the exact
 * release. No maintained npm package exists for it, and it's a dozen lines. Null for files
 * under 64 KiB, which the scheme doesn't cover.
 */
export async function movieHash(filePath: string): Promise<string | null> {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    if (size < CHUNK) return null;
    let hash = BigInt(size);
    for (const offset of [0, size - CHUNK]) {
      const buffer = Buffer.alloc(CHUNK);
      await file.read(buffer, 0, CHUNK, offset);
      for (let i = 0; i < CHUNK; i += 8) hash = (hash + buffer.readBigUInt64LE(i)) & MASK;
    }
    return hash.toString(16).padStart(16, "0");
  } finally {
    await file.close();
  }
}
