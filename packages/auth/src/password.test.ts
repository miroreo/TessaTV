import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

// Low cost parameters keep the suite fast; the format and comparison logic are identical.
const FAST = { N: 1024, r: 8, p: 1 };

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse", FAST);
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsE", hash)).toBe(false);
  });

  it("salts every hash and records its parameters", async () => {
    const [a, b] = await Promise.all([hashPassword("same", FAST), hashPassword("same", FAST)]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$[^$]+\$[^$]+$/);
  });

  it("works at the default production cost", async () => {
    const hash = await hashPassword("production cost");
    expect(hash.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("production cost", hash)).toBe(true);
  });

  it("treats Unicode-equivalent passwords as equal", async () => {
    const hash = await hashPassword("café", FAST);
    expect(await verifyPassword("café", hash)).toBe(true);
  });

  it("returns false for malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
  });
});
