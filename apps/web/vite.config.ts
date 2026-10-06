import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Production builds get a strict Content-Security-Policy: only this origin for scripts, styles,
 * API calls and images, no third-party code. (Not in dev: the dev server injects an inline script.)
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";

function contentSecurityPolicy(): Plugin {
  return {
    name: "dash-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<title>", `<meta http-equiv="Content-Security-Policy" content="${CSP}" />\n    <title>`),
  };
}

/**
 * The web app talks to the DASH AI API on the same origin (`/v1`, `/health`). In development Vite
 * proxies those paths to a local API (DASH_API_PROXY, default http://127.0.0.1:8787); in production
 * a reverse proxy serves both from one origin (see docs/web-app.md), so no CORS is needed.
 */
const apiTarget = process.env.DASH_API_PROXY ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    port: 5173,
    proxy: { "/v1": { target: apiTarget, changeOrigin: false }, "/health": apiTarget },
  },
  preview: {
    port: 4173,
    proxy: { "/v1": { target: apiTarget, changeOrigin: false }, "/health": apiTarget },
  },
  build: { sourcemap: false, target: "es2022" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
