import { Store, useStore } from "./store";

/** Paths: /, /welcome, /sign-in, /chat, /chat/:id, /documents, /documents/:id, /prompts, /tools, /account, /settings. */
export const route = new Store<string>(typeof location === "undefined" ? "/" : location.pathname);

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => route.set(location.pathname));
}

export function navigate(path: string, replace = false): void {
  if (path === route.value) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  route.set(path);
  window.scrollTo(0, 0);
}

export function back(fallback = "/"): void {
  if (history.length > 1) history.back();
  else navigate(fallback, true);
}

export function useRoute(): { path: string; parts: string[] } {
  const path = useStore(route);
  return { path, parts: path.split("/").filter(Boolean) };
}
