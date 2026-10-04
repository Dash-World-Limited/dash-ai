import { createInflate, createInflateRaw } from "node:zlib";

/**
 * Decompression budgets checked before a document reaches a parser. A 10 MB upload can expand
 * to gigabytes (a "zip bomb" or a Flate-compressed PDF stream), and the DOCX/PDF libraries
 * decompress everything in memory. Each check inflates with native zlib under a hard output cap,
 * one entry at a time, so the work and memory spent here are bounded too.
 */
export const DOCX_LIMITS = {
  maxEntries: 2_000,
  /** Any single XML part (the parser needs ~50x this in memory). */
  maxXmlEntryBytes: 6 * 1024 * 1024,
  /** Any single non-XML part (images and other media). */
  maxEntryBytes: 32 * 1024 * 1024,
  /** Everything in the archive together. */
  maxTotalBytes: 64 * 1024 * 1024,
} as const;

export const PDF_LIMITS = {
  /** Flate streams that are not marked as images (page content, fonts, object streams). */
  maxContentBytes: 24 * 1024 * 1024,
  /** Flate streams marked as images (not decoded for text extraction). */
  maxImageBytes: 256 * 1024 * 1024,
  maxStreamBytes: 64 * 1024 * 1024,
  maxStreams: 20_000,
} as const;

export type BudgetResult = { ok: true } | { ok: false; reason: "too_large" | "unsupported" };

/**
 * Streams `data` through native zlib and counts the output, stopping past `cap`. Returns how much
 * it produced (also when the data turns out to be corrupt part-way: a parser may still decode that
 * prefix), and whether it ended cleanly.
 */
function measureInflate(data: Buffer, cap: number, raw: boolean): Promise<{ size: number; complete: boolean } | "too_large"> {
  return new Promise((resolve) => {
    const z = raw ? createInflateRaw() : createInflate();
    let size = 0;
    let settled = false;
    const settle = (value: { size: number; complete: boolean } | "too_large") => {
      if (settled) return;
      settled = true;
      z.destroy();
      resolve(value);
    };
    z.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) settle("too_large");
    });
    z.on("error", () => settle({ size, complete: false }));
    z.on("end", () => settle({ size, complete: true }));
    z.end(data);
  });
}

/**
 * Walks a DOCX (ZIP) central directory and inflates every entry under the limits above. Encrypted,
 * ZIP64, multi-disk and non-deflate archives are refused (Word never writes them for .docx).
 */
export async function checkDocxBudget(buf: Buffer): Promise<BudgetResult> {
  const unsupported = { ok: false, reason: "unsupported" } as const;
  const tooLarge = { ok: false, reason: "too_large" } as const;
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]), Math.max(0, buf.length - 22));
  if (eocd < 0 || buf.length - eocd < 22 || buf.length - eocd > 22 + 0xffff) return unsupported;
  const disk = buf.readUInt16LE(eocd + 4);
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || entries === 0xffff || cdOffset === 0xffffffff || cdOffset + cdSize > eocd) return unsupported;
  if (entries > DOCX_LIMITS.maxEntries) return tooLarge;

  let total = 0;
  let at = cdOffset;
  for (let i = 0; i < entries; i++) {
    if (at + 46 > eocd || buf.readUInt32LE(at) !== 0x02014b50) return unsupported;
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const declared = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("latin1");
    at += 46 + nameLength + extraLength + commentLength;

    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff) return unsupported;
    if (method !== 0 && method !== 8) return unsupported;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return unsupported;
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (dataStart + compressed > buf.length) return unsupported;

    const isXml = /\.(xml|rels)$/i.test(name);
    const cap = Math.min(isXml ? DOCX_LIMITS.maxXmlEntryBytes : DOCX_LIMITS.maxEntryBytes, DOCX_LIMITS.maxTotalBytes - total);
    // Never trust the declared size: measure what the entry really expands to.
    let size = compressed;
    if (method === 8) {
      const measured = await measureInflate(buf.subarray(dataStart, dataStart + compressed), cap, true);
      if (measured === "too_large") return tooLarge;
      if (!measured.complete) return unsupported;
      size = measured.size;
    }
    if (size > cap) return tooLarge;
    if (size !== declared) return unsupported;
    total += size;
  }
  return { ok: true };
}

/**
 * Bounds the zlib data in a PDF. Every `stream … endstream` body is measured whatever its
 * dictionary claims (so an indirect /Filter cannot hide Flate data); streams marked as images get
 * a larger allowance because text extraction does not decode them. Filters this check cannot see
 * through are refused: LZW and RunLength (no native bound), ASCII filters chained before Flate,
 * and indirect /Filter references. (Inline images inside page content are bounded by the content
 * allowance and the extraction process's limits.) Encrypted PDFs cannot be measured here; they rely on the
 * extraction process's time and memory limits alone.
 */
export async function checkPdfBudget(buf: Buffer): Promise<BudgetResult> {
  const text = buf.toString("latin1");
  // Pass 1: locate stream bodies, so the filter checks below only read object syntax, never
  // binary stream data (where a short name like "/RL" occurs by chance).
  const bodies: { start: number; end: number; dictionary: string }[] = [];
  const outside: string[] = [];
  const marker = /stream\r?\n/g;
  let last = 0;
  for (let m = marker.exec(text); m; m = marker.exec(text)) {
    if (m.index > 0 && /[a-z]/i.test(text[m.index - 1]!)) continue; // the tail of "endstream"
    if (bodies.length >= PDF_LIMITS.maxStreams) return { ok: false, reason: "too_large" };
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    const before = text.slice(Math.max(last, m.index - 2_048), m.index);
    bodies.push({ start, end, dictionary: before.slice(Math.max(0, before.lastIndexOf(" obj"))) });
    outside.push(text.slice(last, m.index));
    last = end;
    marker.lastIndex = end + "endstream".length;
  }
  outside.push(text.slice(last));
  const syntax = outside.join("\n");
  if (/\/(LZWDecode|RunLengthDecode)\b/.test(syntax)) return { ok: false, reason: "unsupported" };
  if (/\/Filter\s*\d+\s+\d+\s+R\b/.test(syntax)) return { ok: false, reason: "unsupported" };
  if (/\/Filter\s*\[[^\]]*\/(ASCIIHexDecode|ASCII85Decode|AHx|A85)\b[^\]]*\/(FlateDecode|Fl)\b/.test(syntax)) {
    return { ok: false, reason: "unsupported" };
  }

  // Pass 2: measure every body, one at a time, under the remaining allowance.
  let content = 0;
  let images = 0;
  for (const body of bodies) {
    const isImage = /\/Subtype\s*\/Image\b/.test(body.dictionary);
    const remaining = isImage ? PDF_LIMITS.maxImageBytes - images : PDF_LIMITS.maxContentBytes - content;
    const measured = await measureInflate(buf.subarray(body.start, body.end), Math.min(PDF_LIMITS.maxStreamBytes, remaining), false);
    if (measured === "too_large") return { ok: false, reason: "too_large" };
    if (isImage) images += measured.size;
    else content += measured.size;
  }
  return { ok: true };
}
