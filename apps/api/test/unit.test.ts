import type { HistoryMessage } from "@dash-ai/contracts";
import { describe, expect, it } from "vitest";
import { withIdleTimeout, IdleTimeoutError } from "../src/chat/timeouts.js";
import { DEFAULT_TITLE, generateTitle } from "../src/chat/titles.js";
import { StreamRegistry } from "../src/chat/streamRegistry.js";
import { readFileSync } from "node:fs";
import { ConfigError, DEPRECATED_ENV_KEYS, ENV_KEYS, configWarnings, loadConfig } from "../src/config.js";
import { sanitizeFileName, signatureMatches } from "../src/documents/inspect.js";
import { redactSecrets, sanitizeUrl } from "../src/logging.js";
import {
  buildProviderMessages,
  filterHistoryForProvider,
  normalizeTurns,
  renderDocuments,
  trimHistory,
} from "../src/providers/context.js";
import { FakeAdapter, FAKE_TRIGGERS } from "../src/providers/fake.js";
import { buildSystemPrompt, MODE_INSTRUCTIONS } from "../src/providers/instructions.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { toProviderError, type ProviderChunk } from "../src/providers/types.js";
import { scryptSync } from "node:crypto";
import { hashPassword, hashToken, needsRehash, newSessionToken, verifyPassword } from "../src/security/crypto.js";
import { RateLimiter } from "../src/security/rateLimiter.js";
import type { DocumentRecord } from "../src/store/store.js";
import { contractsFixture, PNG_BYTES } from "./helpers.js";

/** Made-up provider settings for production-mode config tests (not real keys, not key-shaped). */
const TEST_PROVIDERS = {
  OPENAI_API_KEY: "test-openai-key-not-real",
  OPENAI_MODEL: "test-openai-model",
  ANTHROPIC_API_KEY: "test-anthropic-key-not-real",
  ANTHROPIC_MODEL: "test-claude-model",
};

/** Production with paid providers also needs spend limits and a price for every paid model. */
const TEST_COST_CONTROLS = {
  MAX_DAILY_AI_SPEND: "10",
  MAX_MONTHLY_AI_SPEND: "200",
  MODEL_PRICES: JSON.stringify({
    "openai:test-openai-model": { inputPerMillion: 1, outputPerMillion: 4 },
    "anthropic:test-claude-model": { inputPerMillion: 3, outputPerMillion: 15 },
    "openai:m": { inputPerMillion: 1, outputPerMillion: 4 },
    "anthropic:m": { inputPerMillion: 3, outputPerMillion: 15 },
  }),
};

describe("config", () => {
  it("applies defaults and treats empty strings as unset", () => {
    const c = loadConfig({ OPENAI_API_KEY: "", OPENAI_MODEL: " ", PORT: "" });
    expect(c.port).toBe(8787);
    expect(c.providerMode).toBe("live");
    expect(c.openai.apiKey).toBeUndefined();
    expect(c.openai.model).toBeUndefined();
  });

  it("rejects invalid values without echoing them", () => {
    try {
      loadConfig({ PORT: "not-a-port-secret-value" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toContain("PORT");
      expect((err as Error).message).not.toContain("secret-value");
    }
  });

  it("only configures a live provider when key and model are both present", () => {
    const registry = ProviderRegistry.fromConfig(
      loadConfig({ OPENAI_API_KEY: "sk-test-placeholder-000000000000", ANTHROPIC_MODEL: "some-model" }),
    );
    expect([...registry.configured()]).toEqual([]);
    expect(registry.warnings.join(" ")).toMatch(/OPENAI_MODEL/);
    expect(registry.warnings.join(" ")).toMatch(/ANTHROPIC_API_KEY/);
    expect(registry.status().every((s) => s.mode === "unconfigured")).toBe(true);

    const live = ProviderRegistry.fromConfig(
      loadConfig({ ANTHROPIC_API_KEY: "sk-ant-test-placeholder", ANTHROPIC_MODEL: "configured-claude-model" }),
    );
    expect([...live.configured()]).toEqual(["anthropic"]);
    expect(live.status().find((s) => s.id === "anthropic")).toMatchObject({
      configured: true,
      mode: "live",
      model: "configured-claude-model",
    });
  });

  describe(".env.example", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const entries = new Map(
      example
        .split("\n")
        .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!, m[2]!] as const),
    );

    it("documents exactly the variables the server reads (deprecated names left out)", () => {
      expect([...entries.keys()].sort()).toEqual(ENV_KEYS.filter((k) => !DEPRECATED_ENV_KEYS.includes(k)).sort());
      expect(DEPRECATED_ENV_KEYS.every((k) => ENV_KEYS.includes(k))).toBe(true);
    });

    it("holds no credentials, and parses as a valid configuration", () => {
      for (const secret of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BEDROCK_API_KEY", "DATABASE_URL", "DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_PREVIOUS_KEYS", "REDIS_URL", "METRICS_TOKEN", "OPERATOR_TOKEN", "FCM_SERVICE_ACCOUNT"]) {
        expect(entries.get(secret), secret).toBe("");
      }
      expect(() => loadConfig(Object.fromEntries(entries))).not.toThrow();
    });
  });

  describe("staging template (deploy/staging/staging.env.example)", () => {
    const template = new Map(
      readFileSync(new URL("../../../deploy/staging/staging.env.example", import.meta.url), "utf8")
        .split("\n")
        .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!, m[2]!] as const),
    );
    const secrets = ["DATABASE_URL", "DATA_ENCRYPTION_KEY", "DATA_ENCRYPTION_PREVIOUS_KEYS", "REDIS_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "BEDROCK_API_KEY", "METRICS_TOKEN", "OPERATOR_TOKEN", "FCM_SERVICE_ACCOUNT"];

    it("covers every variable, holds no secret values, and is production-safe once secrets are supplied", () => {
      expect([...template.keys()].sort()).toEqual(ENV_KEYS.filter((k) => !DEPRECATED_ENV_KEYS.includes(k)).sort());
      for (const secret of secrets) expect(template.get(secret), secret).toBe("");
      // Placeholders the operator would supply from the secret manager (none of them real).
      const filled = loadConfig({
        ...Object.fromEntries(template),
        DATABASE_URL: "postgres://placeholder", DATA_ENCRYPTION_KEY: "", REDIS_URL: "rediss://placeholder",
        ...TEST_PROVIDERS,
        ...TEST_COST_CONTROLS,
      });
      expect(configWarnings(filled)).toEqual([]);
      expect(filled).toMatchObject({ nodeEnv: "production", providerMode: "live", trustProxy: 1, database: { ssl: "require", autoMigrate: false, allowMemoryStore: false }, rateLimits: { backend: "redis" } });
    });

    describe("first bring-up overlay (deploy/staging/first-bringup.env.example)", () => {
      const overlay = new Map(
        readFileSync(new URL("../../../deploy/staging/first-bringup.env.example", import.meta.url), "utf8")
          .split("\n")
          .map((line) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
          .filter((m): m is RegExpExecArray => m !== null)
          .map((m) => [m[1]!, m[2]!] as const),
      );
      const infra = { DATABASE_URL: "postgres://placeholder", REDIS_URL: "rediss://placeholder" };

      it("names only known variables and no secret slot", () => {
        for (const key of overlay.keys()) {
          expect(ENV_KEYS, key).toContain(key);
          expect(secrets, key).not.toContain(key);
        }
      });

      it("starts in production with no provider key or Firebase credential, demonstration adapters only", () => {
        const config = loadConfig({ ...Object.fromEntries(template), ...Object.fromEntries(overlay), ...infra });
        expect(config).toMatchObject({
          nodeEnv: "production", providerMode: "fake", providerDetails: "hidden", trustProxy: 1,
          ai: { paidProvidersEnabled: false, freePoolEnabled: false, bedrockEnabled: false },
          push: { transport: "none", fcm: undefined },
          database: { ssl: "require", autoMigrate: false, allowMemoryStore: false },
          rateLimits: { backend: "redis" },
        });
        expect(configWarnings(config)).toEqual([expect.stringMatching(/^PROVIDER_MODE=fake in production/)]);
        const registry = ProviderRegistry.fromConfig(config);
        expect([...registry.configured()].every((p) => registry.get(p)!.demo)).toBe(true);
      });

      it("ignores provider keys copied in by mistake: nothing live is registered", () => {
        const config = loadConfig({ ...Object.fromEntries(template), ...Object.fromEntries(overlay), ...infra, ...TEST_PROVIDERS, ...TEST_COST_CONTROLS });
        const registry = ProviderRegistry.fromConfig(config);
        expect(registry.configured().size).toBeGreaterThan(0);
        expect([...registry.configured()].every((p) => registry.get(p)!.demo)).toBe(true);
      });
    });
  });

  it("warns about deliberate insecure choices in production only", () => {
    const shared = { RATE_LIMIT_BACKEND: "redis", REDIS_URL: "rediss://placeholder", ...TEST_PROVIDERS, ...TEST_COST_CONTROLS };
    const prod = (env: Record<string, string>) =>
      configWarnings(loadConfig({ NODE_ENV: "production", DATABASE_URL: "postgres://placeholder", ...shared, ...env })).join(" ");
    expect(prod({})).toBe("");
    expect(prod({ RATE_LIMIT_BACKEND: "memory" })).toMatch(/per instance/);
    expect(prod({ TRUST_PROXY: "1" })).toBe("");
    expect(prod({ REDIS_URL: "redis://placeholder" })).toMatch(/not encrypted in transit/);
    expect(() => loadConfig({ RATE_LIMIT_BACKEND: "redis" })).toThrow(/REDIS_URL is required/);
    expect(prod({ DATABASE_SSL: "disable" })).toMatch(/not encrypted in transit/);
    expect(prod({ DATABASE_SSL: "no-verify" })).toMatch(/not verified/);
    expect(prod({ LOG_LEVEL: "debug" })).toMatch(/LOG_LEVEL=debug/);
    expect(prod({ PROVIDER_MODE: "fake" })).toMatch(/demonstration/);
    // One live provider runs, but has nothing to fall back to.
    expect(prod({ ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "" })).toMatch(/no second provider to fall back to/);
    expect(prod({ OPENAI_API_KEY: "", OPENAI_MODEL: "" })).toMatch(/no second provider to fall back to/);
    expect(configWarnings(loadConfig({ DATABASE_SSL: "disable", LOG_LEVEL: "trace" }))).toEqual([]);
    // Defaults in production are the safe ones.
    expect(loadConfig({ NODE_ENV: "production", ...TEST_PROVIDERS, ...TEST_COST_CONTROLS }).database).toMatchObject({ ssl: "require", autoMigrate: false, allowMemoryStore: false });
  });

  describe("TRUST_PROXY", () => {
    const prodEnv = { NODE_ENV: "production", DATABASE_URL: "postgres://placeholder", RATE_LIMIT_BACKEND: "redis", REDIS_URL: "rediss://placeholder", ...TEST_PROVIDERS, ...TEST_COST_CONTROLS };
    const prod = (value: string) => loadConfig({ ...prodEnv, TRUST_PROXY: value });

    it("production refuses true: the server does not start", () => {
      expect(() => prod("true")).toThrow(ConfigError);
      expect(() => prod("true")).toThrow(/TRUST_PROXY=true is not allowed in production/);
      expect(() => prod(" true ")).toThrow(/TRUST_PROXY=true is not allowed in production/);
    });

    it("production refuses a /0 range, which trusts every address like true", () => {
      for (const value of ["0.0.0.0/0", "::/0", "10.0.0.0/8, 0.0.0.0/0"]) {
        expect(() => prod(value), value).toThrow(/must not contain a \/0 range in production/);
      }
    });

    it("development and tests still accept true (local proxies, the rate-limit suite)", () => {
      expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
      expect(loadConfig({ NODE_ENV: "test", TRUST_PROXY: "true" }).trustProxy).toBe(true);
      expect(loadConfig({ TRUST_PROXY: "0.0.0.0/0" }).trustProxy).toBe("0.0.0.0/0");
    });

    it("production accepts a hop count, proxy addresses/CIDRs, and false", () => {
      expect(prod("1").trustProxy).toBe(1);
      expect(prod("10").trustProxy).toBe(10);
      expect(prod("10.0.0.0/8").trustProxy).toBe("10.0.0.0/8");
      expect(prod("10.0.0.2, 192.168.0.0/16,fd00::/8").trustProxy).toBe("10.0.0.2, 192.168.0.0/16,fd00::/8");
      expect(prod("false").trustProxy).toBe(false);
      expect(configWarnings(prod("1"))).toEqual([]);
      expect(configWarnings(prod("10.0.0.0/8"))).toEqual([]);
    });

    it("refuses values that are not a count, an address or a CIDR, in every environment", () => {
      for (const value of ["yes", "0", "11", "-1", "1.5", "10.0.0.0/33", "fd00::/129", "999.1.1.1", "10.0.0.0/8,", "...", "ff", "loopback"]) {
        expect(() => loadConfig({ TRUST_PROXY: value }), value).toThrow(/TRUST_PROXY must be/);
        expect(() => prod(value), value).toThrow(/TRUST_PROXY must be/);
      }
    });
  });

  it("refuses the engineering view (PROVIDER_DETAILS=exposed) in production, live or demonstration", () => {
    const shared = { DATABASE_URL: "postgres://placeholder", RATE_LIMIT_BACKEND: "redis", REDIS_URL: "rediss://placeholder", ...TEST_PROVIDERS, ...TEST_COST_CONTROLS };
    for (const mode of ["live", "fake"]) {
      expect(() => loadConfig({ NODE_ENV: "production", PROVIDER_MODE: mode, PROVIDER_DETAILS: "exposed", ...shared })).toThrow(ConfigError);
      expect(() => loadConfig({ NODE_ENV: "production", PROVIDER_MODE: mode, PROVIDER_DETAILS: "exposed", ...shared })).toThrow(/PROVIDER_DETAILS=exposed is not allowed in production/);
      expect(loadConfig({ NODE_ENV: "production", PROVIDER_MODE: mode, PROVIDER_DETAILS: "hidden", ...shared }).providerDetails).toBe("hidden");
    }
    // Tests and development keep the engineering view.
    expect(loadConfig({ NODE_ENV: "test", PROVIDER_DETAILS: "exposed" }).providerDetails).toBe("exposed");
    expect(loadConfig({ PROVIDER_DETAILS: "exposed" }).providerDetails).toBe("exposed");
  });

  describe("production with PROVIDER_MODE=live refuses to start without usable provider credentials", () => {
    const prod = (env: Record<string, string>) => () => loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "live", ...TEST_COST_CONTROLS, ...env });
    const refusal = (env: Record<string, string>): string => {
      try {
        prod(env)();
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        return (err as Error).message;
      }
      throw new Error("expected a ConfigError");
    };

    it("no provider at all, including when PROVIDER_MODE is left unset (live is the default)", () => {
      expect(refusal({})).toMatch(/PROVIDER_MODE=live needs real AI provider credentials in production\. No AI provider is configured/);
      expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/No AI provider is configured/);
      expect(() => loadConfig({ NODE_ENV: "production", OPENAI_API_KEY: "  ", OPENAI_MODEL: "" })).toThrow(/No AI provider is configured/);
    });

    it("a key without its model, or a model without its key, even when the other provider is complete", () => {
      const anthropic = { ANTHROPIC_API_KEY: TEST_PROVIDERS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: TEST_PROVIDERS.ANTHROPIC_MODEL };
      expect(refusal({ OPENAI_API_KEY: TEST_PROVIDERS.OPENAI_API_KEY })).toMatch(/OPENAI_API_KEY is set without OPENAI_MODEL\./);
      expect(refusal({ OPENAI_MODEL: "m" })).toMatch(/OPENAI_MODEL is set without OPENAI_API_KEY\./);
      expect(refusal({ ...anthropic, OPENAI_API_KEY: TEST_PROVIDERS.OPENAI_API_KEY })).toMatch(/OPENAI_API_KEY is set without OPENAI_MODEL/);
      expect(refusal({ OPENAI_API_KEY: TEST_PROVIDERS.OPENAI_API_KEY, OPENAI_MODEL: "m", ANTHROPIC_MODEL: "m" })).toMatch(/ANTHROPIC_MODEL is set without ANTHROPIC_API_KEY/);
    });

    it("a key copied from an example", () => {
      for (const bad of ["your-api-key", "sk-...", "<ANTHROPIC_API_KEY>", "changeme", "short"]) {
        expect(refusal({ ANTHROPIC_API_KEY: bad, ANTHROPIC_MODEL: "m" }), bad).toMatch(/ANTHROPIC_API_KEY looks like a placeholder, not a real key\./);
      }
    });

    it("a key or model id that kept its quotes from the environment file", () => {
      expect(refusal({ OPENAI_API_KEY: `"${TEST_PROVIDERS.OPENAI_API_KEY}"`, OPENAI_MODEL: "m" })).toMatch(/OPENAI_API_KEY is wrapped in quotes/);
      expect(refusal({ ANTHROPIC_API_KEY: TEST_PROVIDERS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: "'claude-model'" })).toMatch(/ANTHROPIC_MODEL is wrapped in quotes/);
    });

    it("names variables only, never a value", () => {
      const secret = "test-openai-key-SECRETVALUE";
      const message = refusal({ OPENAI_API_KEY: secret, ANTHROPIC_API_KEY: "changeme", ANTHROPIC_MODEL: "model-SECRETVALUE" });
      expect(message).toMatch(/OPENAI_API_KEY is set without OPENAI_MODEL/);
      expect(message).not.toMatch(/SECRETVALUE|changeme/);
    });

    it("starts with one or both providers complete; fake mode, development and tests need no keys", () => {
      expect(prod(TEST_PROVIDERS)().providerMode).toBe("live");
      expect(prod({ ANTHROPIC_API_KEY: TEST_PROVIDERS.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: "m" })).not.toThrow();
      expect(loadConfig({ NODE_ENV: "production", PROVIDER_MODE: "fake" }).providerMode).toBe("fake");
      // Development keeps starting and the registry reports what is missing instead.
      const dev = loadConfig({ NODE_ENV: "development", PROVIDER_MODE: "live", OPENAI_API_KEY: TEST_PROVIDERS.OPENAI_API_KEY });
      expect(ProviderRegistry.fromConfig(dev).warnings).toContain("OpenAI needs both OPENAI_API_KEY and OPENAI_MODEL.");
      expect(() => loadConfig({ NODE_ENV: "test", PROVIDER_MODE: "live" })).not.toThrow();
    });
  });

  it("fake mode activates clearly-labelled fake adapters for both providers", () => {
    const registry = ProviderRegistry.fromConfig(loadConfig({ PROVIDER_MODE: "fake" }));
    expect(registry.status().map((s) => s.mode)).toEqual(["fake", "fake", "unconfigured"]);
    expect(registry.get("openai")?.demo).toBe(true);
    expect(registry.warnings[0]).toMatch(/fake/);
  });
});

describe("security utilities", () => {
  it("hashes and verifies passwords", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });

  it("hashes at OWASP's scrypt cost and still verifies (then upgrades) older hashes", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash.split("$").slice(1, 4)).toEqual(["32768", "8", "3"]);
    expect(needsRehash(hash)).toBe(false);
    // A hash made by the previous release (N=2^14, r=8, p=1).
    const salt = Buffer.alloc(16, 1);
    const legacyKey = scryptSync("correct horse battery".normalize("NFKC"), salt, 64, { N: 16_384, r: 8, p: 1 });
    const legacy = ["scrypt", 16_384, 8, 1, salt.toString("base64url"), legacyKey.toString("base64url")].join("$");
    expect(await verifyPassword("correct horse battery", legacy)).toBe(true);
    expect(await verifyPassword("wrong", legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
  });

  it("refuses stored hashes with out-of-range costs instead of running them", async () => {
    const [, , , , salt, key] = (await hashPassword("pw")).split("$");
    for (const [N, r, p] of [["1024", "8", "1"], ["4194304", "8", "1"], ["30000", "8", "1"], ["32768", "1", "1"], ["32768", "8", "64"], ["1e5", "8", "1"]]) {
      const tampered = ["scrypt", N, r, p, salt, key].join("$");
      expect(await verifyPassword("pw", tampered), tampered.slice(0, 30)).toBe(false);
    }
    expect(await verifyPassword("pw", ["scrypt", "32768", "8", "3", "c2hvcnQ", key].join("$"))).toBe(false);
  });

  it("creates opaque tokens and stores only hashes", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^dash_[A-Za-z0-9_-]{40,}$/);
    expect(hashToken(token)).toHaveLength(64);
    expect(hashToken(token)).not.toContain(token);
  });

  it("rate limiter refills over time", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 60_000, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const blocked = limiter.consume("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(limiter.consume("other").allowed).toBe(true);
    now += 30_000;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("redacts secrets from strings", () => {
    // Built at runtime so no credential-shaped literal is committed.
    const fakeOpenAi = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123"].join("-");
    const fakeAnthropic = ["sk", "ant", "api03", "abcdefghijklmnop"].join("-");
    const fakeSession = `dash_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const text = `key ${fakeOpenAi} and ${fakeAnthropic} and Bearer ${fakeSession} password=hunter22`;
    const out = redactSecrets(text);
    expect(out).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123/);
    expect(out).not.toContain("sk-ant-api03");
    expect(out).not.toContain("hunter22");
    expect(out).toContain("[redacted]");
  });

  it("strips query strings from logged URLs", () => {
    expect(sanitizeUrl("/v1/conversations?search=private")).toBe("/v1/conversations?[redacted]");
    expect(sanitizeUrl("/health")).toBe("/health");
  });
});

describe("titles", () => {
  const cases = JSON.parse(contractsFixture("titles.json")) as { input: string; expected: string }[];
  it.each(cases)("$input → $expected", ({ input, expected }) => {
    expect(generateTitle(input)).toBe(expected);
  });

  it("never exceeds 49 characters", () => {
    expect(generateTitle("word ".repeat(100)).length).toBeLessThanOrEqual(49);
    expect(generateTitle("   ")).toBe(DEFAULT_TITLE);
  });
});

describe("provider context", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "q1", origin: null },
    { role: "assistant", content: "openai answer", origin: "openai" },
    { role: "assistant", content: "claude answer", origin: "anthropic" },
    { role: "user", content: "q2", origin: null },
    { role: "assistant", content: "claude answer 2", origin: "anthropic" },
  ];

  it("keeps every earlier answer as DASH AI's own turn, whichever provider wrote it", () => {
    const all = ["q1", "openai answer", "claude answer", "q2", "claude answer 2"];
    expect(filterHistoryForProvider(history, "openai").map((m) => m.content)).toEqual(all);
    expect(filterHistoryForProvider(history, "anthropic").map((m) => m.content)).toEqual(all);
    // Newer clients send no origin at all.
    expect(filterHistoryForProvider(history.map(({ role, content }) => ({ role, content })), "openai")).toHaveLength(5);
  });

  it("merges consecutive turns so providers receive alternating roles", () => {
    const messages = buildProviderMessages("openai", history, "q3", []);
    expect(messages).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "openai answer\n\nclaude answer" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "claude answer 2" },
      { role: "user", content: "q3" },
    ]);
  });

  it("drops leading assistant turns", () => {
    expect(
      normalizeTurns([
        { role: "assistant", content: "a" },
        { role: "user", content: "b" },
      ]),
    ).toEqual([{ role: "user", content: "b" }]);
  });

  it("trims the oldest history first", () => {
    const long: HistoryMessage[] = [
      { role: "user", content: "a".repeat(10), origin: null },
      { role: "user", content: "b".repeat(10), origin: null },
    ];
    expect(trimHistory(long, 15).map((m) => m.content[0])).toEqual(["b"]);
  });

  it("wraps documents in delimited, escaped blocks and truncates", () => {
    const doc = (name: string, text: string): DocumentRecord => ({
      id: "doc-00000001",
      userId: "u",
      name,
      kind: "txt",
      mimeType: "text/plain",
      sizeBytes: text.length,
      status: "ready",
      statusDetail: "",
      extractedText: text,
      pageCount: null,
      createdAt: new Date().toISOString(),
    });
    const rendered = renderDocuments([doc('a"<b>.txt', "hello"), doc("big.txt", "x".repeat(70_000))]);
    expect(rendered).toContain('<document name="a&quot;&lt;b&gt;.txt" type="txt">\nhello\n</document>');
    expect(rendered).toContain('name="big.txt" type="txt" truncated="true"');
  });

  it("each mode has distinct instructions and research never claims web access", () => {
    expect(new Set(Object.values(MODE_INSTRUCTIONS)).size).toBe(5);
    expect(MODE_INSTRUCTIONS.research).toMatch(/no live web access/);
    const prompt = buildSystemPrompt("writing", new FakeAdapter("anthropic", 0));
    expect(prompt).toContain(MODE_INSTRUCTIONS.writing);
  });

  it("every provider is told it is DASH AI; the prompt never names the provider or model running it", () => {
    for (const adapter of [new FakeAdapter("openai", 0), new FakeAdapter("anthropic", 0)]) {
      const prompt = buildSystemPrompt("general", adapter);
      expect(prompt.startsWith("You are DASH AI")).toBe(true);
      expect(prompt).toContain("I'm DASH AI. DASH AI may use third-party AI infrastructure to help process requests.");
      // Only named in the instruction never to claim them, not as "you are running on ...".
      expect(prompt).not.toMatch(/running on|model:/i);
      expect(prompt).not.toContain(adapter.model);
    }
  });
});

describe("fake adapter", () => {
  const collect = async (iterable: AsyncIterable<ProviderChunk>) => {
    const out: ProviderChunk[] = [];
    for await (const c of iterable) out.push(c);
    return out;
  };

  it("labels its output as a demonstration", async () => {
    const chunks = await collect(
      new FakeAdapter("openai", 0).stream({
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxOutputTokens: 100,
        signal: new AbortController().signal,
      }),
    );
    const text = chunks.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toMatch(/^\*\*Demonstration answer from DASH AI\.\*\*/);
    expect(text).toContain("no AI service received your prompt");
    expect(text).not.toMatch(/OpenAI|Claude|Anthropic|OPENAI_|ANTHROPIC_/);
    expect(chunks.at(-1)).toMatchObject({ type: "finish", finishReason: "stop" });
  });

  it("supports failure and cancellation triggers", async () => {
    const adapter = new FakeAdapter("anthropic", 0);
    await expect(
      collect(
        adapter.stream({
          system: "s",
          messages: [{ role: "user", content: FAKE_TRIGGERS.error }],
          maxOutputTokens: 10,
          signal: new AbortController().signal,
        }),
      ),
    ).rejects.toMatchObject({ code: "provider_error", retryable: true });

    const controller = new AbortController();
    const pending = collect(
      adapter.stream({
        system: "s",
        messages: [{ role: "user", content: FAKE_TRIGGERS.hang }],
        maxOutputTokens: 10,
        signal: controller.signal,
      }),
    );
    controller.abort("cancelled");
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("provider error mapping", () => {
  it("maps HTTP statuses without copying provider messages", () => {
    const withStatus = (status: number) => Object.assign(new Error("secret provider detail"), { status });
    expect(toProviderError("OpenAI", withStatus(401))).toMatchObject({ code: "provider_error", retryable: false });
    expect(toProviderError("OpenAI", withStatus(429))).toMatchObject({ code: "rate_limited", retryable: true });
    expect(toProviderError("OpenAI", withStatus(503))).toMatchObject({ code: "provider_error", retryable: true });
    expect(toProviderError("OpenAI", withStatus(400)).message).not.toContain("secret provider detail");
  });

  it("classifies aborts by reason", () => {
    const timeout = new AbortController();
    timeout.abort("timeout");
    expect(toProviderError("Claude", new Error("x"), timeout.signal).code).toBe("provider_timeout");
    const cancel = new AbortController();
    cancel.abort("cancelled");
    expect(toProviderError("Claude", new Error("x"), cancel.signal).code).toBe("cancelled");
  });
});

describe("idle timeout", () => {
  it("passes items through", async () => {
    async function* source() {
      yield 1;
      yield 2;
    }
    const out: number[] = [];
    for await (const n of withIdleTimeout(source(), 1_000, () => undefined)) out.push(n);
    expect(out).toEqual([1, 2]);
  });

  it("fires onIdle and throws if the source ignores the abort", async () => {
    let idled = false;
    const never: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<number>>(() => undefined) }),
    };
    const run = async () => {
      for await (const _ of withIdleTimeout(never, 30, () => (idled = true), 30)) {
        // unreachable
      }
    };
    await expect(run()).rejects.toBeInstanceOf(IdleTimeoutError);
    expect(idled).toBe(true);
  });
});

describe("stream registry", () => {
  it("only lets the owner cancel", async () => {
    const registry = new StreamRegistry();
    const controller = new AbortController();
    expect(await registry.acquire("s1", "alice", 3, controller)).toEqual({ ok: true });
    expect(registry.countForUser("alice")).toBe(1);
    expect(await registry.cancel("bob", "s1")).toBe(false);
    expect(controller.signal.aborted).toBe(false);
    expect(await registry.cancel("alice", "s1")).toBe(true);
    expect(controller.signal.reason).toBe("cancelled");
    await registry.release("s1");
    await registry.release("s1"); // a second release is harmless
    expect(registry.size).toBe(0);
  });

  it("admission is a synchronous check-and-take: concurrent requests never all pass the limit", async () => {
    const registry = new StreamRegistry();
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => registry.acquire(`s${i}`, "alice", 3, new AbortController())));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === "full")).toHaveLength(5);
    // Another account is unaffected.
    expect(await registry.acquire("b1", "bob", 3, new AbortController())).toEqual({ ok: true });
  });

  it("a deleted account's streams stop and it cannot start new ones", async () => {
    const registry = new StreamRegistry();
    const controller = new AbortController();
    await registry.acquire("s1", "alice", 3, controller);
    await registry.cancelAllForUser("alice");
    expect(controller.signal.aborted).toBe(true);
    expect(await registry.acquire("s2", "alice", 3, new AbortController())).toEqual({ ok: false, reason: "gone" });
  });
});

describe("upload inspection", () => {
  it("checks file signatures", () => {
    expect(signatureMatches("image", PNG_BYTES)).toBe(true);
    expect(signatureMatches("pdf", PNG_BYTES)).toBe(false);
    expect(signatureMatches("pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(signatureMatches("txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(false);
    expect(signatureMatches("image", Buffer.from("RIFF0000WEBPVP8 "))).toBe(true);
  });

  it("sanitises file names", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("a\u0000b\u001f.txt")).toBe("ab.txt");
    expect(sanitizeFileName("")).toBe("document");
  });
});
