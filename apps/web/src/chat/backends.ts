import type { ChatStreamRequest, Conversation, ConversationMessage, StreamEvent } from "@dash-ai/contracts";
import { ApiError, type DashApi } from "../api/client";
import { readEvents } from "../api/sse";
import { newId } from "./engine";
import type { ChatBackend, ChatMsg } from "./types";

/** Conversations and answers from the DASH AI API (the server is the source of truth). */
export class LiveBackend implements ChatBackend {
  readonly demo = false;

  constructor(private readonly api: DashApi) {}

  async list(): Promise<Conversation[]> {
    return (await this.api.conversations()).conversations;
  }

  async get(id: string) {
    try {
      return await this.api.conversation(id);
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_found") return null;
      throw e;
    }
  }

  async *stream(request: ChatStreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const body = await this.api.openStream(request, signal);
    yield* readEvents(body);
  }

  async cancel(streamId: string): Promise<void> {
    await this.api.cancelStream(streamId);
  }

  async rename(id: string, title: string): Promise<void> {
    await this.api.renameConversation(id, title);
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteConversation(id);
  }
}

/** Simulated problems Demo Mode can show: a lost connection, or DASH AI failing to finish an answer. */
export type DemoFailure = "none" | "connection" | "service";

const DEMO_KEY = "dash.demo.conversations";

interface StoredDemo {
  conversation: Conversation;
  messages: ConversationMessage[];
}

function readDemo(storage: Storage): StoredDemo[] {
  try {
    const parsed = JSON.parse(storage.getItem(DEMO_KEY) ?? "[]") as StoredDemo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });

/** The clearly labelled simulated answer (same wording as the Android Demo Mode). */
export function demoAnswer(request: ChatStreamRequest): string {
  const firstLine = request.message.content.split("\n").find((l) => l.trim())?.trim() ?? "your request";
  const topic = firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
  const label = "**Demo response · simulated by DASH AI.** This is not a real answer. Nothing was sent anywhere — Demo Mode runs entirely in this browser.";
  const voice = "Here is how DASH AI lays out an answer once you're signed in.";
  const bodies: Record<string, string> = {
    general:
      "### What a live answer includes\n\n- A direct answer to your question, written for the mode you picked\n- Clear structure: short paragraphs, **key points** in bold, and lists where they help\n- Follow-up suggestions you can use to continue\n\nDemo Mode lets you try streaming, stopping, regenerating and editing without an account.",
    business:
      "## Plan outline (illustrative)\n\n1. **Objective** — the outcome and how it will be measured\n2. **Customer** — who buys, why, and what they pay today\n3. **Offer and pricing** — options with their trade-offs\n4. **Risks** — what could go wrong and early warning signs\n\n| Phase | Focus | Timing |\n| --- | --- | ---: |\n| 1 | Validate demand | Weeks 1–4 |\n| 2 | Pilot and price test | Weeks 5–8 |\n| 3 | Launch and measure | Weeks 9–12 |\n\n_Figures and timings above are placeholders, not analysis._",
    writing:
      "### Draft (placeholder text)\n\n> Thank you for your time today. I'm writing to follow up on our conversation and to share the next steps we agreed.\n\nA live answer would match your tone, audience and length, then offer optional edits:\n\n- Make it shorter\n- Make it more formal\n- Add a clear call to action",
    research:
      "**Live web research is not connected.** Even live answers use the model's built-in knowledge, which may be out of date.\n\n### Research outline (illustrative)\n\n1. Key concepts and definitions\n2. Main viewpoints and where they disagree\n3. What to verify with current sources",
    documents:
      "**Demo Mode cannot read documents.** With a live DASH AI server, DASH AI reads TXT, DOCX and text-based PDFs you attach and uses them to answer.",
  };
  const code = /\b(code|kotlin|python|javascript|typescript|function|sql)\b/i.test(request.message.content)
    ? "\n\n### Example code block\n\n```ts\nfunction greet(name: string): string {\n  return `Hello, ${name}. This snippet is a demo.`;\n}\n```"
    : "";
  return `${label}\n\nYou asked about: *${topic.replace(/\*/g, "")}*. ${voice}\n\n${bodies[request.mode]}${code}\n\n---\n\nTo get real answers, sign in to DASH AI.`;
}

/**
 * Demo Mode: answers are simulated in this browser and conversations are kept in this browser's
 * storage, separate from any account. Nothing is sent to the server or anywhere else.
 */
export class DemoBackend implements ChatBackend {
  readonly demo = true;

  constructor(
    private readonly storage: Storage,
    private readonly failure: () => DemoFailure = () => "none",
    private readonly delayMs = 18,
  ) {}

  async list(): Promise<Conversation[]> {
    return readDemo(this.storage).map((d) => d.conversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string) {
    return readDemo(this.storage).find((d) => d.conversation.id === id) ?? null;
  }

  async *stream(request: ChatStreamRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const failure = this.failure();
    if (failure === "connection") {
      await sleep(this.delayMs * 10, signal);
      throw new ApiError("network", "Demo Mode simulated a connection problem. Turn off simulated errors in Settings to continue.", true);
    }
    const streamId = newId("s");
    const messageId = newId("a");
    yield {
      event: "stream.start",
      data: { streamId, conversationId: request.conversationId, modelChoice: "smart", compareGroupId: null, targets: [{ messageId, demo: true }], routingReason: "Demo Mode" },
    };
    if (failure === "service") {
      await sleep(this.delayMs * 8, signal);
      yield {
        event: "message.error",
        data: {
          messageId,
          error: { code: "provider_error", message: "Demo Mode simulated DASH AI not completing a response so you can see how failures look.", retryable: true },
          recovery: { attempts: 1, alternatives: [] },
        },
      };
    } else {
      const words = demoAnswer(request).match(/\S+\s*|\s+/g) ?? [];
      for (let w = 0; w < words.length; w += 2) {
        await sleep(this.delayMs, signal);
        yield { event: "message.delta", data: { messageId, text: words.slice(w, w + 2).join("") } };
      }
      yield { event: "message.end", data: { messageId, finishReason: "stop", usage: { inputTokens: null, outputTokens: null } } };
    }
    const title = request.message.content.trim().split(/\s+/).slice(0, 7).join(" ");
    yield { event: "conversation.title", data: { conversationId: request.conversationId, title: title[0]!.toUpperCase() + title.slice(1) } };
    yield { event: "stream.end", data: { streamId } };
  }

  async cancel(): Promise<void> {}

  async rename(id: string, title: string): Promise<void> {
    this.write(readDemo(this.storage).map((d) => (d.conversation.id === id ? { ...d, conversation: { ...d.conversation, title } } : d)));
  }

  async remove(id: string): Promise<void> {
    this.write(readDemo(this.storage).filter((d) => d.conversation.id !== id));
  }

  save(conversation: Conversation, messages: ChatMsg[]): void {
    const stored: ConversationMessage[] = messages
      .filter((m) => m.status !== "streaming")
      .map((m) => ({ id: m.id, role: m.role, content: m.content, origin: null, model: null, demo: true, status: m.status === "complete" ? "complete" : m.status === "stopped" ? "stopped" : "failed", compareGroupId: null, createdAt: m.createdAt }));
    const others = readDemo(this.storage).filter((d) => d.conversation.id !== conversation.id);
    this.write([{ conversation: { ...conversation, updatedAt: new Date().toISOString() }, messages: stored }, ...others].slice(0, 200));
  }

  private write(items: StoredDemo[]): void {
    try {
      this.storage.setItem(DEMO_KEY, JSON.stringify(items));
    } catch {
      // Storage full or blocked: Demo Mode still works for this session.
    }
  }
}

export function clearDemoData(storage: Storage): void {
  storage.removeItem(DEMO_KEY);
}
