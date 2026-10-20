import {
  ChatStreamRequest,
  Id,
  LIMITS,
  encodeSseEvent,
  type CancelStreamResponse,
  type StreamEvent,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { prepareChat, runChat, type SseSink } from "../chat/orchestrator.js";
import { StreamControlUnavailable } from "../chat/streamControl.js";
import { AppError, busyError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import type { RouteContext } from "./context.js";

const HEARTBEAT_MS = 15_000;
// A full history (LIMITS.maxHistoryChars) of multi-byte text plus the new message.
const CHAT_BODY_LIMIT = 2 * 1024 * 1024;

function createSink(res: ServerResponse): SseSink {
  const writable = () => !res.writableEnded && !res.destroyed;
  return {
    get open() {
      return writable();
    },
    send(event: StreamEvent) {
      if (writable()) res.write(encodeSseEvent(event));
    },
    comment(text: string) {
      if (writable()) res.write(`: ${text}\n\n`);
    },
  };
}

export function chatRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const chatLimit = ctx.rateLimit("chat", (r) => `chat:${r.authUser?.id ?? r.ip}`);

  app.post(
    "/v1/chat/stream",
    { preHandler: [ctx.requireAuth, chatLimit], bodyLimit: CHAT_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = currentUser(request);
      const body = parseOrThrow(ChatStreamRequest, request.body);
      if (body.message.content.length > LIMITS.maxMessageChars) {
        throw new AppError("payload_too_large", "Message is too long.");
      }
      // The slot is taken before anything else (no reservation, no provider work) and atomically, so
      // concurrent requests, on this instance or any other, can never all pass the limit.
      const streamId = newId();
      const controller = new AbortController();
      const slot = await ctx.streams.acquire(streamId, user.id, ctx.config.maxConcurrentStreamsPerUser, controller);
      if (!slot.ok) {
        if (slot.reason === "full") throw new AppError("too_many_streams", "Too many responses are generating at once. Wait for one to finish.");
        if (slot.reason === "gone") throw new AppError("unauthorized", "Your session has ended. Sign in again.");
        ctx.metrics.busyRejections.inc({ reason: "stream_control" });
        throw busyError();
      }
      let prepared;
      try {
        prepared = await prepareChat(
          { store: ctx.store, providers: ctx.providers, router: ctx.router, ai: ctx.ai, tools: ctx.tools, config: ctx.config, log: request.log, now: ctx.now, metrics: ctx.metrics },
          user.id,
          body,
        );
      } catch (err) {
        await ctx.streams.release(streamId);
        throw err;
      }
      const startedAt = Date.now();

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Stream-Id": streamId,
      });
      res.flushHeaders();

      const sink = createSink(res);
      let finished = false;
      res.on("close", () => {
        // The client went away (e.g. the app pressed Stop or lost its connection).
        if (!finished) controller.abort("cancelled");
      });
      // It may have gone while the request was being prepared, before anyone listened: nothing is sent then.
      if (res.destroyed || !res.socket || res.socket.destroyed) controller.abort("cancelled");
      const heartbeat = setInterval(() => sink.comment("ping"), HEARTBEAT_MS);

      let outcome = "ok";
      try {
        const results = await runChat(
          { store: ctx.store, providers: ctx.providers, router: ctx.router, ai: ctx.ai, tools: ctx.tools, config: ctx.config, log: request.log, now: ctx.now, metrics: ctx.metrics },
          prepared,
          streamId,
          sink,
          controller.signal,
        );
        outcome = results.map((r) => `${r.provider}:${r.status}`).join(",");
      } catch (err) {
        if ((err as { code?: string }).code === "23503" && controller.signal.aborted) {
          // The account was deleted while this answer was being written: its rows are gone and stay gone.
          outcome = "account_deleted";
          request.log.info({ streamId }, "chat stream ended: account deleted");
        } else {
          outcome = "error";
          request.log.error({ err }, "chat stream failed");
          sink.send({
            event: "stream.error",
            data: { error: { code: "internal_error", message: "Something went wrong on the Dash AI server.", retryable: true } },
          });
        }
      } finally {
        finished = true;
        clearInterval(heartbeat);
        await ctx.streams.release(streamId);
        // Shutting down: close the connection once the last event is written (no idle keep-alive).
        const socket = res.socket;
        if (ctx.lifecycle.draining && socket) res.once("finish", () => socket.destroySoon());
        if (!res.writableEnded) res.end();
        // Metadata only: never the prompt, documents or model output.
        request.log.info(
          {
            streamId,
            modelChoice: body.modelChoice,
            mode: body.mode,
            targets: prepared.targets.length,
            outcome,
            cancelled: controller.signal.aborted,
            durationMs: Date.now() - startedAt,
          },
          "chat stream finished",
        );
      }
    },
  );

  app.post(
    "/v1/chat/streams/:streamId/cancel",
    { preHandler: ctx.requireAuth },
    async (request: FastifyRequest): Promise<CancelStreamResponse> => {
      const { streamId } = parseOrThrow(z.object({ streamId: Id }), request.params, "stream id");
      try {
        return { streamId, cancelled: await ctx.streams.cancel(currentUser(request).id, streamId) };
      } catch (err) {
        // The stream is not on this instance and Redis cannot reach the one it is on. The client
        // also closes its connection, which stops the answer on its own instance.
        if (err instanceof StreamControlUnavailable) {
          ctx.metrics.busyRejections.inc({ reason: "stream_control" });
          throw busyError();
        }
        throw err;
      }
    },
  );
}
