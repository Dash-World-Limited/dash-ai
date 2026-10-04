# Security and privacy

## Credentials
- **AI-provider keys exist only on the server** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). The Android
  app has no provider SDK, no provider hostnames and no keys; CI fails if the APK contains
  provider key patterns or provider API hosts (`scripts/check-apk.sh`), and the tracked-file scan
  fails if Android sources reference a provider API.
- `.env` files are git-ignored; only `apps/api/.env.example` (empty placeholders) is committed.
  `scripts/scan-secrets.mjs` and gitleaks run in CI on every push.
- User sessions use opaque random tokens (`dash_…`, 256 bits). Only their SHA-256 hash is stored
  server-side. Passwords are hashed with scrypt and a per-user salt; login responses do not reveal
  whether an email exists, and a dummy hash evens out timing.
- On Android the session token is encrypted with an AES-256-GCM key held in the Android Keystore;
  app data is excluded from cloud backup and device transfer (`data_extraction_rules.xml`).
- Release builds allow HTTPS only; cleartext is permitted in debug builds for a local dev server.

## Persistence and encryption at rest
- Durable data lives in PostgreSQL ([persistence.md](persistence.md)). Production refuses to start on the
  in-memory store, and `DATABASE_SSL` defaults to certificate-verified TLS in production.
- **Extracted document text is encrypted at rest** with AES-256-GCM (random nonce, ciphertext bound to
  its user and document id, key from server configuration only, key-id based rotation).
- **Not encrypted by the application:** titles, message content, emails and usage rows. They rely on the
  database host's disk encryption and TLS. Field-level encryption of messages is a roadmap item.
- Passwords (scrypt) and session tokens (SHA-256 of a 256-bit random token) are stored only as hashes.
- Conversation deletion keeps a content-free tombstone (id, owner, timestamps; title scrubbed, messages
  removed) so other devices learn about it; account deletion removes everything, tombstones included.

## Plugins and tool calling
Full detail: [plugins.md](plugins.md). The security-relevant guarantees:
- **Optional and off by default.** No plugin is required, enabled or credentialed by default; a server
  kill switch (`TOOLS_ENABLED`) disables all tool calling.
- **The model cannot execute anything by emitting text.** Only structured tool calls from the providers'
  tool channels reach the backend `ToolExecutor`; look-alike text is just text.
- **Per-request permission check:** plugin registered ∧ user enabled it ∧ user granted the scope ∧ tool is
  read-only. Anything else is denied and audited. Write tools are never run in this milestone.
- **Bounded execution:** strict argument validation (16 KB cap, unknown properties rejected), hard timeout
  and cancellation even for handlers that ignore them, bounded output, bounded rounds and calls per round.
- **No leakage through errors:** handler failures become a generic message; validation errors never echo
  submitted values; audit rows hold metadata only (never arguments or results).
- **Tool results are untrusted data** (prompt-injection aware): they use the providers' tool-result channel
  and the system prompt says to treat them as information, not instructions. This reduces, but cannot
  eliminate, prompt-injection risk, which is why write tools need a confirmation flow before they exist.
- Tool state is never shared between providers; Compare runs two independent loops.

## Request validation and abuse protection
- Every request body, path parameter and upload is validated (zod schemas from
  `packages/contracts`). Validation errors name the field but never echo the submitted values.
- Limits: 32,000 characters per message, 60 history messages / 200,000 history characters,
  5 attachments per message, 2 MB chat bodies, 256 KB other JSON bodies, 10 MB uploads.
- Rate limits (token buckets): all API requests per IP, sign-in/registration per IP, chat and
  uploads per user; plus a per-user cap on concurrent streams. `429` responses include
  `Retry-After`. The in-memory limiter is a single-instance foundation (see roadmap).
- Provider calls have an overall timeout and an idle timeout; misbehaving streams cannot hang.

## Uploads
- Extension, declared MIME type, size and **file signature** must all agree (a renamed executable
  is rejected). TXT must be valid UTF-8 without NUL bytes. File names are sanitised.
- Raw bytes are **not stored**: only extracted text and metadata are kept. Images and scanned PDFs
  are accepted but marked `unsupported`; the API refuses to use them as chat context rather than
  pretend to analyse them.

## Privacy-safe logging
- Fastify's logger uses custom serializers: method, path (query strings stripped), status, request
  id and timings. Headers and bodies are never logged; error messages pass through
  `redactSecrets`. Provider failures are logged as provider + error code only.
- Code never logs prompt text, document text or model output. An integration test sends canary
  strings through prompts, documents, answers, query strings, passwords and tokens and asserts
  none appear in the logs.

## Provider transparency
- The composer states who will receive the next prompt ("Sends to OpenAI", "Sends to OpenAI +
  Claude · may cost more", "Demo Mode · nothing leaves this device").
- Every answer is labelled with its provider and model; demonstration answers carry a DEMO badge
  and start with an explicit "not a real answer" statement.
- **No silent cross-provider forwarding**: history sent to a provider contains user turns and only
  that provider's own earlier answers (enforced on the device and again on the server, tested on
  both sides). Compare never shows one provider the other's answer.
- OpenAI requests set `store: false` so responses are not retained for later retrieval.
- Provider safety systems are respected: refusals are shown to the user as returned
  (`finishReason: refusal`); nothing attempts to bypass them.

## Data rights
- `GET /v1/me/export` returns everything the server holds for the user (including plugin choices and
  tool-call audit metadata); the app exports all local data to a JSON file (Settings → Export my data).
- `DELETE /v1/me` deletes the account and all server data and cancels active streams; the app also
  offers "Delete local data" and deletes local data after account deletion.
- Conversation and document deletion are available in the app and API.

## Known limitations
See [roadmap.md](roadmap.md#security-follow-ups). Not done: distributed rate limiting (the limiter is
per-instance memory), email verification and password reset, TLS termination and deployment hardening,
application-level encryption of message content, bulk re-encryption after key rotation, a secrets/consent
design for external plugins, and a confirmation flow for write tools.
