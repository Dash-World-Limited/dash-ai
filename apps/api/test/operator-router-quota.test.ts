import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { testConfig } from "./helpers.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe("operator router quota view", () => {
  it("keeps quota diagnostics behind the operator credential", async () => {
    const operator = "q".repeat(40);
    const { app } = await buildApp({ config: testConfig({ PROVIDER_DETAILS: "hidden", OPERATOR_TOKEN: operator }) });
    apps.push(app);
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/v1/router" })).statusCode).toBe(404);
    const res = await app.inject({ method: "GET", url: "/v1/router", headers: { authorization: `Bearer ${operator}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quota).toBeTypeOf("object");
    expect(body.quota.openai).toMatchObject({
      state: { hardExhausted: false, softExhausted: false, remainingFraction: null },
      snapshot: null,
    });
    expect(body.quota.anthropic).toMatchObject({
      state: { hardExhausted: false, softExhausted: false, remainingFraction: null },
      snapshot: null,
    });
    expect(JSON.stringify(body)).not.toContain("prompt");
  });
});
