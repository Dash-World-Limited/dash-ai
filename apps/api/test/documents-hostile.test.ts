import { createHash } from "node:crypto";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { DocumentResponse } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DOCX_LIMITS, PDF_LIMITS, checkDocxBudget, checkPdfBudget } from "../src/documents/budget.js";
import { TOO_LARGE_DETAIL, extractText } from "../src/documents/inspect.js";
import { childEnvironment } from "../src/documents/isolate.js";
import { makeApp, makeDocx, makePdf, multipart, register } from "./helpers.js";

/**
 * Malicious documents. PDF and DOCX are compressed formats parsed by large libraries in memory: a
 * few hundred kilobytes can expand to gigabytes. Before this suite existed, a 357 KB DOCX made the
 * server spend 48 s and 6 GB of memory extracting it, and a 357 KB PDF 25 s and 1.1 GB.
 */

interface Entry {
  name: string;
  data: Buffer;
  /** Override what the headers claim (a lying archive). */
  declaredSize?: number;
  method?: number;
  flags?: number;
}

/** A minimal ZIP writer, so tests control every header field. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(e.data, { level: 9 }) : e.data;
    const size = e.declaredSize ?? e.data.length;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const PARAGRAPH = "<w:p><w:r><w:t>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</w:t></w:r></w:p>";
const documentXml = (bytes: number) =>
  Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${PARAGRAPH.repeat(Math.ceil(bytes / PARAGRAPH.length))}</w:body></w:document>`);
const docx = (document: Buffer, extra: Partial<Entry> = {}, more: Entry[] = []) =>
  zip([{ name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES) }, { name: "_rels/.rels", data: Buffer.from(RELS) }, { name: "word/document.xml", data: document, ...extra }, ...more]);

/** A one-page PDF whose page content is `content`, compressed with Flate. */
function pdf(content: Buffer, options: { filter?: string; contentDictionary?: string; extraObjects?: string[] } = {}): Buffer {
  const compressed = options.filter === "none" ? content : deflateSync(content, { level: 9 });
  const filter = options.filter === "none" ? "" : (options.filter ?? "/Filter /FlateDecode");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${compressed.length} ${filter} ${options.contentDictionary ?? ""} >>\nstream\n`), compressed, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ...(options.extraObjects ?? []).map((o) => Buffer.from(o)),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
  ));
  return Buffer.concat(parts);
}
const LINE = "BT /F1 12 Tf 72 712 Td (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) Tj ET\n";
const pageContent = (bytes: number) => Buffer.from(LINE.repeat(Math.ceil(bytes / LINE.length)));

const MB = 1024 * 1024;

const u16 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);

/** RC4, for building a genuinely encrypted test PDF (the PDF standard security handler, revision 2). */
function rc4(key: Buffer, data: Buffer): Buffer {
  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 0xff;
    [S[i], S[j]] = [S[j]!, S[i]!];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]!) & 0xff;
    [S[i], S[j]] = [S[j]!, S[i]!];
    out[n] = data[n]! ^ S[(S[i]! + S[j]!) & 0xff]!;
  }
  return out;
}

/**
 * A one-page PDF encrypted with the standard security handler (V1, R2, 40-bit RC4) and an empty
 * user password, as many real "protected" PDFs are: viewers and parsers open it without asking.
 */
function encryptedPdf(content: Buffer, options: { compressed?: boolean } = {}): Buffer {
  const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
  const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
  const id = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const P = -44;
  const ownerKey = md5(PAD).subarray(0, 5);
  const O = rc4(ownerKey, PAD);
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);
  const key = md5(PAD, O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PAD);
  const objectKey = (n: number) => md5(key, Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, 0])).subarray(0, 10);
  const body = rc4(objectKey(4), content);
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${body.length}${options.compressed ? " /Filter /FlateDecode" : ""} >>\nstream\n`), body, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.from(`<< /Filter /Standard /V 1 /R 2 /O <${O.toString("hex")}> /U <${U.toString("hex")}> /P ${P} >>`),
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((o, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}` +
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${id.toString("hex")}> <${id.toString("hex")}>] >>\nstartxref\n${length}\n%%EOF\n`,
  ));
  return Buffer.concat(parts);
}
const OPTIONS = { timeoutMs: 20_000 };

describe("DOCX decompression budget", () => {
  it("accepts ordinary documents", async () => {
    expect(await checkDocxBudget(await makeDocx("Hello"))).toEqual({ ok: true });
    expect(await checkDocxBudget(docx(documentXml(MB)))).toEqual({ ok: true });
  });

  it("refuses a zip bomb before any parser sees it, quickly", async () => {
    const bomb = docx(documentXml(DOCX_LIMITS.maxXmlEntryBytes + MB));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const started = Date.now();
    expect(await checkDocxBudget(bomb)).toEqual({ ok: false, reason: "too_large" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("measures real sizes instead of trusting the headers", async () => {
    // Claims 1 KB, really expands past the per-part limit.
    const liar = docx(documentXml(DOCX_LIMITS.maxXmlEntryBytes + MB), { declaredSize: 1024 });
    expect(await checkDocxBudget(liar)).toEqual({ ok: false, reason: "too_large" });
    // Claims more than it holds: damaged, refused.
    expect(await checkDocxBudget(docx(documentXml(1024), { declaredSize: 4096 }))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("bounds the whole archive, not just each part", async () => {
    const media = Array.from({ length: 4 }, (_, i) => ({ name: `word/media/blob${i}.bin`, data: Buffer.alloc(DOCX_LIMITS.maxEntryBytes - MB) }));
    expect(await checkDocxBudget(docx(documentXml(1024), {}, media))).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses archives with too many entries, encryption or unusual compression", async () => {
    const many = Array.from({ length: DOCX_LIMITS.maxEntries }, (_, i) => ({ name: `x/${i}.xml`, data: Buffer.from("<a/>") }));
    expect(await checkDocxBudget(docx(documentXml(10), {}, many))).toEqual({ ok: false, reason: "too_large" });
    expect(await checkDocxBudget(docx(documentXml(10), { flags: 1 }))).toEqual({ ok: false, reason: "unsupported" });
    expect(await checkDocxBudget(docx(documentXml(10), { method: 12 }))).toEqual({ ok: false, reason: "unsupported" });
    expect(await checkDocxBudget(Buffer.from("PK\u0003\u0004 not really a zip"))).toEqual({ ok: false, reason: "unsupported" });
    const truncated = docx(documentXml(10));
    expect(await checkDocxBudget(truncated.subarray(0, truncated.length - 30))).toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("PDF decompression budget", () => {
  it("accepts ordinary documents", async () => {
    expect(await checkPdfBudget(makePdf("Hello"))).toEqual({ ok: true });
    expect(await checkPdfBudget(pdf(pageContent(MB)))).toEqual({ ok: true });
  });

  it("refuses a Flate bomb in the page content, quickly", async () => {
    const bomb = pdf(pageContent(PDF_LIMITS.maxContentBytes + MB));
    expect(bomb.length).toBeLessThan(200 * 1024);
    const started = Date.now();
    expect(await checkPdfBudget(bomb)).toEqual({ ok: false, reason: "too_large" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("cannot be fooled by a missing, indirect or chained /Filter, or trailing garbage", async () => {
    const big = pageContent(PDF_LIMITS.maxContentBytes + MB);
    // No /Filter in the dictionary at all: measured anyway.
    expect(await checkPdfBudget(pdf(big, { filter: "" }))).toEqual({ ok: false, reason: "too_large" });
    // Indirect filter reference: refused outright.
    expect(await checkPdfBudget(pdf(pageContent(1024), { filter: "/Filter 6 0 R", extraObjects: ["/FlateDecode"] }))).toEqual({ ok: false, reason: "unsupported" });
    // ASCII filter chained before Flate: refused outright.
    expect(await checkPdfBudget(pdf(pageContent(1024), { filter: "/Filter [/ASCIIHexDecode /FlateDecode]" }))).toEqual({ ok: false, reason: "unsupported" });
    // Unbounded filters: refused.
    for (const filter of ["/Filter /LZWDecode", "/Filter /RunLengthDecode"]) {
      expect(await checkPdfBudget(pdf(pageContent(1024), { filter }))).toEqual({ ok: false, reason: "unsupported" });
    }
    // A valid bomb followed by corrupt bytes still counts what it expands to.
    const corrupt = Buffer.concat([deflateSync(big).subarray(0, -8), Buffer.from("garbage!")]);
    expect(await checkPdfBudget(pdf(corrupt, { filter: "none", contentDictionary: "/Filter /FlateDecode" }))).toEqual({ ok: false, reason: "too_large" });
  });

  it("short names inside binary stream data are not mistaken for filters; long ones are treated conservatively", async () => {
    const binary = Buffer.concat([Buffer.from("\u0000\u0001/RL /AHx /Fl /A85\u0002"), Buffer.alloc(64, 7)]);
    expect(await checkPdfBudget(pdf(binary, { filter: "none" }))).toEqual({ ok: true });
    // A full filter name anywhere (it cannot occur by chance in binary data) refuses the file: the safe direction.
    const named = Buffer.concat([Buffer.from("\u0000/LZWDecode\u0002"), Buffer.alloc(64, 7)]);
    expect(await checkPdfBudget(pdf(named, { filter: "none" }))).toEqual({ ok: false, reason: "unsupported" });
  });

  it("name escapes (#xx) cannot disguise refused filters or encryption", async () => {
    expect(await checkPdfBudget(pdf(pageContent(1024), { filter: "/Filter /LZWDec#6fde" }))).toEqual({ ok: false, reason: "unsupported" });
    expect(await checkPdfBudget(pdf(pageContent(1024), { filter: "/Filter [/ASCIIHexDecode /Fl#61teDecode]" }))).toEqual({ ok: false, reason: "unsupported" });
    expect(await checkPdfBudget(pdf(pageContent(1024), { extraObjects: ["<< /Encr#79pt 1 0 R >>"] }))).toEqual({ ok: false, reason: "encrypted" });
  });

  it("an `endstream` hidden inside compressed data cannot shorten what is measured", async () => {
    // A stored (uncompressed) deflate block holding the bytes "endstream", then the bomb.
    const big = pageContent(PDF_LIMITS.maxContentBytes + MB);
    const decoy = Buffer.from("\nendstream\nendobj\n");
    const zlibStream = deflateSync(Buffer.concat([decoy, big]), { level: 9, strategy: 0 });
    // deflate may compress the decoy; force it to appear literally by prefixing a stored block.
    const stored = Buffer.concat([Buffer.from([0x78, 0x01]), Buffer.from([0x00]), u16(decoy.length), u16(~decoy.length & 0xffff), decoy, deflateRawSync(big).subarray(0)]);
    for (const body of [zlibStream, stored]) {
      expect(await checkPdfBudget(pdf(body, { filter: "none", contentDictionary: "/Filter /FlateDecode" }))).toEqual({ ok: false, reason: "too_large" });
    }
  });
});

describe("encrypted PDFs", () => {
  it("a real RC4-encrypted PDF with an empty user password opens in the parser, so it is refused before parsing", async () => {
    const small = encryptedPdf(Buffer.from("BT /F1 12 Tf 72 712 Td (Secret quarterly plan) Tj ET"));
    // The fixture is genuine: the PDF library decrypts it without a password.
    const { extractText: parse } = await import("unpdf");
    expect((await parse(new Uint8Array(small), { mergePages: true })).text).toContain("Secret quarterly plan");
    // The decompression check cannot see inside it, so it refuses it instead.
    expect(await checkPdfBudget(small)).toEqual({ ok: false, reason: "encrypted" });
    const result = await extractText("pdf", small, OPTIONS);
    expect(result).toMatchObject({ status: "unsupported", text: "" });
    expect(result.statusDetail).toMatch(/encrypted or password-protected/);
  });

  it("an encrypted Flate bomb, which the size check alone could not measure, never reaches the parser", async () => {
    const bomb = encryptedPdf(deflateSync(pageContent(64 * MB), { level: 9 }), { compressed: true });
    expect(bomb.length).toBeLessThan(300 * 1024);
    const started = Date.now();
    const result = await extractText("pdf", bomb, OPTIONS);
    expect(result).toMatchObject({ status: "unsupported", text: "" });
    expect(result.statusDetail).toMatch(/encrypted/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("isolated extraction process", () => {
  it("extracts ordinary documents", async () => {
    const fromDocx = await extractText("docx", await makeDocx("Quarterly plan"), OPTIONS);
    expect(fromDocx).toMatchObject({ status: "ready", text: "Quarterly plan" });
    const fromPdf = await extractText("pdf", makePdf("Quarterly plan"), OPTIONS);
    expect(fromPdf).toMatchObject({ status: "ready", pageCount: 1 });
    expect(fromPdf.text).toContain("Quarterly plan");
  });

  it("reports bombs as too large instead of exhausting the server", async () => {
    const started = Date.now();
    const results = await Promise.all([
      extractText("docx", docx(documentXml(64 * MB)), OPTIONS),
      extractText("pdf", pdf(pageContent(64 * MB)), OPTIONS),
    ]);
    for (const r of results) expect(r).toMatchObject({ status: "unsupported", statusDetail: TOO_LARGE_DETAIL, text: "", pageCount: null, reason: "too_large" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("stops a document that passes the budgets but takes too long", async () => {
    // Within the content allowance, but far more work than a 1 s limit allows.
    const slow = pdf(pageContent(PDF_LIMITS.maxContentBytes - MB));
    const started = Date.now();
    const result = await extractText("pdf", slow, { timeoutMs: 1_000 });
    expect(result).toMatchObject({ status: "unsupported", text: "" });
    expect(result.statusDetail).toMatch(/too long|too much data/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("garbage that passes the signature check is refused cleanly", async () => {
    expect(await extractText("pdf", Buffer.from("%PDF-1.7\nnothing else"), OPTIONS)).toMatchObject({ status: "unsupported", text: "" });
    expect(await extractText("docx", Buffer.from("PK\u0003\u0004garbage"), OPTIONS)).toMatchObject({ status: "unsupported", text: "" });
  });

  it("the extraction process gets no secrets from the server's environment", () => {
    expect(childEnvironment()).toEqual({});
  });
});

describe("hostile uploads through the API", () => {
  const apps: FastifyInstance[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  it("the server stays responsive while hostile documents are processed, and records them as unsupported", async () => {
    const { app } = await makeApp({ env: { RATE_LIMIT_UPLOAD_PER_MINUTE: "100" } });
    apps.push(app);
    const user = await register(app);
    const upload = (name: string, type: string, content: Buffer) => {
      const { payload, headers } = multipart(name, type, content);
      return app.inject({ method: "POST", url: "/v1/documents", headers: { ...user.auth, ...headers }, payload });
    };
    const docxType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const uploads = Promise.all([
      upload("bomb.docx", docxType, docx(documentXml(64 * MB))),
      upload("bomb.pdf", "application/pdf", pdf(pageContent(64 * MB))),
      upload("bomb2.pdf", "application/pdf", pdf(pageContent(64 * MB))),
      upload("fine.docx", docxType, await makeDocx("Still works")),
    ]);
    // While those run, ordinary requests are answered promptly.
    const started = Date.now();
    expect((await app.inject({ method: "GET", url: "/v1/me", headers: user.auth })).statusCode).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);

    const responses = await uploads;
    expect(responses.map((r) => r.statusCode)).toEqual([201, 201, 201, 201]);
    const docs = responses.map((r) => DocumentResponse.parse(r.json()));
    expect(docs.slice(0, 3).map((d) => [d.status, d.statusDetail])).toEqual(Array(3).fill(["unsupported", TOO_LARGE_DETAIL]));
    expect(docs[3]!.status).toBe("ready");
  });
});
