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
| `MAX_CONCURRENT_STREAMS_PER_USER` | `3` | Simultaneous chat streams per user. |
| `SESSION_TTL_DAYS` | `30` | Session token lifetime. |
| `TRUST_PROXY` | `false` | Set `true` only behind a trusted reverse proxy. |

`GET /v1/providers` reports which providers are configured (`live`, `fake` or `unconfigured`) and
their model ids, so the app can disable unavailable choices. Explicit choices (OpenAI, Claude,
Compare) never silently fall back to another provider; Dash Smart falls back and says so.

## Android build configuration

| Setting | Where | Notes |
| --- | --- | --- |
| Default server URL | `apps/android/app/build.gradle.kts` (`DEFAULT_SERVER_URL`) | Debug: `http://10.0.2.2:8787/` (emulator → host). Release: empty; users must set an HTTPS server. |
| Server URL at runtime | Settings → Server | For a physical phone use your computer's LAN IP (debug builds allow `http://`). |
