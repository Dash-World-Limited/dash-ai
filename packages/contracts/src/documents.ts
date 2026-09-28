import { z } from "zod";
import { Id, IsoDateTime, LIMITS } from "./common.js";

export const DocumentKind = z.enum(["pdf", "docx", "txt", "image"]);
export type DocumentKind = z.infer<typeof DocumentKind>;

export interface FileRule {
  kind: DocumentKind;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}

/**
 * Allowed upload types. Anything else is rejected by the API (415) and by the Android picker.
 * The API additionally checks file signatures ("magic bytes"), so a renamed file is rejected.
 */
export const FILE_RULES: readonly FileRule[] = [
  { kind: "pdf", extensions: ["pdf"], mimeTypes: ["application/pdf"] },
  {
    kind: "docx",
    extensions: ["docx"],
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  },
  { kind: "txt", extensions: ["txt"], mimeTypes: ["text/plain"] },
  { kind: "image", extensions: ["png", "jpg", "jpeg", "webp"], mimeTypes: ["image/png", "image/jpeg", "image/webp"] },
];

export const MAX_UPLOAD_BYTES = LIMITS.maxUploadBytes;

export type FileCheck =
  | { ok: true; kind: DocumentKind }
  | { ok: false; code: "unsupported_media_type" | "payload_too_large" | "bad_request"; message: string };

/** Validates a file name, declared MIME type and size against FILE_RULES. */
export function checkFile(name: string, mimeType: string, sizeBytes: number): FileCheck {
  if (sizeBytes <= 0) return { ok: false, code: "bad_request", message: "The file is empty." };
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return { ok: false, code: "payload_too_large", message: "Files must be 10 MB or smaller." };
  }
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  const rule = FILE_RULES.find((r) => r.extensions.includes(ext));
  if (!rule) {
    return { ok: false, code: "unsupported_media_type", message: "Only PDF, DOCX, TXT, PNG, JPG and WEBP files are supported." };
  }
  if (!rule.mimeTypes.includes(mime) && mime !== "application/octet-stream") {
    return { ok: false, code: "unsupported_media_type", message: "The file type does not match its extension." };
  }
  return { ok: true, kind: rule.kind };
}

/**
 * ready       — text was extracted and the document can be used as chat context.
 * unsupported — the file was validated but its contents cannot be read yet (e.g. images).
 */
export const DocumentStatus = z.enum(["ready", "unsupported"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const DocumentResponse = z.object({
  id: Id,
  name: z.string().min(1).max(255),
  kind: DocumentKind,
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  status: DocumentStatus,
  statusDetail: z.string(),
  extractedChars: z.number().int().nonnegative(),
  pageCount: z.number().int().positive().nullable(),
  createdAt: IsoDateTime,
});
export type DocumentResponse = z.infer<typeof DocumentResponse>;

export const DocumentListResponse = z.object({
  documents: z.array(DocumentResponse),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponse>;
