import { STARTER_PROMPTS, validatePrompt, type PromptCategoryId, type PromptItem } from "@dash-ai/contracts";
import { Store } from "./store";

/**
 * The prompts someone wrote and the ones they starred, kept in this browser like Android keeps them on
 * the device. They belong to one account (or to Demo Mode): another account never sees them, and
 * signing out removes them, as on Android.
 */
export interface PromptData {
  custom: PromptItem[];
  favorites: string[];
}

const KEY = "dash.prompts.v1";
const EMPTY: PromptData = { custom: [], favorites: [] };

interface Saved extends PromptData {
  owner: string;
}

function read(storage: Storage, owner: string): PromptData {
  try {
    const saved = JSON.parse(storage.getItem(KEY) ?? "null") as Saved | null;
    if (!saved || saved.owner !== owner || !Array.isArray(saved.custom) || !Array.isArray(saved.favorites)) return EMPTY;
    return {
      custom: saved.custom.filter((p) => typeof p?.id === "string" && validatePrompt(p.title ?? "", p.body ?? "") === null).map((p) => ({ ...p, isCustom: true })),
      favorites: saved.favorites.filter((f) => typeof f === "string"),
    };
  } catch {
    return EMPTY;
  }
}

export class PromptsModel {
  readonly state: Store<PromptData>;

  constructor(
    private readonly storage: Storage,
    private owner: () => string,
  ) {
    this.state = new Store(read(storage, owner()));
  }

  /** Starters first, then the person's own prompts. */
  all(): PromptItem[] {
    return [...STARTER_PROMPTS, ...this.state.value.custom];
  }

  /** The account changed: show only that account's prompts. */
  reload(): void {
    this.state.set(read(this.storage, this.owner()));
  }

  /** Removes this account's prompts from the browser (sign-out). */
  clear(): void {
    try {
      this.storage.removeItem(KEY);
    } catch {
      // Storage unavailable: nothing was kept.
    }
    this.state.set(EMPTY);
  }

  toggleFavorite(id: string): void {
    this.update((d) => ({ ...d, favorites: d.favorites.includes(id) ? d.favorites.filter((f) => f !== id) : [...d.favorites, id] }));
  }

  /** Saves a new or edited prompt. Returns an error message, or null when saved. */
  save(input: { id?: string; title: string; body: string; category: PromptCategoryId }, now = Date.now()): string | null {
    const error = validatePrompt(input.title, input.body);
    if (error) return error;
    const prompt: PromptItem = {
      id: input.id ?? `custom-${crypto.randomUUID()}`,
      title: input.title.trim(),
      body: input.body.trim(),
      category: input.category,
      isCustom: true,
      updatedAt: now,
    };
    this.update((d) => ({ ...d, custom: d.custom.some((p) => p.id === prompt.id) ? d.custom.map((p) => (p.id === prompt.id ? prompt : p)) : [...d.custom, prompt] }));
    return null;
  }

  remove(id: string): void {
    this.update((d) => ({ custom: d.custom.filter((p) => p.id !== id), favorites: d.favorites.filter((f) => f !== id) }));
  }

  private update(change: (d: PromptData) => PromptData): void {
    this.state.set(change);
    try {
      const saved: Saved = { owner: this.owner(), ...this.state.value };
      this.storage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Storage full or blocked: the change still applies for this visit.
    }
  }
}
