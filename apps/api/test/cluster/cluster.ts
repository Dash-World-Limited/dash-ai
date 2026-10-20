import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer as createTcpServer, connect as tcpConnect, type Server as TcpServer, type Socket } from "node:net";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeStream, type StreamEvent } from "@dash-ai/contracts";
import pg from "pg";
import { LocalRedis, freePort } from "../redisTestServer.js";

/**
 * A local multi-instance DASH AI: several real API processes (src/index.ts, fake providers only)
 * sharing one real PostgreSQL database and one real Redis, behind a small round-robin load balancer
 * that appends X-Forwarded-For like a real one. Used by the multi-instance tests and the load scripts
 * in scripts/load. Nothing here can reach a paid provider: PROVIDER_MODE is always "fake".
 *
 * Requires TEST_DATABASE_URL (a server where a throwaway database may be created) and either
 * TEST_REDIS_URL or a local redis-server binary.
 */

const apiDir = fileURLToPath(new URL("../../", import.meta.url));
const entry = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

export interface ApiNodeOptions {
  env: Record<string, string>;
  /** Extra Node flags (for example a heap cap). */
  nodeFlags?: string[];
}

/** One API process. Its stdout/stderr (JSON logs) are kept for assertions. */
export class ApiNode {
  process: ChildProcess | undefined;
  logs = "";
  exitCode: number | null = null;
  exited: Promise<number | null> = Promise.resolve(null);

  constructor(
    readonly name: string,
    readonly port: number,
    private readonly options: ApiNodeOptions,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get pid(): number | undefined {
    return this.process?.pid;
  }

  async start(timeoutMs = 30_000): Promise<void> {
    this.exitCode = null;
    const child = spawn(process.execPath, [...(this.options.nodeFlags ?? []), "--import", tsxLoader, entry], {
      cwd: apiDir,
      env: { PATH: process.env.PATH ?? "", ...this.options.env, PORT: String(this.port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    const append = (chunk: Buffer) => {
      this.logs += chunk.toString("utf8");
      if (this.logs.length > 8_000_000) this.logs = this.logs.slice(-4_000_000);
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve((this.exitCode = code ?? -1))));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exitCode !== null) throw new Error(`${this.name} exited during start-up (${this.exitCode}):\n${this.logs.slice(-4000)}`);
      try {
        const res = await fetch(`${this.url}/ready`);
        if (res.status === 200) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${this.name} did not become ready:\n${this.logs.slice(-4000)}`);
  }

  /** SIGKILL: the process dies with no cleanup at all (a crashed or OOM-killed instance). */
  async kill(): Promise<void> {
    if (!this.process || this.exitCode !== null) return;
    this.process.kill("SIGKILL");
    await this.exited;
  }

  /** SIGTERM: a rolling deploy or scale-in. Resolves with the exit code. */
  async terminate(): Promise<number | null> {
    if (!this.process || this.exitCode !== null) return this.exitCode;
    this.process.kill("SIGTERM");
    return this.exited;
  }

  /** Parsed JSON log lines. */
  logLines(): Array<Record<string, unknown>> {
    return this.logs
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  }
}

/** Round-robin HTTP load balancer (streams bodies both ways, appends X-Forwarded-For). */
export class LoadBalancer {
  private next = 0;
  readonly server: Server;
  port = 0;
  /** Requests answered 502 because the chosen instance was down (a real LB would retry/eject). */
  upstreamErrors = 0;

  constructor(private readonly targets: () => ApiNode[]) {
    this.server = createServer((req, res) => this.forward(req, res));
    this.server.keepAliveTimeout = 65_000;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async listen(): Promise<void> {
    this.port = await freePort();
    await new Promise<void>((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }

  private forward(req: IncomingMessage, res: ServerResponse): void {
    const live = this.targets().filter((n) => n.exitCode === null && n.process);
    if (live.length === 0) {
      res.writeHead(502).end();
      return;
    }
    const target = live[this.next++ % live.length]!;
    const forwardedFor = [req.headers["x-forwarded-for"], req.socket.remoteAddress].filter(Boolean).join(", ");
    const upstream = httpRequest(
      { host: "127.0.0.1", port: target.port, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-for": forwardedFor, "x-dash-test-node": target.name } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, { ...up.headers, "x-dash-test-node": target.name });
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      this.upstreamErrors++;
      if (!res.headersSent) res.writeHead(502);
      res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/**
 * A TCP proxy in front of Redis or PostgreSQL that a test can break: "down" drops every connection
 * and refuses new ones (an outage or restart), "slow" delays every chunk (a saturated server).
 */
export class FaultProxy {
  private server: TcpServer;
  private readonly sockets = new Set<Socket>();
  mode: "up" | "down" | "slow" = "up";
  delayMs = 0;
  port = 0;

  constructor(private readonly targetHost: string, private readonly targetPort: number) {
    this.server = createTcpServer((client) => this.accept(client));
  }

  static async start(targetUrl: string): Promise<FaultProxy> {
    const u = new URL(targetUrl);
    const proxy = new FaultProxy(u.hostname, Number(u.port || (u.protocol.startsWith("postgres") ? 5432 : 6379)));
    proxy.port = await freePort();
    await new Promise<void>((resolve) => proxy.server.listen(proxy.port, "127.0.0.1", resolve));
    return proxy;
  }

  /** `targetUrl` with its host and port replaced by this proxy's. */
  urlFor(targetUrl: string): string {
    const u = new URL(targetUrl);
    u.hostname = "127.0.0.1";
    u.port = String(this.port);
    return u.toString();
  }

  private accept(client: Socket): void {
    if (this.mode === "down") {
      client.destroy();
      return;
    }
    const upstream = tcpConnect(this.targetPort, this.targetHost);
    this.sockets.add(client).add(upstream);
    const pipe = (from: Socket, to: Socket) =>
      from.on("data", (chunk) => {
        if (this.mode === "slow" && this.delayMs > 0) {
          from.pause();
          setTimeout(() => {
            to.write(chunk);
            from.resume();
          }, this.delayMs);
        } else to.write(chunk);
      });
    pipe(client, upstream);
    pipe(upstream, client);
    const close = () => {
      client.destroy();
      upstream.destroy();
      this.sockets.delete(client);
      this.sockets.delete(upstream);
    };
    client.on("close", close).on("error", close);
    upstream.on("close", close).on("error", close);
  }

  down(): void {
    this.mode = "down";
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  up(): void {
    this.mode = "up";
  }

  slow(delayMs: number): void {
    this.mode = "slow";
    this.delayMs = delayMs;
  }

  async close(): Promise<void> {
    this.down();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export interface ClusterOptions {
  instances: number;
  /** Extra environment for every instance (limits, timeouts, fake delays). */
  env?: Record<string, string>;
  /** Per-instance environment overrides, by index. */
  envFor?: (index: number) => Record<string, string>;
  /** Use Redis (the default). False runs every instance on per-process memory limits. */
  redis?: boolean;
  nodeFlags?: string[];
}

/** A throwaway database on the TEST_DATABASE_URL server. */
async function createDatabase(adminUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `dash_mi_${randomBytes(5).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await c.end();
    },
  };
}

export class Cluster {
  readonly nodes: ApiNode[] = [];
  readonly lb: LoadBalancer;
  redis: LocalRedis | undefined;
  redisUrl: string | undefined;
  /** Every instance reaches Redis through this, so a test can break or slow it. */
  redisProxy: FaultProxy | undefined;
  /** The real Redis behind the proxy (for test assertions). */
  directRedisUrl: string | undefined;
  databaseUrl = "";
  private dropDatabase: () => Promise<void> = async () => undefined;
  /** Generated per cluster; never printed. */
  readonly encryptionKey = randomBytes(32).toString("base64");
  readonly metricsToken = randomBytes(24).toString("hex");

  private constructor(private readonly options: ClusterOptions) {
    this.lb = new LoadBalancer(() => this.nodes);
  }

  static async start(options: ClusterOptions): Promise<Cluster> {
    const cluster = new Cluster(options);
    try {
      await cluster.boot();
    } catch (err) {
      await cluster.stop();
      throw err;
    }
    return cluster;
  }

  private async boot(): Promise<void> {
    const admin = process.env.TEST_DATABASE_URL;
    if (!admin) throw new Error("TEST_DATABASE_URL is not set");
    const db = await createDatabase(admin);
    this.databaseUrl = db.url;
    this.dropDatabase = db.drop;
    if (this.options.redis !== false) {
      if (process.env.TEST_REDIS_URL) this.directRedisUrl = process.env.TEST_REDIS_URL;
      else {
        this.redis = await LocalRedis.start();
        this.directRedisUrl = this.redis.url;
      }
      this.redisProxy = await FaultProxy.start(this.directRedisUrl);
      this.redisUrl = this.redisProxy.urlFor(this.directRedisUrl);
    }
    for (let i = 0; i < this.options.instances; i++) this.nodes.push(new ApiNode(`api-${String.fromCharCode(97 + i)}`, await freePort(), { env: this.envFor(i), nodeFlags: this.options.nodeFlags }));
    // The first instance applies the migrations; the rest start together.
    await this.nodes[0]!.start();
    await Promise.all(this.nodes.slice(1).map((n) => n.start()));
    await this.lb.listen();
  }

  envFor(index: number): Record<string, string> {
    return {
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      PROVIDER_MODE: "fake",
      PROVIDER_DETAILS: "hidden",
      DATABASE_URL: this.databaseUrl,
      DATA_ENCRYPTION_KEY: this.encryptionKey,
      METRICS_TOKEN: this.metricsToken,
      // The load balancer is the one trusted hop: X-Forwarded-For entries written by clients are not believed.
      TRUST_PROXY: "1",
      AUTOMATIONS_TICK_MS: "1000",
      PUSH_TRANSPORT: "fake",
      ...(this.redisUrl ? { RATE_LIMIT_BACKEND: "redis", REDIS_URL: this.redisUrl, REDIS_KEY_PREFIX: this.sharedPrefix } : {}),
      ...this.options.env,
      ...this.options.envFor?.(index),
    };
  }

  /** One Redis key prefix for the whole cluster (all instances agree; clusters sharing the CI Redis never collide). */
  readonly sharedPrefix = `dash:mi:${randomBytes(4).toString("hex")}:`;

  node(i: number): ApiNode {
    return this.nodes[i]!;
  }

  /** Adds and starts another instance (scale-out, or the replacement in a rolling deploy). */
  async addNode(env: Record<string, string> = {}): Promise<ApiNode> {
    const i = this.nodes.length;
    const node = new ApiNode(`api-${String.fromCharCode(97 + i)}`, await freePort(), { env: { ...this.envFor(i), ...env }, nodeFlags: this.options.nodeFlags });
    this.nodes.push(node);
    await node.start();
    return node;
  }

  async metrics(node: ApiNode): Promise<string> {
    const res = await fetch(`${node.url}/metrics`, { headers: { authorization: `Bearer ${this.metricsToken}` } });
    return res.text();
  }

  async stop(): Promise<void> {
    await Promise.all(this.nodes.map((n) => n.kill()));
    await this.lb.close().catch(() => undefined);
    await this.redisProxy?.close();
    await this.redis?.stop();
    await this.dropDatabase();
  }
}

// ---- client helpers -----------------------------------------------------------------------------

export interface Account {
  token: string;
  userId: string;
  email: string;
  auth: { authorization: string };
}

let accountCounter = 0;

export async function signUp(baseUrl: string, label = "user"): Promise<Account> {
  const email = `${label}-${++accountCounter}-${randomBytes(4).toString("hex")}@example.com`;
  const res = await fetch(`${baseUrl}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery", displayName: "Load Test" }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id, email, auth: { authorization: `Bearer ${body.token}` } };
}

export const newId = (): string => crypto.randomUUID();

export function chatPayload(content: string, conversationId = newId()) {
  return { conversationId, mode: "general", modelChoice: "smart", message: { id: newId(), content, attachmentIds: [] }, history: [] };
}

/** An SSE chat stream in progress: headers are in, events arrive as they are written. */
export interface OpenStream {
  status: number;
  streamId: string | null;
  node: string | null;
  /** JSON error body for a refused stream. */
  error?: { code: string; message: string };
  events: StreamEvent[];
  /** Resolves when the server ends the response (or the connection breaks). */
  done: Promise<{ events: StreamEvent[]; broken: boolean }>;
  firstEventAt: Promise<number>;
  abort(): void;
}

export async function openStream(baseUrl: string, account: Account, content: string, conversationId?: string): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/v1/chat/stream`, {
    method: "POST",
    headers: { ...account.auth, "content-type": "application/json" },
    body: JSON.stringify(chatPayload(content, conversationId)),
    signal: controller.signal,
  });
  const base = { status: res.status, streamId: res.headers.get("x-stream-id"), node: res.headers.get("x-dash-test-node"), abort: () => controller.abort() };
  if (res.status !== 200) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
    return { ...base, error: body.error, events: [], done: Promise.resolve({ events: [], broken: false }), firstEventAt: Promise.resolve(0) };
  }
  const events: StreamEvent[] = [];
  let markFirst: (t: number) => void = () => undefined;
  const firstEventAt = new Promise<number>((r) => (markFirst = r));
  const done = (async () => {
    let broken = false;
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const cut = buffer.lastIndexOf("\n\n");
        if (cut < 0) continue;
        const complete = buffer.slice(0, cut + 2);
        buffer = buffer.slice(cut + 2);
        for (const e of decodeStream(complete)) {
          if (events.length === 0) markFirst(Date.now());
          events.push(e);
        }
      }
    } catch {
      broken = true;
    }
    markFirst(0);
    return { events, broken };
  })();
  return { ...base, events, done, firstEventAt };
}

export async function cancelStream(baseUrl: string, account: Account, streamId: string): Promise<{ status: number; cancelled?: boolean }> {
  const res = await fetch(`${baseUrl}/v1/chat/streams/${streamId}/cancel`, { method: "POST", headers: account.auth });
  const body = (await res.json().catch(() => ({}))) as { cancelled?: boolean };
  return { status: res.status, cancelled: body.cancelled };
}

export const finalEvent = (events: StreamEvent[]) => events.filter((e) => e.event === "message.end" || e.event === "message.error" || e.event === "stream.end" || e.event === "stream.error");

/** Waits until `check` is true (polling), or fails after `timeoutMs`. */
export async function eventually(check: () => Promise<boolean> | boolean, timeoutMs = 10_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("condition not met in time");
}

/** Sum of a Prometheus metric's samples whose labels include every `labels` pair. */
export function metricValue(text: string, name: string, labels: Record<string, string> = {}): number {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN)$/.exec(line);
    if (!m || m[1] !== name) continue;
    const labelText = m[2] ?? "";
    if (Object.entries(labels).every(([k, v]) => labelText.includes(`${k}="${v}"`))) total += Number(m[3]);
  }
  return total;
}
