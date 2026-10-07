import type { DocumentResponse } from "@dash-ai/contracts";
import { checkFile } from "@dash-ai/contracts";
import { ApiError, type DashApi } from "../api/client";
import { newId } from "../chat/engine";
import { Store } from "./store";

/** A document as the library shows it. Demo documents are checked in this browser only, never read or uploaded. */
export interface DocItem extends Omit<DocumentResponse, "status"> {
  status: "ready" | "unsupported" | "demo";
  demo: boolean;
}

const DEMO_DOCS = "dash.demo.documents";

function readDemoDocs(storage: Storage): DocItem[] {
  try {
    const parsed = JSON.parse(storage.getItem(DEMO_DOCS) ?? "[]") as DocItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export class DocumentsModel {
  readonly state = new Store<{ items: DocItem[]; loading: boolean; error: string | null; loaded: boolean }>({ items: [], loading: false, error: null, loaded: false });

  constructor(
    private readonly api: DashApi,
    private readonly storage: Storage,
    private readonly live: () => boolean,
  ) {}

  reset(): void {
    this.state.set({ items: [], loading: false, error: null, loaded: false });
  }

  async refresh(): Promise<void> {
    this.state.set((s) => ({ ...s, loading: true, error: null }));
    try {
      const items = this.live() ? (await this.api.documents()).documents.map((d) => ({ ...d, demo: false })) : readDemoDocs(this.storage);
      this.state.set({ items, loading: false, error: null, loaded: true });
    } catch (e) {
      this.state.set((s) => ({ ...s, loading: false, loaded: true, error: e instanceof ApiError ? e.message : "Couldn't load your documents." }));
    }
  }

  /** Validates, then uploads (live) or records the file's details (Demo Mode). Throws ApiError with a user-safe message. */
  async upload(file: File, onProgress: (f: number) => void): Promise<DocItem> {
    const check = checkFile(file.name, file.type || "application/octet-stream", file.size);
    if (!check.ok) throw new ApiError(check.code, check.message, false);
    let item: DocItem;
    if (this.live()) {
      const d = await this.api.uploadDocument(file, onProgress);
      item = { ...d, demo: false };
    } else {
      for (let i = 1; i <= 5; i++) {
        await new Promise((r) => setTimeout(r, 60));
        onProgress(i / 5);
      }
      item = {
        id: newId("d"), name: file.name, kind: check.kind, mimeType: file.type, sizeBytes: file.size, status: "demo",
        statusDetail: "Demo Mode: checked in this browser only. The contents were not uploaded or read.", extractedChars: 0, pageCount: null,
        createdAt: new Date().toISOString(), demo: true,
      };
      try {
        this.storage.setItem(DEMO_DOCS, JSON.stringify([item, ...readDemoDocs(this.storage)].slice(0, 200)));
      } catch {
        // Storage full: the document still works for this visit.
      }
    }
    this.state.set((s) => ({ ...s, items: [item, ...s.items.filter((d) => d.id !== item.id)] }));
    return item;
  }

  async remove(item: DocItem): Promise<void> {
    if (item.demo) {
      this.storage.setItem(DEMO_DOCS, JSON.stringify(readDemoDocs(this.storage).filter((d) => d.id !== item.id)));
    } else {
      await this.api.deleteDocument(item.id);
    }
    this.state.set((s) => ({ ...s, items: s.items.filter((d) => d.id !== item.id) }));
  }

  clearDemo(): void {
    this.storage.removeItem(DEMO_DOCS);
  }
}

/** Live chats can only use documents whose text the server extracted; Demo Mode only its own. */
export function usableInChat(d: DocItem, demoMode: boolean): boolean {
  return demoMode ? d.demo : d.status === "ready" && !d.demo;
}

export function documentStatus(d: DocItem): { text: string; tone: "success" | "warning" | "neutral" } {
  if (d.status === "ready") return { text: "Ready", tone: "success" };
  if (d.status === "unsupported") return { text: "Unsupported", tone: "warning" };
  return { text: "Demo · not uploaded", tone: "neutral" };
}
