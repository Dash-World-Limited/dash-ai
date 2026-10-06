import { expect, test, type Page } from "@playwright/test";

// Real-world conditions: stopping, losing the connection mid-answer, an expired session, files that
// cannot be used, and using the app with the keyboard only. Runs against the real API (fake providers).

function uniqueEmail() {
  return `robust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function start(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByTestId("get-started").click();
}

async function register(page: Page) {
  await start(page);
  await page.getByTestId("tab-create").click();
  await page.getByLabel("Your name").fill("Kemi Ade");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

async function ask(page: Page, text: string) {
  await page.getByTestId("home-input").fill(text);
  await page.getByTestId("home-send").click();
}

test("stop keeps what arrived; a lost connection ends the answer with Retry, which works once back online", async ({ page, context }) => {
  await register(page);
  await ask(page, "[[fake:slow]] Tell me about Lagos");
  const answer = page.getByTestId("assistant-message").last();
  await expect(answer).not.toBeEmpty();
  await expect(page.getByTestId("stop")).toBeVisible();
  await page.getByTestId("stop").click();
  await expect(answer).toContainText("Stopped");
  await expect(page.getByTestId("send")).toBeVisible();

  // Mid-answer the connection drops: the answer ends now (not minutes later), the text is kept.
  await page.getByTestId("composer-input").fill("[[fake:slow]] And about Abuja?");
  await page.getByTestId("send").click();
  const second = page.getByTestId("assistant-message").last();
  await expect(page.getByTestId("stop")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-banner")).toBeVisible();
  // The answer ends at once; while offline its card says so and offers no action that needs a connection.
  await expect(page.getByTestId("stop")).toHaveCount(0);
  await expect(second.getByTestId("recovery-card")).toContainText("You're offline");
  await expect(page.getByTestId("send")).toBeDisabled();

  await context.setOffline(false);
  await expect(page.getByTestId("offline-banner")).toHaveCount(0);
  await expect(second).toContainText("connection was lost");
  await second.getByTestId("recovery-retry").click();
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").last().getByTestId("recovery-card")).toHaveCount(0);
  await expect(page.getByTestId("assistant-message").last().getByTestId("source-label")).toBeVisible();
});

test("an expired session signs out cleanly with an explanation", async ({ page }) => {
  await register(page);
  // The session ends elsewhere (e.g. "sign out everywhere" on another device).
  const token = await page.evaluate(() => sessionStorage.getItem("dash.session") ?? localStorage.getItem("dash.session"));
  expect(token).toBeTruthy();
  const res = await page.request.post("/v1/auth/logout-all", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status()).toBe(204);

  await ask(page, "Are you there?");
  await expect(page.getByTestId("auth")).toBeVisible();
  await expect(page.getByText("Your session has ended. Sign in again.")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("dash.session") ?? localStorage.getItem("dash.session"))).toBeNull();
});

test("files that cannot be used are explained and never block the message", async ({ page }) => {
  await start(page);
  await page.getByTestId("continue-demo").click();
  await page.goto("/chat");
  await page.getByTestId("file-input").setInputFiles({ name: "setup.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
  const chip = page.getByTestId("attachment");
  await expect(chip).toHaveClass(/bad/);
  await expect(chip).not.toContainText("Uploading");
  await page.getByTestId("file-input").setInputFiles({ name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
  await expect(page.getByTestId("attachment").nth(1)).toHaveClass(/bad/);
  await page.getByTestId("composer-input").fill("Hello");
  await expect(page.getByTestId("send")).toBeEnabled();
  await chip.getByRole("button").first().click();
  await expect(page.getByTestId("attachment")).toHaveCount(1);
});

test("keyboard: skip link, sheets that keep focus and close on Escape, Enter sends", async ({ page }) => {
  await start(page);
  await page.getByTestId("continue-demo").click();
  await expect(page.getByTestId("home")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  await page.goto("/chat");
  await page.getByTestId("provider-chip").focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByTestId("provider-sheet");
  await expect(sheet).toBeVisible();
  for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByTestId("provider-chip")).toBeFocused();

  await page.getByTestId("composer-input").focus();
  await page.keyboard.type("Plan my week");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("user-message")).toContainText("Plan my week");

  if (await page.getByTestId("open-menu").isVisible()) {
    await page.getByTestId("open-menu").click();
    await expect(page.getByTestId("history-search")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("open-menu")).toBeFocused();
  }
});
