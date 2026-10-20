// A separate Node process that races spend reservations against the parent test (spend-reservations
// test, "several Node processes"). Arguments come from the environment; the result is one JSON line.
import { PostgresStore } from "../src/store/postgresStore.js";
import { testCipher } from "./pgTestStore.js";

const env = process.env;
const store = await PostgresStore.connect({ connectionString: env.TEST_DATABASE_URL!, cipher: testCipher(), schema: env.WORKER_SCHEMA!, poolMax: 8 });
const limits = JSON.parse(env.WORKER_LIMITS!) as Parameters<PostgresStore["reserveSpend"]>[0]["limits"];
const count = Number(env.WORKER_COUNT);
const amountUsd = Number(env.WORKER_AMOUNT);
// Everyone starts at the same wall-clock moment, so the processes genuinely race.
await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(env.WORKER_START_AT) - Date.now())));
const results = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    store.reserveSpend({
      id: `${env.WORKER_NAME}-r${i}`,
      inferenceId: `${env.WORKER_NAME}-i${i}`,
      userId: null,
      plan: "standard",
      task: "chat",
      provider: "openai",
      model: "m",
      amountUsd,
      leaseMs: 60_000,
      limits,
    }),
  ),
);
process.stdout.write(`${JSON.stringify({ admitted: results.filter((r) => r.ok).length, denied: results.filter((r) => !r.ok).length })}\n`);
await store.close();
