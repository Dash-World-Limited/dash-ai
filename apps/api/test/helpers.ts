import { readFileSync } from "node:fs";
import { decodeStream, type AuthResponse, type ProviderId, type StreamEvent } from "@dash-ai/contracts";
import type { FastifyInstance } from "fastify";
import JSZip from "jszip";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import type { PushTransport } from "../src/push/types.js";
import type { Store } from "../src/store/store.js";
import { createTestPgStore } from "./pgTestStore.js";
import type { ProviderAdapter, ProviderChunk, ProviderRequest } from "../src/providers/types.js";

export function contractsFixture(name: string): string {
  return readFileSync(new URL(`../../../packages/contracts/fixtures/${name}`, import.meta.url), "utf8");
}

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    PROVIDER_MODE: "fake",
    // Engineering mode: these tests check which provider ran. Provider-neutral behaviour (the
    // production default, "hidden") is covered by provider-neutrality.test.ts.
    PROVIDER_DETAILS: "exposed",
    FAKE_STREAM_DELAY_MS: "0",
    ...overrides,
  });
}

export class LogCapture {
  readonly lines: string[] = [];
  write(msg: string): void {
    this.lines.push(msg);
  }
  get text(): string {
    return this.lines.join("");
  }
}

/** The API suite runs against Postgres when DASH_TEST_STORE=postgres (pnpm test:pg), else in memory. */
export const USING_POSTGRES = process.env.DASH_TEST_STORE === "postgres";

export async function makeApp(
  options: {
    config?: AppConfig;
    providers?: ProviderRegistry;
    logs?: LogCapture;
    env?: Record<string, string>;
    store?: Store;
    now?: () => Date;
    pushTransports?: PushTransport[];
  } = {},
) {
  const config = options.config ?? testConfig({ ...(options.logs ? { LOG_LEVEL: "debug" } : {}), ...options.env });
  const pg = !options.store && USING_POSTGRES ? await createTestPgStore() : undefined;
  const { app, context } = await buildApp({
    config,
    providers: options.providers,
    logStream: options.logs,
    store: options.store ?? pg?.store,
    now: options.now,
    pushTransports: options.pushTransports,
  });
  if (pg) app.addHook("onClose", async () => pg.dispose());
  await app.ready();
  return { app, context, config };
}

let userCounter = 0;

export async function register(app: FastifyInstance, email?: string): Promise<AuthResponse & { auth: { authorization: string } }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email: email ?? `user${++userCounter}-${Date.now()}@example.com`, password: "correct horse battery", displayName: "Test User" },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as AuthResponse;
  return { ...body, auth: { authorization: `Bearer ${body.token}` } };
}

export function sse(payload: string): StreamEvent[] {
  return decodeStream(payload);
}

let idCounter = 0;
export function testId(prefix = "id"): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString().padStart(8, "0")}-${Math.random().toString(16).slice(2, 10)}`;
}

export function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: testId("conv"),
    mode: "general",
    modelChoice: "openai",
    message: { id: testId("msg"), content: "Hello Dash", attachmentIds: [] },
    history: [],
    ...overrides,
  };
}

/** Records every request and replays scripted chunks. */
export class SpyAdapter implements ProviderAdapter {
  readonly requests: ProviderRequest[] = [];
  readonly displayName: string;
  readonly model: string;

  constructor(
    readonly id: ProviderId,
    private readonly chunks: ProviderChunk[] = [
      { type: "text", text: "Hello " },
      { type: "text", text: "from spy" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 11, outputTokens: 3 } },
    ],
    readonly demo = false,
  ) {
    this.displayName = id === "openai" ? "OpenAI" : "Claude";
    this.model = `spy-${id}`;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderChunk> {
    this.requests.push(request);
    for (const chunk of this.chunks) yield chunk;
  }
}

export function spyRegistry(ids: ProviderId[] = ["openai", "anthropic"]) {
  const spies: Partial<Record<ProviderId, SpyAdapter>> = {};
  for (const id of ids) spies[id] = new SpyAdapter(id);
  return { registry: new ProviderRegistry(spies), spies };
}

export function multipart(filename: string, contentType: string, content: Buffer) {
  const boundary = `----dashtest${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

/** Builds a small, valid single-page PDF whose text layer contains `text`. */
export function makePdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** Builds a minimal DOCX containing one paragraph. */
export async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

export const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4" +
    "8f0000000049454e44ae426082",
  "hex",
);

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
