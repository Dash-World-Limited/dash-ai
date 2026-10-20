import { afterEach, describe, expect, it, vi } from "vitest";
import type { TokenStore } from "../api/client";
import { AppModel } from "./app";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

/** One "remember me" token shared by every tab of the browser, as localStorage is. */
class SharedTokens implements TokenStore {
  value: string | null = null;
  get() { return this.value; }
  set(token: string | null) { this.value = token; }
}

const A = { id: "user-a", email: "a@example.com", displayName: "Ada" };
const calls: string[] = [];

function stubFetch(status: (url: string) => number) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const code = status(url);
    const body = code >= 400 ? { error: { code: code === 401 ? "unauthorized" : "internal_error", message: "No.", retryable: false } } : {};
    return new Response(code === 204 ? null : JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe("AppModel sessions", () => {
  it("notices when another tab signs in as someone else or signs out, so this tab never acts as another account", () => {
    stubFetch(() => 200);
    const tokens = new SharedTokens();
    const tab = new AppModel(new MemoryStorage(), tokens);
    tab.signedIn("token-a", A, true);
    expect(tab.sessionChangedElsewhere()).toBe(false);
    tokens.set("token-b"); // the other tab signed in as B
    expect(tab.sessionChangedElsewhere()).toBe(true);
    tokens.set(null); // or signed out
    expect(tab.sessionChangedElsewhere()).toBe(true);
    tokens.set("token-a");
    expect(tab.sessionChangedElsewhere()).toBe(false);
  });

  it("after the account is deleted it says so, sends nothing more, and leaves nothing signed in", () => {
    stubFetch(() => 200);
    const model = new AppModel(new MemoryStorage(), new SharedTokens());
    model.signedIn("token-a", A, true);
    calls.length = 0;
    model.accountDeleted();
    expect(model.live).toBe(false);
    expect(model.tokens.get()).toBeNull();
    expect(model.toast.value).toBe("Your account and its data were deleted.");
    expect(calls.filter((c) => c.includes("/v1/auth/"))).toEqual([]);
  });

  it("a wrong password typed while signed in does not end the current session", async () => {
    stubFetch((url) => (url.endsWith("/v1/auth/login") ? 401 : 200));
    const model = new AppModel(new MemoryStorage(), new SharedTokens());
    model.signedIn("token-a", A, true);
    await expect(model.api.login("a@example.com", "wrong password")).rejects.toMatchObject({ code: "unauthorized" });
    expect(model.live).toBe(true);
    expect(model.tokens.get()).toBe("token-a");
  });
});
