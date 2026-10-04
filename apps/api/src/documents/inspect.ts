import { LIMITS, type DocumentKind, type DocumentStatus } from "@dash-ai/contracts";
import { AppError } from "../errors.js";
import { checkDocxBudget, checkPdfBudget } from "./budget.js";
import { extractIsolated } from "./isolate.js";

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

/** Checks the file signature so a renamed executable or mislabelled file is rejected. */
export function signatureMatches(kind: DocumentKind, buf: Buffer): boolean {
  switch (kind) {
    case "pdf":
      return startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case "docx":
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]); // ZIP container
    case "image":
      return (
        startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) || // PNG
        startsWith(buf, [0xff, 0xd8, 0xff]) || // JPEG
        (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) // RIFF....WEBP
      );
    case "txt":
      return !buf.subarray(0, 8192).includes(0);
  }
}

/** Removes directory parts and control characters from a client-supplied file name. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
  return cleaned.length > 0 ? cleaned : "document";
}

export interface Extraction {
  status: DocumentStatus;
  statusDetail: string;
  text: string;
  pageCount: number | null;
}

const fmt = (n: number) => n.toLocaleString("en-US");

function ready(text: string, pageCount: number | null): Extraction {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length === 0) {
    return { status: "unsupported", statusDetail: "No readable text was found in this file.", text: "", pageCount };
  }
  const truncated = normalized.length > LIMITS.maxExtractedChars;
  const finalText = truncated ? normalized.slice(0, LIMITS.maxExtractedChars) : normalized;
  return {
    status: "ready",
    statusDetail: truncated
      ? `Text extracted and truncated to the first ${fmt(finalText.length)} characters.`
      : `Text extracted (${fmt(finalText.length)} characters).`,
    text: finalText,
    pageCount,
  };
}

const unsupported = (statusDetail: string, pageCount: number | null = null): Extraction => ({
  status: "unsupported",
  statusDetail,
  text: "",
  pageCount,
});

export const TOO_LARGE_DETAIL =
  "This file expands to too much data to read safely. Try a smaller file, or save it as plain text.";

/**
 * Extracts plain text. TXT, PDF (text layer only) and DOCX are supported. Images and scanned PDFs
 * are accepted but marked "unsupported": their contents are not analysed and never faked.
 * PDF and DOCX are parsed in a separate, resource-limited process (see isolate.ts): they are
 * complex formats parsed by large third-party libraries, and a hostile file must not be able to
 * exhaust this server's memory or CPU.
 */
export async function extractText(kind: DocumentKind, buf: Buffer, options: { timeoutMs: number }): Promise<Extraction> {
  switch (kind) {
    case "txt": {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        throw new AppError("unsupported_media_type", "Text files must be UTF-8 encoded.");
      }
      return ready(text.replace(/^\uFEFF/, ""), null);
    }
    case "pdf":
    case "docx":
      return extractIsolated(kind, buf, options.timeoutMs);
    case "image":
      return unsupported(
        "Image understanding is not available yet. The image passed validation, but Dash AI cannot read its contents.",
      );
  }
}

/**
 * The parsing itself. Runs inside the extraction process only (extractChild.ts): decompression
 * budgets first, then the third-party parser.
 */
export async function extractInProcess(kind: "pdf" | "docx", buf: Buffer): Promise<Extraction> {
  if (kind === "pdf") {
    const budget = await checkPdfBudget(buf);
    if (!budget.ok) {
      return unsupported(budget.reason === "too_large" ? TOO_LARGE_DETAIL : "This PDF uses features Dash AI cannot read safely.");
    }
    try {
      const { extractText: extractPdf } = await import("unpdf");
      const { totalPages, text } = await extractPdf(new Uint8Array(buf), { mergePages: true });
      const result = ready(text, totalPages);
      if (result.status === "unsupported") {
        result.statusDetail = "No selectable text was found. Scanned PDFs need OCR, which Dash AI does not support yet.";
      }
      return result;
    } catch {
      return unsupported("This PDF could not be read. It may be encrypted or damaged.");
    }
  }
  const budget = await checkDocxBudget(buf);
  if (!budget.ok) {
    return unsupported(budget.reason === "too_large" ? TOO_LARGE_DETAIL : "This DOCX file could not be read. It may be damaged or password protected.");
  }
  try {
    const mammoth = (await import("mammoth")).default;
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return ready(value, null);
  } catch {
    return unsupported("This DOCX file could not be read. It may be damaged or password protected.");
  }
}
