import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts small secrets (an SSO client secret, a sign-in's PKCE verifier) with AES-256-GCM
 * under a key derived from `APP_SECRET`, so a database dump or a cookie never holds them in
 * the clear and tampering is detected. Each `purpose` gets its own key, so a value sealed for
 * one use can't be replayed as another.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string, purpose: string) {
    this.key = Buffer.from(hkdfSync("sha256", appSecret, "tessatv", `secret-box:${purpose}`, 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  /** Null for anything not sealed by this box with this secret (tampered, foreign, or after APP_SECRET changed). */
  open(sealed: string): string | null {
    const [version, encoded] = sealed.split(".");
    if (version !== VERSION || !encoded) return null;
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length < IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}
