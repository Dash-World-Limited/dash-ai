import { expect, test, type Page } from "@playwright/test";

const shots = process.env.DASH_SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.screenshot({ path: `${shots}/${test.info().project.name}-${name}.png`, fullPage: false });
}

/** A fresh browser profile each test: first visit, no session. */
async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("splash")).toBeVisible();
  await expect(page.getByTestId("onboarding")).toBeVisible();
}

async function enterDemo(page: Page) {
  await start(page);
  await page.getByTestId("get-started").click();
  await page.getByTestId("continue-demo").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

function uniqueEmail() {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function register(page: Page, name = "Ngozi Adeyemi") {
  await start(page);
  await page.getByTestId("get-started").click();
  await page.getByTestId("tab-create").click();
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

async function openMenuIfNeeded(page: Page) {
  if (await page.getByTestId("open-menu").isVisible()) await page.getByTestId("open-menu").click();
}

test("first visit: brand splash, one onboarding screen, then email/password or Demo Mode only", async ({ page }) => {
  await start(page);
  await expect(page.getByRole("heading", { name: "What are we building today?" })).toBeVisible();
  await expect(page.getByText("Get answers faster")).toBeVisible();
  await shot(page, "01-onboarding");
  await page.getByTestId("get-started").click();
  await expect(page.getByTestId("auth")).toBeVisible();
  for (const absent of ["Google", "Microsoft", "Apple"]) await expect(page.getByText(absent)).toHaveCount(0);
  await page.getByTestId("auth-submit").click();
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await expect(page.getByText("Enter your password.")).toBeVisible();
  await shot(page, "02-sign-in");
  // Returning visitors skip onboarding.
  await page.reload();
  await expect(page.getByTestId("auth")).toBeVisible();
});

test("Demo Mode: simulated, labelled answers that stay in the browser", async ({ page }) => {
  await enterDemo(page);
  await expect(page.getByTestId("greeting")).not.toContainText("Demo user");
  await expect(page.getByTestId("home-empty")).toBeVisible();
  await shot(page, "03-home-demo");
  await page.getByTestId("home-input").fill("Draft a launch plan for a coffee pop-up");
  await page.getByTestId("home-send").click();
  await expect(page.getByTestId("demo-banner")).toBeVisible();
  await expect(page.getByTestId("assistant-message")).toContainText("Demo response · simulated", { timeout: 20_000 });
  await expect(page.getByTestId("source-label").first()).toContainText("simulated");
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("chat-title")).toContainText("Draft a launch plan");
  await shot(page, "04-chat-demo");
  // The chat is in the history, grouped under Today.
  await openMenuIfNeeded(page);
  await expect(page.getByTestId("history")).toContainText("Today");
  await expect(page.getByTestId("history-item").first()).toContainText("Draft a launch plan");
  await shot(page, "05-history");
});

test("provider sheet: real choices only, remembered, Compare confirmed", async ({ page }) => {
  await enterDemo(page);
  await page.getByTestId("quick-write").click();
  await expect(page.getByTestId("empty-chat")).toContainText("Writing");
  await page.getByTestId("provider-chip").click();
  await expect(page.getByTestId("provider-sheet")).toBeVisible();
  await shot(page, "06-provider-sheet");
  await page.getByTestId("provider-claude").click();
  await expect(page.getByTestId("provider-chip")).toContainText("Claude");
  await page.getByTestId("provider-chip").click();
  await page.getByTestId("provider-compare").click();
  await expect(page.getByTestId("compare-confirm")).toContainText("two requests");
  await page.getByTestId("confirm-compare").click();
  await expect(page.getByTestId("provider-chip")).toContainText("Compare");
  await page.getByTestId("composer-input").fill("Compare these");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("compare-row")).toBeVisible();
  await expect(page.getByTestId("compare-row")).toContainText("simulated OpenAI style", { timeout: 20_000 });
  await expect(page.getByTestId("compare-row")).toContainText("simulated Claude style", { timeout: 20_000 });
  // Remembered for new chats after a reload.
  await page.reload();
  await page.goto("/chat");
  await expect(page.getByTestId("provider-chip")).toContainText("Compare");
});

test("provider failure: retry, change provider, continue later; never switches by itself", async ({ page }) => {
  await enterDemo(page);
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("demo-failure-provider").click();
  await page.goto("/chat");
  await page.getByTestId("composer-input").fill("Hello");
  await page.getByTestId("send").click();
  const card = page.getByTestId("recovery-card");
  await expect(card).toContainText("Provider temporarily unavailable", { timeout: 20_000 });
  await expect(page.getByTestId("provider-chip")).toContainText("Dash Smart");
  await shot(page, "07-recovery");
  await page.getByTestId("recovery-change").click();
  await expect(page.getByTestId("alternative-sheet")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("recovery-later").click();
  await expect(card).toHaveCount(0);
});

test("live: account, greeting by name, streamed answer from the API, history and rename", async ({ page }) => {
  await register(page);
  await expect(page.getByTestId("greeting")).toContainText("Ngozi");
  await shot(page, "08-home-live");
  await page.getByTestId("home-input").fill("Write a short business plan");
  await page.getByTestId("home-send").click();
  await expect(page.getByTestId("assistant-message")).not.toBeEmpty();
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").getByTestId("source-label")).toContainText("OpenAI");
  await shot(page, "09-chat-live");
  // Survives a reload: the conversation is on the server.
  await page.reload();
  await expect(page.getByTestId("user-message")).toContainText("Write a short business plan");
  await openMenuIfNeeded(page);
  await page.getByRole("button", { name: /Options for/ }).first().click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByTestId("rename-input").fill("Renamed plan");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("history-item").first()).toContainText("Renamed plan");
});

test("live: documents upload, detail, ask about it; tools from the server registry; sign out everywhere", async ({ page }) => {
  await register(page, "Ada Lovelace");
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-documents").click();
  await expect(page.getByTestId("documents-empty")).toBeVisible();
  await page.getByTestId("document-file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Quarterly notes. Revenue grew. Risks: supplier delays.") });
  await expect(page.getByTestId("document-row")).toContainText("Ready", { timeout: 20_000 });
  await shot(page, "10-documents");
  await page.getByTestId("document-row").click();
  await expect(page.getByTestId("document-detail")).toContainText("Text extracted");
  await shot(page, "11-document-detail");
  await page.getByTestId("document-suggestion").first().click();
  await expect(page.getByTestId("attachment")).toContainText("notes.txt");
  await expect(page.getByTestId("composer-input")).toHaveValue("Summarise this document");

  await openMenuIfNeeded(page);
  await page.getByTestId("nav-tools").click();
  const tool = page.getByTestId("tool-connection").filter({ hasText: "Dash demo tools" });
  await expect(tool).toContainText("Available");
  // The switch flips once the server has saved the choice.
  await page.getByTestId("tool-switch-dash-demo").click({ force: true });
  await expect(tool).toContainText("Connected");
  await shot(page, "12-tools");

  await openMenuIfNeeded(page);
  await page.getByTestId("nav-account").click();
  await expect(page.getByTestId("account-name")).toHaveText("Ada Lovelace");
  await shot(page, "13-account");
  await page.getByTestId("sign-out-everywhere").click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("auth")).toBeVisible();
});

test("live: tool activity is recorded with the answer and shown again after a reload", async ({ page }) => {
  await register(page, "Tunde Bakare");
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-tools").click();
  await page.getByTestId("tool-switch-dash-demo").click({ force: true });
  await expect(page.getByTestId("tool-connection").filter({ hasText: "Dash demo tools" })).toContainText("Connected");
  await openMenuIfNeeded(page);
  await page.getByTestId("new-chat").click();
  // The fake provider asks for the built-in text_stats tool when it sees this marker.
  await page.getByTestId("composer-input").fill('[[fake:tool dash-demo__text_stats {"text":"one two three"}]]');
  await page.getByTestId("send").click();
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  const activity = page.getByTestId("assistant-message").getByTestId("tool-activity");
  await expect(activity).toContainText("Text stats");

  await page.reload();
  await expect(page.getByTestId("user-message")).toBeVisible();
  const restored = page.getByTestId("assistant-message").getByTestId("tool-activity");
  await expect(restored).toContainText("Text stats");
  await restored.getByRole("button").click();
  await expect(restored).not.toContainText("one two three"); // names and outcomes only
  await shot(page, "14-tool-history");
});

test("settings: theme switches to dark and is remembered; security wording is accurate", async ({ page }) => {
  await enterDemo(page);
  await page.goto("/settings");
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByTestId("data-protection").click();
  await expect(page.getByText("not end-to-end encryption", { exact: false })).toBeVisible();
  await shot(page, "14-settings-dark");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await shot(page, "15-home-dark");
});
