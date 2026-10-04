# Environment variables (API)

Copy `apps/api/.env.example` to `apps/api/.env` and fill in values locally. Never commit `.env`.
Invalid values stop the server at start-up with a message that names the variable (never its value).

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `HOST` / `PORT` | `0.0.0.0` / `8787` | Listen address. |
| `LOG_LEVEL` | `info` | Pino level (`silent` … `trace`). Logs never include prompts, documents or answers. |
| `PROVIDER_MODE` | `live` | `live` uses real providers that have **both** a key and a model; `fake` uses the demonstration adapters for both providers (no network, no cost). |
| `OPENAI_API_KEY` | — | OpenAI key (server only). |
| `OPENAI_MODEL` | — | OpenAI model id, e.g. a current model from OpenAI's docs. Required with the key. |
| `ANTHROPIC_API_KEY` | — | Anthropic key (server only). |
| `ANTHROPIC_MODEL` | — | Claude model id from Anthropic's docs. Required with the key. |
| `PROVIDER_TIMEOUT_MS` | `120000` | Maximum time for one provider answer. |
| `PROVIDER_IDLE_TIMEOUT_MS` | `45000` | Maximum gap between streamed chunks. |
| `MAX_OUTPUT_TOKENS` | `2048` | Output token limit per answer. |
| `FAKE_STREAM_DELAY_MS` | `25` | Delay between chunks of fake answers. |
| `RATE_LIMIT_CHAT_PER_MINUTE` | `20` | Chat requests per user per minute. |
| `RATE_LIMIT_AUTH_PER_MINUTE` | `10` | Sign-in/registration attempts per IP per minute. |
| `RATE_LIMIT_UPLOAD_PER_MINUTE` | `10` | Uploads per user per minute. |
| `RATE_LIMIT_API_PER_MINUTE` | `240` | All requests per IP per minute. |
| `RATE_LIMIT_SYNC_PER_MINUTE` | `60` | Sync pulls and pushes per user per minute. |
| `MAX_CONCURRENT_STREAMS_PER_USER` | `3` | Simultaneous chat streams per user. |
| `SESSION_TTL_DAYS` | `30` | Session token lifetime. |
| `TRUST_PROXY` | `false` | Set `true` only behind a trusted reverse proxy. |
| `DATABASE_URL` | — | PostgreSQL connection string. Empty = in-memory store (development/tests only; **production refuses to start without it**). Keep it out of git; it usually contains a password. |
| `DATABASE_SSL` | `require` in production, else `disable` | `disable`, `require` (verify certificate) or `no-verify`. |
| `DATABASE_POOL_MAX` | `10` | Connection pool size. |
| `DATABASE_AUTO_MIGRATE` | `true` outside production, `false` in production | Apply pending migrations at start-up. When off, start-up fails if the schema is not current; run `pnpm --filter @dash-ai/api migrate`. |
| `DATA_ENCRYPTION_KEY` | — | **Required with `DATABASE_URL`.** Base64 of 32 random bytes (`openssl rand -base64 32`). Encrypts conversation titles, message content and document text at rest. Start-up refuses a key that does not match data stored under its key id. Back it up separately: losing it makes stored document text unreadable. |
| `DATA_ENCRYPTION_KEY_ID` | `k1` | Label stored with each ciphertext; change it when you rotate the key. |
| `DATA_ENCRYPTION_PREVIOUS_KEYS` | — | Retired keys still needed to read old data: `id:base64,id2:base64`. |
| `ALLOW_MEMORY_STORE` | `false` | Lets production run on the in-memory store (throw-away demos only). |
| `TOOLS_ENABLED` | `true` | Server-wide kill switch for tool calling. Plugins are still off per user until the user enables them. |
| `TOOL_TIMEOUT_MS` | `10000` | Default per-tool-call timeout (a tool may set a shorter one; 120 s ceiling). |
| `TOOL_MAX_ROUNDS` | `4` | Maximum model → tool → model rounds per answer; the last round offers no tools. |
| `TOOL_MAX_RESULT_CHARS` | `20000` | Tool output beyond this is truncated before it reaches the model. |

`GET /v1/providers` reports which providers are configured (`live`, `fake` or `unconfigured`) and
their model ids, so the app can disable unavailable choices. Explicit choices (OpenAI, Claude,
Compare) never silently fall back to another provider; Dash Smart falls back and says so.

## Opt-in live smoke test

Not part of the server's configuration, only of `pnpm smoke:live` (see
[provider-verification.md](provider-verification.md)): `DASH_LIVE_SMOKE=1` plus `PROVIDER_MODE=live` and
real provider keys/models in `apps/api/.env`. Without `DASH_LIVE_SMOKE=1` it does nothing.

## Test-only variables

`TEST_DATABASE_URL` (run the PostgreSQL tests against this database, in unique throw-away schemas),
`DASH_TEST_STORE=postgres` (run the whole API suite on PostgreSQL; `pnpm --filter @dash-ai/api test:pg`),
`REQUIRE_DB_TESTS=1` (fail instead of skipping when no test database is configured; set in CI).

## Android build configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Default server URL | `apps/android/app/build.gradle.kts` (`DEFAULT_SERVER_URL`) | Debug: `http://10.0.2.2:8787/` (emulator → host). Release: empty; users must set an HTTPS server. |
| Server URL at runtime | Settings → Server | For a physical phone use your computer's LAN IP (debug builds allow `http://`). |
