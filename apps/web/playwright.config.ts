import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a real DASH AI API (PROVIDER_MODE=fake) and the built web app
 * (`vite preview`, which proxies /v1 to the API). Start both first; see docs/web-app.md.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.DASH_WEB_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    { name: "desktop", use: { viewport: { width: 1280, height: 820 }, browserName: "chromium" } },
  ],
});
