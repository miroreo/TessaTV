import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./password.js";

/** "legacy password" hashed by the pre-Argon2 scrypt code (N=1024, r=8, p=1). */
const LEGACY_SCRYPT_HASH =
  "scrypt$1024$8$1$AAAAAAAAAAAAAAAAAAAAAA==$IbaAHYC6LGP6AdIGYpO90hmeSs8RSTupJrMFD431IZRsVygrRS0Yb5F581vxfQUkquWyyudJXzTgGEwC+/HtQA==";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", hash)).toBe(true);
    expect(await verifyPassword("correct horsE", hash)).toBe(false);
  });

  it("produces salted Argon2id hashes that don't need rehashing", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$argon2id\$/);
    expect(needsRehash(a)).toBe(false);
  });

  it("treats Unicode-equivalent passwords as equal", async () => {
    const hash = await hashPassword("café");
    expect(await verifyPassword("café", hash)).toBe(true);
  });

  it("still verifies legacy scrypt hashes, and flags them for rehashing", async () => {
    expect(await verifyPassword("legacy password", LEGACY_SCRYPT_HASH)).toBe(true);
    expect(await verifyPassword("wrong password", LEGACY_SCRYPT_HASH)).toBe(false);
    expect(needsRehash(LEGACY_SCRYPT_HASH)).toBe(true);
  });

  it("returns false for malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("x", "")).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$2")).toBe(false);
  });
});
