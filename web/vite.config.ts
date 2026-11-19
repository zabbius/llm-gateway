import { defineConfig } from "vite";

/**
 * The SPA builds for the /ui namespace (ADR-006): every asset URL the emitted
 * index.html carries — bundled module scripts and public files alike — resolves
 * under /ui/. The gateway serves the build output there
 * (src/httpapi/app.ts: the /ui prefix is a namespace, not a directory level),
 * and the vite dev server hosts the app under /ui/ the same way.
 */
export default defineConfig({
  base: "/ui/",
});
