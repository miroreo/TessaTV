// @ts-check
import js from "@eslint/js";
import boundaries from "eslint-plugin-boundaries";
import tseslint from "typescript-eslint";

// Mirrors the package dependency graph from the architecture plan: `domain` depends on
// nothing; everything else depends inward on `domain`'s interfaces; `jellyfin-compat` is
// kept decoupled from acquisition entirely so the Jellyfin-API surface never gets tangled
// with indexer/download-client logic.
const elementTypes = [
  { type: "domain", pattern: "packages/domain/**" },
  { type: "config", pattern: "packages/config/**" },
  { type: "shared", pattern: "packages/shared/**" },
  { type: "persistence", pattern: "packages/persistence/**" },
  { type: "metadata", pattern: "packages/metadata/**" },
  { type: "library", pattern: "packages/library/**" },
  { type: "streaming", pattern: "packages/streaming/**" },
  { type: "jobs", pattern: "packages/jobs/**" },
  { type: "indexers", pattern: "packages/indexers/**" },
  { type: "download-clients", pattern: "packages/download-clients/**" },
  { type: "acquisition", pattern: "packages/acquisition/**" },
  { type: "jellyfin-compat", pattern: "packages/jellyfin-compat/**" },
  { type: "app", pattern: "apps/**" },
];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/elements": elementTypes,
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: ["packages/*/tsconfig.json", "packages/*/*/tsconfig.json", "apps/*/tsconfig.json"],
        },
      },
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            { from: "domain", allow: [] },
            { from: "config", allow: [] },
            { from: "shared", allow: [] },
            { from: "persistence", allow: ["domain"] },
            { from: "metadata", allow: ["domain"] },
            { from: "streaming", allow: ["domain"] },
            { from: "jobs", allow: ["domain"] },
            { from: "library", allow: ["domain", "metadata"] },
            { from: "indexers", allow: ["domain"] },
            { from: "download-clients", allow: ["domain"] },
            { from: "acquisition", allow: ["domain", "indexers", "download-clients", "library", "metadata", "jobs"] },
            { from: "jellyfin-compat", allow: ["domain", "streaming"] },
            { from: "app", allow: ["*"] },
          ],
        },
      ],
    },
  },
  {
    ignores: ["**/dist/**", "**/.turbo/**", "**/.svelte-kit/**", "**/build/**", "**/node_modules/**"],
  },
);
