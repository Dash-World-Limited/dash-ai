import { Id, checkFile, type DocumentListResponse, type DocumentResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { extractText, sanitizeFileName, signatureMatches } from "../documents/inspect.js";
import { AppError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import type { RouteContext } from "./context.js";
import { toDocument } from "./mappers.js";

export function documentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const uploadLimit = ctx.rateLimit("upload", (r) => `upload:${r.authUser?.id ?? r.ip}`);
  const auth = { preHandler: ctx.requireAuth };

  /**
   * Accepts one multipart file field. Validates extension, declared type, size and file signature,
   * extracts text where supported, and keeps only the extracted text (raw bytes are discarded).
   */
  app.post(
    "/v1/documents",
    { preHandler: [ctx.requireAuth, uploadLimit] },
    async (request: FastifyRequest, reply: FastifyReply): Promise<DocumentResponse> => {
      const user = currentUser(request);
      if (!request.isMultipart()) {
        throw new AppError("unsupported_media_type", "Upload files as multipart/form-data.");
      }
      const file = await request.file();
      if (!file) throw new AppError("bad_request", "No file was uploaded.");
      const buffer = await file.toBuffer();
      const name = sanitizeFileName(file.filename);
      const check = checkFile(name, file.mimetype, buffer.length);
      if (!check.ok) throw new AppError(check.code, check.message);
      if (!signatureMatches(check.kind, buffer)) {
        throw new AppError("unsupported_media_type", "The file contents do not match its type.");
      }
      const extraction = await extractText(check.kind, buffer);
      const record = {
        id: newId(),
        userId: user.id,
        name,
        kind: check.kind,
        mimeType: file.mimetype.split(";")[0]!.trim().toLowerCase(),
        sizeBytes: buffer.length,
        status: extraction.status,
        statusDetail: extraction.statusDetail,
        extractedText: extraction.text,
        pageCount: extraction.pageCount,
        createdAt: ctx.now().toISOString(),
      };
      await ctx.store.saveDocument(record);
      request.log.info(
        { kind: record.kind, sizeBytes: record.sizeBytes, status: record.status },
        "document uploaded",
      );
      reply.code(201);
      return toDocument(record);
    },
  );

  app.get("/v1/documents", auth, async (request: FastifyRequest): Promise<DocumentListResponse> => ({
    documents: (await ctx.store.listDocuments(currentUser(request).id)).map(toDocument),
  }));

  app.delete("/v1/documents/:id", auth, async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = parseOrThrow(z.object({ id: Id }), request.params, "document id");
    if (!(await ctx.store.deleteDocument(currentUser(request).id, id))) {
      throw new AppError("not_found", "Document not found.");
    }
    reply.code(204);
  });
}
