import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // Served by apps/server under /web (Jellyfin's own web-client path — Jellyfin Mobile
    // loads the server root, which redirects here).
    paths: { base: "/web" },
  },
};

export default config;
