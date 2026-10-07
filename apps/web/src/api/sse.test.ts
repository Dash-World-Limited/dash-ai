import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SseParser } from "./sse";

// Vitest runs from apps/web; the fixtures are the ones the API and Android tests use too.
const fixture = (name: string) => readFileSync(resolve(process.cwd(), "../../packages/contracts/fixtures", name), "utf8");

describe("SseParser", () => {
  it("decodes the shared production transcript, however it is chunked", () => {
    const text = fixture("chat-stream.sse");
    const whole = new SseParser().feed(text);
    const parser = new SseParser();
    const chunked = [];
    for (let i = 0; i < text.length; i += 7) chunked.push(...parser.feed(text.slice(i, i + 7)));
    chunked.push(...parser.finish());
    expect(chunked).toEqual(whole);
    expect(whole[0]!.event).toBe("stream.start");
    expect(whole.at(-1)!.event).toBe("stream.end");
  });

  it("decodes tool events (names and outcomes only) and ignores comments and unknown events", () => {
    const events = new SseParser().feed(`: heartbeat\n\nevent: future.thing\ndata: {}\n\n${fixture("chat-stream-tools.sse")}`);
    expect(events.map((e) => e.event)).toContain("tool.call");
    const result = events.find((e) => e.event === "tool.result");
    expect(result?.data).toMatchObject({ plugin: "dash-demo", tool: "text_stats", status: "ok" });
    expect(events.some((e) => (e.event as string) === "future.thing")).toBe(false);
  });
});
