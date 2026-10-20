import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The real entry point, not just loadConfig: a production server told to believe every
// X-Forwarded-For entry must exit before it opens a port.
describe("API start-up with TRUST_PROXY in production", () => {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

  it("TRUST_PROXY=true exits with status 1 and names the variable, not a value", () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "production", TRUST_PROXY: "true" };
    const result = spawnSync(process.execPath, ["--import", "tsx", entry], { env, encoding: "utf8", timeout: 30_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/TRUST_PROXY=true is not allowed in production/);
  }, 40_000);
});
