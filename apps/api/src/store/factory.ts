import type { AppConfig } from "../config.js";
import { ConfigError } from "../config.js";
import { DataCipher, DataKeyError } from "../security/dataCrypto.js";
import { MemoryStore } from "./memoryStore.js";
import { PostgresStore } from "./postgresStore.js";
import type { Store } from "./store.js";

export interface StoreSelection {
  store: Store;
  kind: "postgres" | "memory";
  warnings: string[];
}

/** Chooses the store from configuration. Fails fast on unsafe production setups. */
export async function createStore(config: AppConfig): Promise<StoreSelection> {
  const { database, dataEncryption } = config;
  if (!database.url) {
    if (config.nodeEnv === "production" && !database.allowMemoryStore) {
      throw new ConfigError(
        "DATABASE_URL is required in production. The in-memory store loses all data on restart (set ALLOW_MEMORY_STORE=true only for a throwaway demo).",
      );
    }
    return {
      store: new MemoryStore(),
      kind: "memory",
      warnings: ["No DATABASE_URL: using the in-memory store. All accounts and conversations are lost when the server restarts."],
    };
  }
  if (!dataEncryption.key) {
    throw new ConfigError("DATA_ENCRYPTION_KEY is required with DATABASE_URL (generate one with: openssl rand -base64 32).");
  }
  let cipher: DataCipher;
  try {
    cipher = DataCipher.fromConfig(dataEncryption.key, dataEncryption.keyId, dataEncryption.previousKeys);
  } catch (err) {
    if (err instanceof DataKeyError) throw new ConfigError(err.message);
    throw err;
  }
  const store = await PostgresStore.connect({
    connectionString: database.url,
    cipher,
    ssl: database.ssl,
    poolMax: database.poolMax,
    autoMigrate: database.autoMigrate,
  });
  return { store, kind: "postgres", warnings: [] };
}
