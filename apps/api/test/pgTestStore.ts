import { randomBytes } from "node:crypto";
import { DataCipher } from "../src/security/dataCrypto.js";
import { PostgresStore } from "../src/store/postgresStore.js";

/** Set to run store contract and API tests against a real PostgreSQL (never a shared database). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const testCipher = (keyId = "t1") => new DataCipher(keyId, new Map([[keyId, randomBytes(32)]]));

export interface TestPgStore {
  store: PostgresStore;
  schema: string;
  cipher: DataCipher;
  /** Drops the isolated schema and closes the pool. */
  dispose(): Promise<void>;
}

/** Connects to TEST_DATABASE_URL inside a fresh, uniquely named schema so tests never collide. */
export async function createTestPgStore(cipher: DataCipher = testCipher()): Promise<TestPgStore> {
  if (!TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is not set");
  const schema = `t_${randomBytes(6).toString("hex")}`;
  const store = await PostgresStore.connect({ connectionString: TEST_DATABASE_URL, cipher, schema });
  return {
    store,
    schema,
    cipher,
    async dispose() {
      await store.dropSchema(schema).catch(() => undefined);
      await store.close();
    },
  };
}
