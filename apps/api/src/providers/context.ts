import { LIMITS, type HistoryMessage, type ProviderId } from "@dash-ai/contracts";
import type { DocumentRecord } from "../store/store.js";
import type { ProviderMessage } from "./types.js";

export const MAX_DOC_CONTEXT_CHARS = 60_000;
export const MAX_TOTAL_DOC_CONTEXT_CHARS = 120_000;

/**
 * Keeps user turns and only the assistant turns produced by `provider`. Answers from the other
 * provider are never forwarded, so a provider never silently receives a competitor's output.
 */
export function filterHistoryForProvider(history: readonly HistoryMessage[], provider: ProviderId): HistoryMessage[] {
  return history.filter((m) => m.role === "user" || m.origin === provider);
}

/** Drops the oldest turns until the history fits the character budget. */
export function trimHistory(history: readonly HistoryMessage[], maxChars: number = LIMITS.maxHistoryChars): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (total + m.content.length > maxChars) break;
    kept.unshift(m);
    total += m.content.length;
  }
  return kept;
}

function escapeAttr(value: string): string {
  return value.replace(/[&"<>]/g, (c) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[c]!);
}

/** Wraps extracted document text in delimited blocks so the model can tell documents from instructions. */
export function renderDocuments(documents: readonly DocumentRecord[]): string {
  let budget = MAX_TOTAL_DOC_CONTEXT_CHARS;
  const blocks: string[] = [];
  for (const d of documents) {
    const limit = Math.min(MAX_DOC_CONTEXT_CHARS, budget);
    if (limit <= 0) break;
    const truncated = d.extractedText.length > limit;
    const text = truncated ? d.extractedText.slice(0, limit) : d.extractedText;
    budget -= text.length;
    blocks.push(
      `<document name="${escapeAttr(d.name)}" type="${d.kind}"${truncated ? ' truncated="true"' : ""}>\n${text}\n</document>`,
    );
  }
  return blocks.join("\n\n");
}

/** Merges consecutive same-role turns and removes leading assistant turns (providers expect user first). */
export function normalizeTurns(messages: readonly ProviderMessage[]): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    if (out.length === 0 && m.role === "assistant") continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content}\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function buildProviderMessages(
  provider: ProviderId,
  history: readonly HistoryMessage[],
  userContent: string,
  documents: readonly DocumentRecord[],
): ProviderMessage[] {
  const filtered = trimHistory(filterHistoryForProvider(history, provider));
  const docs = renderDocuments(documents);
  const finalContent = docs ? `${docs}\n\n${userContent}` : userContent;
  return normalizeTurns([
    ...filtered.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: finalContent },
  ]);
}
