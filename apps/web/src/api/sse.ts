import type { StreamEvent, StreamEventName } from "@dash-ai/contracts";

const KNOWN: ReadonlySet<string> = new Set<StreamEventName>([
  "stream.start",
  "message.delta",
  "message.end",
  "message.error",
  "conversation.title",
  "tool.call",
  "tool.result",
  "stream.end",
  "stream.error",
]);

/**
 * Incremental text/event-stream parser (the WHATWG rules the API uses): feed text chunks, get
 * complete events. Comments (heartbeats) and unknown event names are ignored.
 */
export class SseParser {
  private buffer = "";
  private event = "message";
  private data: string[] = [];

  feed(chunk: string): StreamEvent[] {
    this.buffer += chunk;
    const out: StreamEvent[] = [];
    let newline: number;
    while ((newline = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = this.buffer.slice(0, newline);
      const skip = this.buffer.startsWith("\r\n", newline) ? 2 : 1;
      this.buffer = this.buffer.slice(newline + skip);
      const event = this.line(line);
      if (event) out.push(event);
    }
    return out;
  }

  /** Flushes an event not followed by a blank line (end of stream). */
  finish(): StreamEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    const out = rest ? this.feed(`${rest}\n`) : [];
    const last = this.dispatch();
    return last ? [...out, last] : out;
  }

  private line(line: string): StreamEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return null;
  }

  private dispatch(): StreamEvent | null {
    const name = this.event;
    const data = this.data.join("\n");
    const hadData = this.data.length > 0;
    this.event = "message";
    this.data = [];
    if (!hadData || !KNOWN.has(name)) return null;
    try {
      return { event: name, data: JSON.parse(data) } as StreamEvent;
    } catch {
      return null;
    }
  }
}

/** Reads a chat stream body, yielding events as they arrive. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* parser.feed(decoder.decode(value, { stream: true }));
    }
    yield* parser.feed(decoder.decode());
    yield* parser.finish();
  } finally {
    reader.releaseLock();
  }
}
