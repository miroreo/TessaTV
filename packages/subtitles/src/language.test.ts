import { describe, expect, it } from "vitest";
import { normalizeLanguage, primaryLanguage, toThreeLetterLanguage } from "./language.js";

describe("normalizeLanguage", () => {
  it("maps provider spellings to one form", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("ENG")).toBe("en");
    expect(normalizeLanguage("pt_br")).toBe("pt-BR");
    expect(normalizeLanguage("zh-tw")).toBe("zh-TW");
    expect(normalizeLanguage("fra")).toBe("fr");
  });
  it("rejects things that are not languages", () => {
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage("xx")).toBeNull();
    expect(normalizeLanguage("directors")).toBeNull();
  });
  it("finds the primary language", () => {
    expect(primaryLanguage("pt-BR")).toBe("pt");
  });

  it("gives the three-letter form files tag tracks with", () => {
    expect(toThreeLetterLanguage("en")).toBe("eng");
    expect(toThreeLetterLanguage("pt-BR")).toBe("por");
    expect(toThreeLetterLanguage("nope")).toBeNull();
  });
});
