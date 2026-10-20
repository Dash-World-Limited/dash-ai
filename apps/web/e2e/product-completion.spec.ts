import { expect, test, type Page } from "@playwright/test";

// Product completion audit regressions (docs/product-completion-audit.md), against the real API
// with fake providers: a 375 px phone, regenerating an earlier answer, and a second tab.

function uniqueEmail() {
  return `complete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function register(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.getByTestId("get-started").click();
  await page.getByTestId("tab-create").click();
  await page.getByLabel("Your name").fill("Tolu Bello");
  await page.getByLabel("Email").fill(uniqueEmail());
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("home")).toBeVisible();
}

async function answered(page: Page, count: number) {
  await expect(page.getByTestId("assistant-message")).toHaveCount(count);
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
}

test("375 px phone: a long link and long inline code never widen the page", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await register(page);
  const url = `https://example.com/${"very-long-path-segment-".repeat(12)}end`;
  await page.getByTestId("home-input").fill(`Check ${url} and \`${"x".repeat(120)}\``);
  await page.getByTestId("home-send").click();
  await answered(page, 1);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(375);
});

test("regenerating an earlier answer asks first, because the messages after it are replaced", async ({ page }) => {
  await register(page);
  await page.getByTestId("home-input").fill("First question");
  await page.getByTestId("home-send").click();
  await answered(page, 1);
  await page.getByTestId("composer-input").fill("Second question");
  await page.getByTestId("send").click();
  await answered(page, 2);

  await page.getByTestId("assistant-message").first().getByLabel("Regenerate response").click();
  await expect(page.getByRole("dialog")).toContainText("messages after it");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("user-message")).toHaveCount(2);

  // The latest answer regenerates straight away: nothing after it is lost.
  await page.getByTestId("assistant-message").last().getByLabel("Regenerate response").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await answered(page, 2);
});

test("another tab signing out takes this tab out too, instead of leaving it acting without a session", async ({ page, context }) => {
  await register(page);
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("home")).toBeVisible(); // "keep me signed in" is shared by the tabs
  await other.evaluate(() => window.localStorage.removeItem("dash.session"));
  await expect(page.getByTestId("home")).toHaveCount(0);
  await expect(page.getByTestId("onboarding").or(page.getByTestId("auth-submit"))).toBeVisible();
});
