import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/** CI sets TEST_REDIS_URL (a Redis service container); locally a redis-server binary is used if installed. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
export const REDIS_BINARY_AVAILABLE = spawnSync("redis-server", ["--version"], { stdio: "ignore" }).status === 0;
export const REDIS_AVAILABLE = Boolean(TEST_REDIS_URL) || REDIS_BINARY_AVAILABLE;

if (process.env.REQUIRE_REDIS_TESTS === "1" && !REDIS_AVAILABLE) {
  throw new Error("REQUIRE_REDIS_TESTS=1 but neither TEST_REDIS_URL nor a redis-server binary is available");
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** A throwaway redis-server this test controls (it can be stopped and started to simulate an outage). */
export class LocalRedis {
  private process: ChildProcess | undefined;

  private constructor(readonly port: number) {}

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  static async start(): Promise<LocalRedis> {
    const redis = new LocalRedis(await freePort());
    await redis.start();
    return redis;
  }

  async start(): Promise<void> {
    this.process = spawn("redis-server", ["--port", String(this.port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (spawnSync("redis-cli", ["-p", String(this.port), "ping"], { encoding: "utf8" }).stdout?.trim() === "PONG") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("redis-server did not start");
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc || proc.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGKILL");
    });
  }
}
