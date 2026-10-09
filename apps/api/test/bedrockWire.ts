import { Readable } from "node:stream";
import { crc32 } from "node:zlib";

/**
 * A stand-in for Amazon Bedrock at the HTTP layer, for driving the REAL Bedrock Runtime SDK in
 * tests without any network access: requests are captured and answered with AWS event-stream frames
 * (the binary framing ConverseStream uses) or with an AWS error response. Nothing leaves the process.
 */

export interface CapturedRequest {
  method: string;
  hostname: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Frame =
  | { kind: "event"; type: string; payload: Record<string, unknown> }
  | { kind: "exception"; type: string; payload: Record<string, unknown> };

export type WireReply =
  | { kind: "stream"; frames: Frame[] }
  | { kind: "error"; status: number; type: string; message: string };

/** One AWS event-stream message: prelude, string headers, JSON payload, CRCs. */
export function encodeFrame(headers: Record<string, string>, payload: Record<string, unknown>): Buffer {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([name, value]) => {
      const n = Buffer.from(name, "utf8");
      const v = Buffer.from(value, "utf8");
      const lengths = Buffer.alloc(3);
      lengths.writeUInt16BE(v.length, 1);
      return Buffer.concat([Buffer.from([n.length]), n, Buffer.from([7]), lengths.subarray(1), v]);
    }),
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const total = 12 + headerBytes.length + body.length + 4;
  const prelude = Buffer.alloc(8);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);
  const preludeCrc = Buffer.alloc(4);
  preludeCrc.writeUInt32BE(crc32(prelude) >>> 0, 0);
  const withoutCrc = Buffer.concat([prelude, preludeCrc, headerBytes, body]);
  const messageCrc = Buffer.alloc(4);
  messageCrc.writeUInt32BE(crc32(withoutCrc) >>> 0, 0);
  return Buffer.concat([withoutCrc, messageCrc]);
}

export const event = (type: string, payload: Record<string, unknown>): Frame => ({ kind: "event", type, payload });
export const exception = (type: string, message: string): Frame => ({ kind: "exception", type, payload: { message } });

/** The ordinary frames of a short text answer. */
export function textAnswer(parts: string[], usage = { inputTokens: 12, outputTokens: 4, totalTokens: 16 }, stopReason = "end_turn"): Frame[] {
  return [
    event("messageStart", { role: "assistant" }),
    ...parts.map((text) => event("contentBlockDelta", { contentBlockIndex: 0, delta: { text } })),
    event("contentBlockStop", { contentBlockIndex: 0 }),
    event("messageStop", { stopReason }),
    event("metadata", { usage, metrics: { latencyMs: 42 } }),
  ];
}

/** An SDK request handler that answers from `reply` and records every request it receives. */
export function wireHandler(reply: (request: CapturedRequest) => WireReply) {
  const requests: CapturedRequest[] = [];
  const handler = {
    metadata: { handlerProtocol: "http/1.1" },
    async handle(request: { method: string; hostname: string; path: string; headers: Record<string, string>; body?: unknown }) {
      const captured: CapturedRequest = {
        method: request.method,
        hostname: request.hostname,
        path: request.path,
        headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])),
        body: JSON.parse(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body as Uint8Array)) as Record<string, unknown>,
      };
      requests.push(captured);
      const r = reply(captured);
      if (r.kind === "error") {
        return {
          response: {
            statusCode: r.status,
            headers: { "content-type": "application/json", "x-amzn-errortype": `${r.type}:http://internal.amazon.com/coral/com.amazon.bedrock/` },
            body: Readable.from([Buffer.from(JSON.stringify({ message: r.message }))]),
          },
        };
      }
      const frames = r.frames.map((f) =>
        encodeFrame(
          f.kind === "event"
            ? { ":event-type": f.type, ":content-type": "application/json", ":message-type": "event" }
            : { ":exception-type": f.type, ":content-type": "application/json", ":message-type": "exception" },
          f.payload,
        ),
      );
      return {
        response: {
          statusCode: 200,
          headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "test-request" },
          body: Readable.from(frames),
        },
      };
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs() {
      return {};
    },
    destroy() {},
  };
  return { handler, requests };
}
