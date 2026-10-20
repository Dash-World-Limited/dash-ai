import { Id, checkFile, type DocumentListResponse, type DocumentResponse } from "@dash-ai/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentUser } from "../auth/requireAuth.js";
import { extractText, sanitizeFileName, signatureMatches } from "../documents/inspect.js";
import { GateBusy } from "../documents/gate.js";
import { AppError, busyError, parseOrThrow } from "../errors.js";
import { newId } from "../security/crypto.js";
import { summarizeDocument } from "../store/store.js";
import type { RouteContext } from "./context.js";
import { toDocument } from "./mappers.js";

const limitReached = (max: number) =>
  new AppError("conflict", `You can keep up to ${max.toLocaleString("en-US")} documents. Delete some to upload more.`);

export function documentRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** A busy gate becomes a neutral, retryable 503 (counted by reason); anything else passes through. */
  const refuse = (err: unknown): unknown => {
    if (!(err instanceof GateBusy)) return err;
    ctx.metrics.extractionRejections.inc({ reason: err.reason });
    ctx.metrics.busyRejections.inc({ reason: "extraction_saturated" });
    return busyError();
  };

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
      // A place is taken before the body is read, so the uploads held in memory stay bounded.
      let ticket;
      try {
        ticket = ctx.extraction.enter(user.id);
      } catch (err) {
        throw refuse(err);
      }
      // The client went away (while uploading, queued or being parsed), or shutdown's drain window
      // ended: stop working for it (the extraction process is killed, the place released).
      const gone = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableFinished) gone.abort();
      });
      const stop = AbortSignal.any([gone.signal, ctx.lifecycle.stopped.signal]);
      try {
        if ((await ctx.store.listDocuments(user.id)).length >= ctx.config.documentsMaxPerAccount) throw limitReached(ctx.config.documentsMaxPerAccount);
        const file = await request.file();
        if (!file) throw new AppError("bad_request", "No file was uploaded.");
        const buffer = await file.toBuffer();
        const name = sanitizeFileName(file.filename);
        const check = checkFile(name, file.mimetype, buffer.length);
        if (!check.ok) throw new AppError(check.code, check.message);
        if (!signatureMatches(check.kind, buffer)) {
          throw new AppError("unsupported_media_type", "The file contents do not match its type.");
        }
        const started = Date.now();
        const extract = () => extractText(check.kind, buffer, { timeoutMs: ctx.config.documentExtractionTimeoutMs, signal: stop });
        let extraction;
        try {
          // Only PDF and DOCX need an extraction process; the rest is read in place.
          extraction = check.kind === "pdf" || check.kind === "docx" ? await ticket.run(extract, stop) : await extract();
        } catch (err) {
          throw refuse(err);
        }
        ctx.metrics.documentExtractionSeconds.observe({ kind: check.kind, status: extraction.status }, (Date.now() - started) / 1000);
        if (extraction.status === "unsupported") ctx.metrics.documentRejections.inc({ kind: check.kind, reason: extraction.reason ?? "unreadable" });
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
        const saved = await ctx.store.addDocument(record, ctx.config.documentsMaxPerAccount);
        if (saved === "limit") throw limitReached(ctx.config.documentsMaxPerAccount);
        if (saved === "gone") throw new AppError("unauthorized", "Your session has ended. Sign in again.");
        request.log.info(
          { kind: record.kind, sizeBytes: record.sizeBytes, status: record.status, reason: extraction.reason },
          "document uploaded",
        );
        reply.code(201);
        return toDocument(summarizeDocument(record));
      } finally {
        ticket.release();
      }
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
