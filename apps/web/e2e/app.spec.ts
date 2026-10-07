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

/**
 * Words a consumer must never see: DASH AI is the product; its AI infrastructure is internal. The
 * privacy disclosure ("third-party artificial-intelligence service providers") is allowed by design.
 */
const PROVIDER_WORDS = /\b(openai|chatgpt|gpt[-\s]?\d|anthropic|claude|gemini|google ai|dash smart)\b|\b(ai|change|another|other|default) providers?\b|\bcompare (mode|answers|providers)\b/i;

/** Visible text plus accessible names, titles and alt text on the current page. */
async function consumerText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts = [document.body.innerText, document.title];
    for (const el of Array.from(document.querySelectorAll("[aria-label],[title],[alt],[placeholder]"))) {
      for (const attr of ["aria-label", "title", "alt", "placeholder"]) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    return parts.join("\n");
  });
}

async function expectNoProviderWords(page: Page, where: string) {
  const text = await consumerText(page);
  expect(text.match(PROVIDER_WORDS)?.[0] ?? null, `provider wording on ${where}`).toBeNull();
}

test("DASH AI only: no provider choice, label or Compare anywhere a person can see", async ({ page }) => {
  await enterDemo(page);
  await expectNoProviderWords(page, "home");
  await page.getByTestId("quick-write").click();
  await expect(page.getByTestId("empty-chat")).toContainText("Writing");
  await expect(page.getByTestId("provider-chip")).toHaveCount(0);
  await expect(page.getByTestId("recipient")).toContainText("Demo Mode");
  await page.getByTestId("composer-input").fill("Plan a calm week");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("assistant-message")).toContainText("Demo response · simulated by DASH AI", { timeout: 20_000 });
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("compare-row")).toHaveCount(0);
  await expectNoProviderWords(page, "chat");
  await page.getByTestId("mode-chip").click();
  await expect(page.getByTestId("mode-sheet")).toBeVisible();
  await shot(page, "06-mode-sheet");
  await expectNoProviderWords(page, "mode sheet");
  await page.keyboard.press("Escape");
  for (const route of ["/settings", "/account", "/tools", "/documents", "/prompts", "/automates"]) {
    await page.goto(route);
    await expect(page.locator("#main")).toBeVisible();
    await expectNoProviderWords(page, route);
  }
  await page.goto("/settings");
  await expect(page.getByTestId("settings")).toBeVisible();
  for (const gone of ["default-smart", "default-openai", "default-claude"]) await expect(page.getByTestId(gone)).toHaveCount(0);
});

test("DASH AI failure: neutral recovery with Retry and Continue later; no other provider offered", async ({ page }) => {
  await enterDemo(page);
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("demo-failure-service").click();
  await page.goto("/chat");
  await page.getByTestId("composer-input").fill("Hello");
  await page.getByTestId("send").click();
  const card = page.getByTestId("recovery-card");
  await expect(card).toContainText("DASH AI couldn't complete that response", { timeout: 20_000 });
  await expect(page.getByTestId("recovery-retry")).toBeVisible();
  await expect(page.getByTestId("recovery-change")).toHaveCount(0);
  await expectNoProviderWords(page, "recovery");
  await shot(page, "07-recovery");
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
  await expect(page.getByTestId("assistant-message").getByTestId("source-label")).toContainText("DASH AI");
  await expectNoProviderWords(page, "live chat");
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

test("live: Automates schedule, run on the server, notify, then view, edit, regenerate, download and share", async ({ page }) => {
  await register(page, "Chidi Okafor");
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-automates").click();
  await expect(page.getByTestId("automates-empty")).toBeVisible();
  await page.getByTestId("new-automation").click();
  await page.getByTestId("automation-name").fill("Morning brief");
  await page.getByTestId("automation-prompt").fill("Draft three priorities for my day.");
  await page.getByTestId("repeat-weekly").click();
  await page.getByTestId("automation-time").fill("08:00");
  await expect(page.getByTestId("automation-editor")).toContainText("Weekdays at 08:00");
  await shot(page, "20-automation-editor");
  await page.getByTestId("save-automation").click();
  await expect(page.getByTestId("automation-detail")).toContainText("Scheduled");
  await expect(page.getByTestId("next-run")).toContainText("Next run:");
  await expect(page.getByTestId("last-run")).toContainText("Not run yet.");

  await page.getByTestId("run-now").click();
  await expect(page.getByTestId("run-item").first()).toContainText("Ready", { timeout: 20_000 });
  await expect(page.getByTestId("automation-detail")).toContainText("Ready");
  await expect(page.getByTestId("last-run")).toContainText("Last run:");
  await shot(page, "21-automation-detail");
  await expectNoProviderWords(page, "automation detail");

  // The finished run left a notice: it opens the result and is then read.
  await page.goto("/automates");
  await expect(page.getByTestId("notifications")).toContainText("Morning brief is ready");
  await shot(page, "22-automates");
  await page.getByTestId("notification").first().click();
  await expect(page.getByTestId("run-content")).toContainText("Demonstration answer from DASH AI");
  await expectNoProviderWords(page, "automation result");
  await shot(page, "23-automation-result");

  const download = page.waitForEvent("download");
  await page.getByTestId("run-download").click();
  expect((await download).suggestedFilename()).toMatch(/^morning-brief-\d{4}-\d{2}-\d{2}\.md$/);
  await page.getByTestId("run-share").click(); // the device share sheet, or a copy where there is none

  await page.getByTestId("run-edit").click();
  await page.getByTestId("run-editor").fill("# My priorities\n\n1. Ship the brief");
  await page.getByTestId("save-run").click();
  await expect(page.getByTestId("run-content")).toContainText("Ship the brief");
  await page.reload();
  await expect(page.getByTestId("run-content")).toContainText("Ship the brief");

  await page.getByTestId("run-regenerate").click();
  await expect(page.getByTestId("automation-detail")).toBeVisible();
  await expect(page.getByTestId("run-item")).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId("run-item").first()).toContainText("Ready", { timeout: 20_000 });

  await page.getByTestId("pause").click();
  await expect(page.getByTestId("next-run")).toContainText("Paused");
  await page.getByTestId("resume").click();
  await expect(page.getByTestId("next-run")).toContainText("Next run:");
  await page.getByTestId("delete-automation").click();
  await page.getByTestId("confirm").click();
  await expect(page.getByTestId("automates-empty")).toBeVisible();
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

test("prompt library: same starters as Android, favourites, my prompts, use a prompt; kept per account", async ({ page }) => {
  await enterDemo(page);
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-prompts").click();
  await expect(page.getByTestId("prompt-card")).toHaveCount(29);
  await page.getByTestId("prompt-search").fill("swot");
  await expect(page.getByTestId("prompt-card")).toHaveCount(1);
  await page.getByTestId("prompt-favorite").click();
  await page.getByTestId("prompt-search").fill("");
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await expect(page.getByTestId("prompt-card")).toHaveCount(1);
  await expect(page.getByTestId("prompt-card")).toContainText("SWOT analysis");

  // A prompt of my own: validated like on Android, kept in this browser.
  await page.getByTestId("new-prompt").click();
  await page.getByTestId("save-prompt").click();
  await expect(page.getByTestId("prompt-error")).toHaveText("Give the prompt a title.");
  await page.getByTestId("prompt-title-input").fill("Supplier follow-up");
  await page.getByTestId("prompt-category").selectOption("writing");
  await page.getByTestId("prompt-body-input").fill("Write a polite follow-up to [supplier] about the late [order].");
  await page.getByTestId("save-prompt").click();
  await page.getByRole("button", { name: "My prompts", exact: true }).click();
  await expect(page.getByTestId("prompt-card")).toHaveCount(1);
  await expect(page.getByTestId("prompt-card")).toContainText("Writing · My prompt");
  await shot(page, "15-prompts");
  await page.reload();
  await page.getByRole("button", { name: "My prompts", exact: true }).click();
  await expect(page.getByTestId("prompt-card")).toContainText("Supplier follow-up");

  // Use it: a new chat in the prompt's mode with the text ready to edit.
  await page.getByTestId("use-prompt").click();
  await expect(page.getByTestId("composer-input")).toHaveValue("Write a polite follow-up to [supplier] about the late [order].");
  await expect(page.getByTestId("mode-chip")).toContainText("Writing");
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
