import { deflateSync } from "node:zlib";

/** Upload fixtures for the multi-instance and load tests (built in memory, never written to disk). */

const LINE = "BT /F1 12 Tf 72 712 Td (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) Tj ET\n";

function pdfWith(content: Buffer, compress: boolean): Buffer {
  const data = compress ? deflateSync(content, { level: 9 }) : content;
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"),
    Buffer.concat([Buffer.from(`<< /Length ${data.length}${compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`), data, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
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
  parts.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}` +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(parts);
}

/** A small valid PDF whose text layer says `text` (fast to parse). */
export function smallPdf(text: string): Buffer {
  return pdfWith(Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`), false);
}

/**
 * A PDF that passes every decompression budget but keeps the parser busy for seconds (about 20 MB of
 * page content), padded with a trailing comment to `wireBytes` so each upload also costs real memory.
 */
export function slowPdf(wireBytes = 9 * 1024 * 1024): Buffer {
  const body = pdfWith(Buffer.from(LINE.repeat(Math.ceil((20 * 1024 * 1024) / LINE.length))), true);
  const pad = Math.max(0, wireBytes - body.length - 2);
  return Buffer.concat([body, Buffer.from("%"), Buffer.alloc(pad, 0x20), Buffer.from("\n")]);
}

/** Something that passes the signature check and then fails to parse (a malformed-document storm). */
export function malformedPdf(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 9 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
}

export function multipartBody(filename: string, contentType: string, content: Buffer): { body: Buffer; contentType: string } {
  const boundary = `----dashload${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, content, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
}

export async function upload(
  baseUrl: string,
  auth: { authorization: string },
  name: string,
  type: string,
  content: Buffer,
  signal?: AbortSignal,
): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const started = Date.now();
  const { body, contentType } = multipartBody(name, type, content);
  try {
    const res = await fetch(`${baseUrl}/v1/documents`, { method: "POST", headers: { ...auth, "content-type": contentType }, body, signal });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, ms: Date.now() - started };
  } catch {
    return { status: 0, body: {}, ms: Date.now() - started };
  }
}

/** Resident memory of a process (Linux), in MB. */
export async function rssMb(pid: number | undefined): Promise<number | null> {
  if (!pid) return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return kb ? Math.round(Number(kb[1]) / 1024) : null;
  } catch {
    return null;
  }
}
