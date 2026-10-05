# Security and privacy

## Credentials
- **AI-provider keys exist only on the server** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`). The Android
  app has no provider SDK, no provider hostnames and no keys; CI fails if the APK contains
  provider key patterns or provider API hosts (`scripts/check-apk.sh`), and the tracked-file scan
  fails if Android sources reference a provider API.
- `.env` files are git-ignored; only `apps/api/.env.example` (empty placeholders) is committed.
  `scripts/scan-secrets.mjs` and gitleaks run in CI on every push.
- User sessions use opaque random tokens (`dash_…`, 256 bits). Only their SHA-256 hash is stored
  server-side. A session lives `SESSION_TTL_DAYS` (no refresh tokens, no sliding renewal); an expired one
  is refused and deleted at the exact expiry instant, and expired rows are purged hourly.
  `POST /v1/auth/logout` ends one session; `POST /v1/auth/logout-all` ends every session of the account
  (lost phone, leaked token). Deleting an account removes every session and all of its data; an answer
  still streaming on another device cannot recreate any of it.
- Sign-in is limited per IP and per account (`RATE_LIMIT_LOGIN_PER_ACCOUNT` per 15 minutes from any IPs),
  with limits shared across API instances through Redis (`RATE_LIMIT_BACKEND=redis`).
- Passwords are hashed with scrypt at an OWASP-recommended cost (N=2^15, r=8, p=3) and a per-user salt.
  Verification uses the cost stored with each hash, accepted only within a bounded range, and hashes made
  with an older cost are replaced at the next successful sign-in. Login responses do not reveal whether an
  email exists, and a dummy hash evens out timing.
- On Android the session token is encrypted with an AES-256-GCM key held in the Android Keystore;
  app data is excluded from cloud backup and device transfer (`data_extraction_rules.xml`).
- **Shared devices**: the app keeps one account's data at a time. Signing out (online or offline) removes
  the token and every local conversation, message, document, prompt and sync record; signing in as
  another account removes the previous account's leftovers first; an interrupted sign-out is finished
  at the next start (`LocalAccountGuard`, Kotlin core).
- Release builds allow HTTPS only; cleartext is permitted in debug builds for a local dev server.

## Persistence and encryption at rest
- Durable data lives in PostgreSQL ([persistence.md](persistence.md)). Production refuses to start on the
  in-memory store, and `DATABASE_SSL` defaults to certificate-verified TLS in production.
- **Encrypted at rest** with AES-256-GCM (random nonce, ciphertext bound to its row, key from server
  configuration only): conversation titles, all user and assistant message content, extracted document
  text. Key rotation re-encrypts with `data:encrypt`; start-up refuses a key that does not match stored data.
- **Not encrypted by the application:** document file names, emails, display names, usage rows and
  structural metadata. Full audit: [data-inventory.md](data-inventory.md).
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

## Sync
- Pull and push are scoped to the signed-in user; another account's conversation ids are rejected or
  reported as not found without detail. Devices can only contribute user messages: provider, model, demo
  and status labels are server-made. Uploads only append a newer tail and never touch tombstones, so retries
  and stale devices cannot duplicate or resurrect data. Details: [sync.md](sync.md).

## Threat model
The focused review of this milestone, with the test behind each mitigation and the residual risks, is in
[threat-model.md](threat-model.md).

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
- **Hostile files are contained.** Before a PDF or DOCX reaches a parser, its decompressed size is
  measured with native zlib under hard caps (DOCX: every entry by its real size, per-part, whole-archive
  and entry-count limits; PDF: every stream, with filters the check cannot see through refused). Parsing
  then runs in a **separate Node process** with an empty environment (no database URL, provider keys or
  encryption key), a 384 MB heap, a 640 MB resident-memory watchdog, `DOCUMENT_EXTRACTION_TIMEOUT_MS`
  (default 20 s), a raised OOM score and at most two at a time. Whatever happens there, the API receives a
  bounded, validated result; a file over any limit is stored as `unsupported` with an explanation.

## Operational metrics

`GET /metrics` (only with `METRICS_TOKEN`) exposes counts and durations: provider latency, failures and
retries, tool outcomes, sync failures, rate-limit rejections, document rejections, database and Redis
health. Label values must look like identifiers (provider ids, codes, statuses); anything else is
recorded as `other`, so free text cannot leak into metrics. `GET /ready` reports up/down only.

## Privacy-safe logging
- Fastify's logger uses custom serializers: method, path (query strings stripped), status, request
  id and timings. Headers and bodies are never logged; error messages pass through
  `redactSecrets`. Provider failures are logged as provider + error code only.
- Error messages are also scrubbed of quoted values and key/value details before logging, because database
  drivers and parsers quote offending values.
- Code never logs prompt text, document text, titles or model output. An integration test sends canary
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
See [roadmap.md](roadmap.md#security-follow-ups) and the residual risks in
[threat-model.md](threat-model.md). Not done: email verification and password reset, a session list (the app
has "Sign out everywhere" in Account), TLS termination and deployment (prepared in
[staging-runbook.md](staging-runbook.md), not executed), a secrets/consent design for external plugins, a
confirmation flow for write tools, and app-level encryption of on-device data.
