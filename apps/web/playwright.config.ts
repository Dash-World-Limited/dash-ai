import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against a real DASH AI API (PROVIDER_MODE=fake) and the built web app
 * (`vite preview`, which proxies /v1 to the API). Start both first; see docs/web-app.md.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;
const chromium = executablePath ? { executablePath } : {};

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.DASH_WEB_URL ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium", launchOptions: chromium } },
    { name: "desktop", use: { viewport: { width: 1280, height: 820 }, browserName: "chromium", launchOptions: chromium } },
    // Firefox runs in CI (DASH_E2E_FIREFOX=1 after `playwright install firefox`). Safari/WebKit is not
    // tested: it is not claimed to work until it has been run.
    ...(process.env.DASH_E2E_FIREFOX === "1"
      ? [
          { name: "firefox-phone", use: { browserName: "firefox" as const, viewport: { width: 412, height: 860 }, hasTouch: false } },
          { name: "firefox-desktop", use: { browserName: "firefox" as const, viewport: { width: 1280, height: 820 } } },
        ]
      : []),
  ],
});
