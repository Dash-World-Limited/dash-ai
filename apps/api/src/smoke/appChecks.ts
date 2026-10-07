import { parseSseText, resolveProviders, STREAM_EVENTS, type ProviderId, type StreamEvent, type StreamEventName } from "@dash-ai/contracts";
import { buildApp } from "../app.js";
import type { AppConfig } from "../config.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { MemoryStore } from "../store/memoryStore.js";
import { check, skipped, timed, type CheckResult } from "./report.js";

const decode = (text: string): StreamEvent[] =>
  parseSseText(text).map((raw) => ({ event: raw.event, data: STREAM_EVENTS[raw.event as StreamEventName].parse(JSON.parse(raw.data)) }) as StreamEvent);

const only = <N extends StreamEvent["event"]>(events: StreamEvent[], name: N) =>
  events.filter((e): e is Extract<StreamEvent, { event: N }> => e.event === name);

/**
 * Drives the real HTTP API, in process and with an in-memory store, using the real providers:
 * Dash Smart routing, explicit choices, Compare and cancellation through the cancel endpoint.
 */
export async function runAppChecks(config: AppConfig, providers: ProviderRegistry): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const store = new MemoryStore();
  // Engineering mode: the smoke run must verify which provider answered. Consumers never see this.
  const { app } = await buildApp({ config: { ...config, logLevel: "silent", providerDetails: "exposed" }, providers, store });
  await app.ready();
  try {
    const registered = await app.inject({
      method: "POST", url: "/v1/auth/register",
      payload: { email: `smoke-${Date.now()}@example.com`, password: "correct horse battery", displayName: "Smoke" },
    });
    const auth = { authorization: `Bearer ${(registered.json() as { token: string }).token}` };
    const configured = providers.configured();
    let n = 0;
    const id = (p: string) => `${p}-smoke-${Date.now()}-${++n}-aaaa`;

    async function chat(choice: string, mode: string, content: string) {
      const body = { conversationId: id("conv"), mode, modelChoice: choice, message: { id: id("msg"), content, attachmentIds: [] }, history: [] };
      const res = await app.inject({ method: "POST", url: "/v1/chat/stream", headers: auth, payload: body });
      check(res.statusCode === 200, `the API answered HTTP ${res.statusCode}`);
      const events = decode(res.body);
      check(only(events, "stream.end").length === 1, "the stream did not end cleanly");
      return { body, events };
    }

    function verifyTargets(events: StreamEvent[], expected: ProviderId[]) {
      const start = only(events, "stream.start")[0];
      check(start, "no stream.start event");
      const targets = start.data.targets;
      check(targets.map((t) => t.provider).sort().join() === [...expected].sort().join(), "the answer came from unexpected providers");
      for (const t of targets) {
        check(!t.demo, "a live provider answer was labelled as a demonstration");
        check(t.provider !== undefined && t.model === providers.get(t.provider)!.model, "the reported model label does not match the configured model");
        const end = only(events, "message.end").find((e) => e.data.messageId === t.messageId);
        check(end && end.data.finishReason === "stop", `${t.provider} did not finish cleanly`);
        const text = only(events, "message.delta").filter((d) => d.data.messageId === t.messageId).map((d) => d.data.text).join("");
        check(text.trim().length > 0, `${t.provider} produced no text`);
      }
      return start.data;
    }

    // Dash Smart: the route must match the shared routing table for the configured providers.
    for (const mode of ["general", "writing"] as const) {
      results.push(
        await timed("app", `dash smart (${mode})`, async () => {
          const route = resolveProviders("smart", mode, configured);
          check(route.ok, "no provider is configured");
          const { events } = await chat("smart", mode, "Reply with exactly one word: pong");
          const start = verifyTargets(events, route.providers);
          check(start.routingReason === route.reason, "the routing explanation does not match the routing table");
          return `routed to ${route.providers.join("+")}`;
        }),
      );
    }

    for (const [choice, provider] of [["openai", "openai"], ["claude", "anthropic"]] as const) {
      results.push(
        configured.has(provider)
          ? await timed("app", `explicit ${choice}`, async () => {
              const { events } = await chat(choice, "general", "Reply with exactly one word: pong");
              verifyTargets(events, [provider]);
              return `answered by ${provider}`;
            })
          : skipped("app", `explicit ${choice}`, `${provider} is not configured`),
      );
    }

    results.push(
      configured.has("openai") && configured.has("anthropic")
        ? await timed("app", "compare", async () => {
            const { body, events } = await chat("compare", "general", "Reply with exactly one word: pong");
            const start = verifyTargets(events, ["openai", "anthropic"]);
            check(start.compareGroupId === body.message.id, "the compare group does not reference the user message");
            const stored = await store.listMessages(body.conversationId);
            check(stored.filter((m) => m.role === "assistant" && m.compareGroupId === body.message.id).length === 2, "both answers were not stored");
            return "two answers, both labelled and stored";
          })
        : skipped("app", "compare", "needs both providers configured"),
    );

    results.push(
      await timed("app", "cancel via API", async () => {
        const address = await app.listen({ port: 0, host: "127.0.0.1" });
        const body = {
          conversationId: id("conv"), mode: "general", modelChoice: "smart",
          message: { id: id("msg"), content: "Write the numbers from 1 to 400, one per line.", attachmentIds: [] }, history: [],
        };
        const res = await fetch(`${address}/v1/chat/stream`, {
          method: "POST", headers: { ...auth, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body),
        });
        const streamId = res.headers.get("x-stream-id");
        check(streamId, "the stream id header is missing");
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let seen = "";
        while (!seen.includes("event: message.delta")) {
          const { value, done } = await reader.read();
          check(!done, "the stream ended before any text arrived");
          seen += decoder.decode(value, { stream: true });
        }
        const cancel = await fetch(`${address}/v1/chat/streams/${streamId}/cancel`, { method: "POST", headers: auth });
        check(((await cancel.json()) as { cancelled: boolean }).cancelled, "the server did not accept the cancel request");
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
        }
        const end = only(decode(seen), "message.end")[0];
        check(end && end.data.finishReason === "cancelled", "the answer did not end as cancelled");
        const stored = (await store.listMessages(body.conversationId)).find((m) => m.role === "assistant");
        check(stored && stored.status === "stopped" && stored.content.length > 0, "the partial answer was not kept as stopped");
        return `partial answer kept (${stored.content.length} chars)`;
      }),
    );
  } finally {
    await app.close();
  }
  return results;
}
