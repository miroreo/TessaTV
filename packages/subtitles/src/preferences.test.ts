import { describe, expect, it } from "vitest";
import { parseSubtitlePreferences } from "./preferences.js";

describe("parseSubtitlePreferences", () => {
  it("reads languages and forced tracks in order", () => {
    expect(parseSubtitlePreferences(" en , pt_br,en.forced", "avoid")).toEqual({
      preferences: [
        { language: "en", forced: false, hearingImpaired: "avoid" },
        { language: "pt-BR", forced: false, hearingImpaired: "avoid" },
        { language: "en", forced: true, hearingImpaired: "avoid" },
      ],
      invalid: [],
    });
  });

  it("reports what it can't use instead of dropping it", () => {
    expect(parseSubtitlePreferences("en,xx,en,fr.sdh,de.forced.x", "any")).toEqual({
      preferences: [{ language: "en", forced: false, hearingImpaired: "any" }],
      invalid: ["xx", "en", "fr.sdh", "de.forced.x"],
    });
  });
});
