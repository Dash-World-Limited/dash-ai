import { SyncConversationsResponse, SyncPushRequest, SyncPushResponse } from "@dash-ai/contracts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// One account, two clients. The web app uses the conversation REST endpoints; the Android app uses
// sync (pull and push). The Android side here speaks its exact wire format: the shared fixtures that
// the Kotlin tests decode and encode with the app's own DTOs. A conversation started on either
// client must be readable, complete, on the other.

const fixture = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), "../../packages/contracts/fixtures", name), "utf8"));

async function register(page: Page) {
  await page.goto("/");
  await page.getByTestId("get-started").click();
  await page.getByTestId("tab-create").click();
  await page.getByLabel("Your name").fill("Chidi Obi");
  await page.getByLabel("Email").fill(`cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByTestId("auth-submit").click();
  await expect(page.getByTestId("home")).toBeVisible();
  const token = await page.evaluate(() => sessionStorage.getItem("dash.session") ?? localStorage.getItem("dash.session"));
  expect(token).toBeTruthy();
  return { authorization: `Bearer ${token}` };
}

/** What the Android app does on its next sync: pull every change after its cursor. */
async function androidPull(request: APIRequestContext, auth: Record<string, string>) {
  const res = await request.get("/v1/sync/conversations?cursor=0&limit=50", { headers: auth });
  expect(res.status()).toBe(200);
  return SyncConversationsResponse.parse(await res.json());
}

async function openMenuIfNeeded(page: Page) {
  if (await page.getByTestId("open-menu").isVisible()) await page.getByTestId("open-menu").click();
}

test("a chat started on the web reaches Android complete: messages, labels, title and tool activity", async ({ page }) => {
  const auth = await register(page);
  await openMenuIfNeeded(page);
  await page.getByTestId("nav-tools").click();
  await page.getByTestId("tool-switch-dash-demo").click({ force: true });
  await expect(page.getByTestId("tool-connection").filter({ hasText: "Dash demo tools" })).toContainText("Connected");
  await openMenuIfNeeded(page);
  await page.getByTestId("new-chat").click();
  await page.getByTestId("composer-input").fill('Count these words [[fake:tool dash-demo__text_stats {"text":"one two three"}]]');
  await page.getByTestId("send").click();
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").getByTestId("tool-activity")).toBeVisible();
  const pulled = await androidPull(page.request, auth);
  const change = pulled.changes.find((c) => c.messages[0]?.content.includes("Count these words"));
  expect(change, "the web conversation is in Android's sync").toBeTruthy();
  const conversationId = change!.conversation.id;
  expect(change!.deleted).toBe(false);
  expect(change!.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(change!.messages[0]!.content).toContain("Count these words");
  // DASH AI's answer: which AI infrastructure produced it is internal and never synced to clients.
  expect(change!.messages[1]).toMatchObject({ status: "complete", origin: null, model: null });
  expect(change!.toolActivity).toEqual([expect.objectContaining({ messageId: change!.messages[1]!.id, plugin: "dash-demo", tool: "text_stats", status: "ok" })]);

  // Renamed on the web: Android sees the new title with a newer revision, marked as the person's own.
  await openMenuIfNeeded(page);
  await page.getByRole("button", { name: /Options for/ }).first().click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByTestId("rename-input").fill("Word count from the web");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("history-item").first()).toContainText("Word count from the web");
  const renamed = (await androidPull(page.request, auth)).changes.find((c) => c.conversation.id === conversationId)!;
  expect(renamed.conversation).toMatchObject({ title: "Word count from the web", titleIsCustom: true });
  expect(renamed.conversation.titleRev).toBeGreaterThan(change!.conversation.titleRev);
});

test("a chat written on Android (offline, then synced) opens on the web, and deletes reach both", async ({ page }) => {
  const auth = await register(page);
  // Android's upload operation, exactly as the app sends it (the shared fixture), with fresh ids.
  const upload = structuredClone(fixture("sync-push-request.json").operations[0]);
  const conversationId = crypto.randomUUID();
  upload.opId = `op-${conversationId.slice(0, 12)}`;
  upload.conversation.id = conversationId;
  upload.conversation.title = "Written on the phone";
  upload.conversation.createdAt = new Date().toISOString();
  upload.messages[0].id = crypto.randomUUID();
  upload.messages[0].createdAt = upload.conversation.createdAt;
  const body = SyncPushRequest.parse({ operations: [upload] });
  const res = await page.request.post("/v1/sync/push", { headers: auth, data: body });
  expect(res.status()).toBe(200);
  expect(SyncPushResponse.parse(await res.json()).results[0]).toMatchObject({ status: "applied" });

  // The web app lists it and opens it with the phone's message.
  await page.reload();
  await openMenuIfNeeded(page);
  const item = page.getByTestId("history-item").filter({ hasText: "Written on the phone" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("user-message")).toContainText("Draft a launch checklist");

  // The web answers in the same conversation; Android's next pull carries both turns in order.
  await page.getByTestId("composer-input").fill("Add a section on suppliers");
  await page.getByTestId("send").click();
  await expect(page.getByTestId("send")).toBeVisible({ timeout: 30_000 });
  const pulled = (await androidPull(page.request, auth)).changes.find((c) => c.conversation.id === conversationId)!;
  expect(pulled.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"]);

  // Deleted on the web: Android receives a tombstone (and never resurrects it).
  await openMenuIfNeeded(page);
  await page.getByRole("button", { name: /Options for/ }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByTestId("confirm").click();
  // The delete has reached the server once the web app has removed the chat from its list.
  await openMenuIfNeeded(page);
  await expect(page.getByTestId("history-item").filter({ hasText: "Written on the phone" })).toHaveCount(0);
  const tombstone = (await androidPull(page.request, auth)).changes.find((c) => c.conversation.id === conversationId)!;
  expect(tombstone).toMatchObject({ deleted: true, messages: [], toolActivity: [] });
});
