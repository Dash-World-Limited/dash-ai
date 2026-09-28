# Roadmap

## Current state (MVP foundation)

### Real and working
- Secure TypeScript API: authentication (scrypt, hashed session tokens), conversations, streaming
  chat over SSE, Dash Smart routing, Compare orchestration, cancellation (disconnect and explicit),
  overall and idle timeouts, titles, usage recording, rate limits, concurrent-stream caps,
  validated uploads, text extraction for TXT / DOCX / text-based PDF, export and account deletion,
  privacy-safe logging.
- Official OpenAI (Responses API) and Anthropic (Messages API) SDK adapters, tested against
  recorded streams. They have **not** been exercised against the live providers in this
  environment because no API keys were available here.
- Android app: all screens listed in [product.md](product.md), Room history, DataStore settings,
  Keystore-encrypted token, Demo Mode, Markdown rendering, documents flow, prompt library.

### Mocked, simulated or unfinished (be explicit)
| Capability | Status |
| --- | --- |
| Live provider answers | Needs `OPENAI_API_KEY`/`OPENAI_MODEL` and/or `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` on a running API. CI and tests use fake adapters only. |
| Demo Mode answers | Simulated on the device and labelled as demonstrations. |
| API fake mode (`PROVIDER_MODE=fake`) | Demonstration adapters, labelled as such, for tests and demos. |
| Web research | Not available — no search provider is connected. Research mode uses model knowledge only and says so. |
| Image analysis | Not available — images are validated but not read; the API refuses to use them as context. |
| Scanned PDFs (OCR) | Not available — PDFs without a text layer are marked unsupported. |
| Demo documents | Validated on device by name/type/size only; never read, uploaded or analysed. |
| Server persistence | In-memory store; data is lost when the API restarts. A database-backed `Store` is required before production. |
| Cross-device sync | Not implemented; history is local-first (the server keeps a record but the app does not pull it). |
| Email verification, password reset, social sign-in | Not implemented. |
| Rate limiting across instances | In-memory, single instance only. |
| Official Dash World logo | Missing — temporary typographic mark in use (see [design.md](design.md)). |
| Instrumented (on-device) UI tests | Compose UI tests run on the JVM with Robolectric; no emulator job yet. |
| Release signing, Play Store listing, deployment | Not set up (by instruction: no deployment). |

## Next steps
1. **Persistence**: Postgres-backed `Store` with migrations; encrypt document text at rest.
2. **Production deployment**: HTTPS behind a reverse proxy (`TRUST_PROXY=true`), secrets in a
   secret manager, structured log shipping (metadata only), health checks.
3. **Provider verification**: run the adapters against the live APIs with the chosen model ids;
   add an opt-in, key-guarded smoke test job.
4. **Sync**: pull server conversations into Room on sign-in; conflict handling.
5. **Documents**: image understanding via provider vision inputs (with explicit consent),
   OCR for scanned PDFs, per-document retention settings.
6. **Research**: integrate a search provider with citations; keep the "not connected" label
   until then.
7. **Accounts**: email verification, password reset, session management UI.
8. **Quality**: emulator-based instrumented tests on API 34/35, screenshot tests, accessibility
   audit with TalkBack on the Samsung A55.
9. **Brand**: replace the temporary mark with the official Dash World asset.

## Security follow-ups
- Distributed rate limiting (Redis) and per-account quotas/cost budgets.
- Durable audit log for account deletion and exports (metadata only).
- Certificate pinning decision for the production API domain.
- Dependency update automation and SAST in CI.
