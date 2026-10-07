import {
  CreateConversationRequest,
  Id,
  UpdateConversationRequest,
  type Conversation,
  type ConversationDetailResponse,
  type ConversationListResponse,
} from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { DEFAULT_TITLE } from "../chat/titles.js";
import { AppError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import type { RouteContext } from "./context.js";
import { toConversation, toMessage, toMessageToolActivity } from "./mappers.js";

const Params = z.object({ id: Id });

export function conversationRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const auth = { preHandler: ctx.requireAuth };

  async function load(request: FastifyRequest) {
    const { id } = parseOrThrow(Params, request.params, "conversation id");
    const conversation = await ctx.store.getConversation(currentUser(request).id, id);
    if (!conversation) throw new AppError("not_found", "Conversation not found.");
    return conversation;
  }

  app.post("/v1/conversations", auth, async (request: FastifyRequest, reply: FastifyReply): Promise<Conversation> => {
    const user = currentUser(request);
    const body = parseOrThrow(CreateConversationRequest, request.body ?? {});
    const id = body.id ?? newId();
    const existing = await ctx.store.getConversation(user.id, id);
    if (existing) return toConversation(existing);
    if (await ctx.store.conversationExists(id)) throw new AppError("conflict", "This conversation id is not available.");
    const now = ctx.now().toISOString();
    const record = {
      id,
      userId: user.id,
      title: body.title ?? DEFAULT_TITLE,
      titleIsCustom: body.title !== undefined,
      mode: body.mode,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.store.saveConversation(record);
    reply.code(201);
    return toConversation(record);
  });

  app.get("/v1/conversations", auth, async (request: FastifyRequest): Promise<ConversationListResponse> => ({
    conversations: (await ctx.store.listConversations(currentUser(request).id)).map(toConversation),
  }));

  app.get("/v1/conversations/:id", auth, async (request: FastifyRequest): Promise<ConversationDetailResponse> => {
    const conversation = await load(request);
    return {
      conversation: toConversation(conversation),
      messages: (await ctx.store.listMessages(conversation.id)).map(toMessage),
      toolActivity: (await ctx.store.listConversationToolInvocations(conversation.userId, conversation.id)).map(toMessageToolActivity),
    };
  });

  app.patch("/v1/conversations/:id", auth, async (request: FastifyRequest): Promise<Conversation> => {
    const conversation = await load(request);
    const body = parseOrThrow(UpdateConversationRequest, request.body);
    conversation.title = body.title;
    conversation.titleIsCustom = true;
    conversation.updatedAt = ctx.now().toISOString();
    await ctx.store.saveConversation(conversation);
    return toConversation(conversation);
  });

  app.delete("/v1/conversations/:id", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const conversation = await load(request);
    await ctx.store.deleteConversation(conversation.userId, conversation.id);
    reply.code(204);
  });
}
