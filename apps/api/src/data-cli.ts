import { ConfigError, loadConfig } from "./config.js";
import { DataCipher } from "./security/dataCrypto.js";
import { PostgresStore } from "./store/postgresStore.js";

/**
 * `pnpm --filter @dash-ai/api data:encrypt` — encrypts any legacy plaintext titles/messages and
 * re-encrypts every row still under a retired key with the current DATA_ENCRYPTION_KEY. Run it after
 * a key rotation; once it reports zero retired-key rows, the old key can be removed from
 * DATA_ENCRYPTION_PREVIOUS_KEYS. Prints counts only, never content.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.database.url) throw new ConfigError("DATABASE_URL is not set.");
  if (!config.dataEncryption.key) throw new ConfigError("DATA_ENCRYPTION_KEY is not set.");
  const cipher = DataCipher.fromConfig(config.dataEncryption.key, config.dataEncryption.keyId, config.dataEncryption.previousKeys);
  const store = await PostgresStore.connect({
    connectionString: config.database.url,
    cipher,
    ssl: config.database.ssl,
    poolMax: 2,
    autoMigrate: false,
  });
  try {
    const before = await store.encryptionStatus();
    const changed = await store.runEncryptionMaintenance();
    const after = await store.encryptionStatus();
    process.stdout.write(
      `Before: ${before.plaintextTitles} plaintext titles, ${before.plaintextMessages} plaintext messages, ${before.retiredKeyRows} rows under retired keys.\\n` +
        `Changed: ${changed.titles} titles, ${changed.messages} messages, ${changed.documents} documents.\\n` +
        `After: ${after.plaintextTitles} plaintext titles, ${after.plaintextMessages} plaintext messages, ${after.retiredKeyRows} rows under retired keys.\\n`,
    );
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  // Never print raw driver errors: they can carry connection details.
  process.stderr.write(`${err instanceof ConfigError ? err.message : `Encryption maintenance failed (${err instanceof Error ? err.name : "unknown"}).`}\\n`);
  process.exit(1);
});
