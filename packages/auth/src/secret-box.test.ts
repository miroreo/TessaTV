import { describe, expect, it } from "vitest";
import { SecretBox } from "./secret-box.js";

const APP_SECRET = "a".repeat(32);

describe("SecretBox", () => {
  it("round-trips, with a fresh ciphertext every time", () => {
    const box = new SecretBox(APP_SECRET, "oidc-client-secret");
    const sealed = box.seal("s3cret");
    expect(sealed).not.toContain("s3cret");
    expect(box.seal("s3cret")).not.toBe(sealed);
    expect(box.open(sealed)).toBe("s3cret");
  });

  it("rejects tampering, another purpose's box, another APP_SECRET, and junk", () => {
    const box = new SecretBox(APP_SECRET, "oidc-client-secret");
    const sealed = box.seal("s3cret");
    const flipped = `${sealed.slice(0, -2)}${sealed.at(-2) === "A" ? "B" : "A"}${sealed.at(-1)}`;
    expect(box.open(flipped)).toBeNull();
    expect(new SecretBox(APP_SECRET, "oidc-pending").open(sealed)).toBeNull();
    expect(new SecretBox("b".repeat(32), "oidc-client-secret").open(sealed)).toBeNull();
    expect(box.open("not sealed")).toBeNull();
  });
});
