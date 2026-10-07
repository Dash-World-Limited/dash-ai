# Architecture

```
┌──────────────────────────── Android (com.dashworldng.ai) ────────────────────────────┐
│ Compose UI (screens, Material 3)                                                     │
│   └─ ViewModels (thin) ──► core: ChatSession state machine                           │
│                              ├─ ChatGateway ── DemoChatGateway (on-device, Demo Mode) │
│                              │              └─ RemoteChatGateway (OkHttp SSE) ───────┼──► Dash AI API
│                              ├─ ConversationRepository ── Room (on device, local cache)│
│                              ├─ ConversationSyncService ◄─► /v1/sync (pull + push)   │
│                              └─ ContextBuilder, SmartRouting, TitleGenerator         │
│ DataStore settings · Android Keystore token store · connectivity monitor             │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── Dash AI API (apps/api, Fastify) ─────────────────────────┐
│ auth · conversations · chat/stream (SSE) · cancel · documents · usage · export      │
│ Orchestrator ─► resolveProviders (contracts) ─► ProviderAdapter                      │
│                                                   ├─ OpenAIAdapter (official SDK)  ──┼──► OpenAI Responses API
│                                                   ├─ AnthropicAdapter (official SDK) ┼──► Anthropic Messages API
│                                                   └─ FakeAdapter (tests, demos)       │
│ Tool layer: PluginRegistry · permissions · ToolExecutor · audit (optional plugins)   │
│ Store interface ─► PostgresStore (production) / MemoryStore (tests, demos)           │
│ rate limiter (in memory) · privacy-safe logger                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

## Modules

### `packages/contracts`
The single source of truth for the wire format: zod schemas for every request and response,
`LIMITS`, the Dash Smart routing table (`SMART_ROUTING`, `resolveProviders`), upload rules
(`FILE_RULES`, `checkFile`) and SSE helpers. `fixtures/` holds canonical JSON bodies and SSE
transcripts. The TypeScript tests validate the fixtures against the schemas; the Kotlin tests
decode the same fixtures strictly into the Android DTOs, check the routing table, upload rules,
limits and title algorithm, and compare the JSON the app sends with `chat-stream-request.json`.

### `apps/api`
- **Routes**: `GET /health`, `GET /v1/providers`, `POST /v1/auth/{register,login,logout}`,
  `GET|DELETE /v1/me`, `GET /v1/me/export`, `GET /v1/usage`, conversation CRUD under
  `/v1/conversations`, `POST /v1/chat/stream`, `POST /v1/chat/streams/:id/cancel`,
  `POST|GET /v1/documents`, `DELETE /v1/documents/:id`, `GET /v1/sync/conversations`,
  `POST /v1/sync/push` ([sync.md](sync.md)), `GET /v1/plugins`, `PUT /v1/plugins/:id`, `GET /v1/tools/activity`
  ([plugins.md](plugins.md)).
- **Orchestrator** (`src/chat/orchestrator.ts`): validates everything that can fail *before*
  the stream starts (so those failures are JSON errors with proper status codes), then runs one
  target (single provider) or two targets (Compare) concurrently. Each target has its own abort
  controller, overall timeout and idle timeout; cancelling the stream aborts both.
- **Adapters** (`src/providers`): official `openai` and `@anthropic-ai/sdk` clients behind a common
  `ProviderAdapter` streaming interface. Fake adapters produce clearly labelled demonstration
  answers and support test triggers for errors, hangs and slow streams.
- **Context** (`src/providers/context.ts`): history is filtered per target provider (user turns
  plus that provider's own answers), trimmed to the character budget, consecutive turns merged,
  and extracted document text wrapped in delimited `<document>` blocks.
- **Store** (`src/store`): an async `Store` interface with `PostgresStore` (production: migrations,
  per-user sync sequence, tombstones, title revisions, encrypted titles, messages and document text) and `MemoryStore` (isolated tests and
  demos), both held to one contract test suite. See [persistence.md](persistence.md).
- **Tool layer** (`src/tools`): provider-neutral `ToolPlugin`/`ToolDefinition` contract, `PluginRegistry`
  (permission resolution), `ToolExecutor` (validation, timeout, cancellation, bounded output, audit) and a
  harmless built-in plugin. The orchestrator runs a bounded model → tool → model loop per target;
  adapters translate the same definitions into each provider's format. See [plugins.md](plugins.md).
- **Live verification** (`src/smoke`): the opt-in `pnpm smoke:live` command. See
  [provider-verification.md](provider-verification.md).

### `apps/android/core` (pure Kotlin, separate Gradle build)
Everything that does not need Android: `ChatSession` (send, stream, stop, regenerate, retry with the
other provider, edit & resend, Compare, crash-safe restore), `ContextBuilder`, `SmartRouting`,
`SseParser` + `StreamEventDecoder`, `DashApiClient` (Retrofit + OkHttp), `RemoteChatGateway`,
`RemoteDocumentGateway` (streamed multipart with progress), `DemoChatGateway`, `DemoDocumentGateway`,
`Markdown` parser, `PromptLibrary`, `FileRules`, `TitleGenerator` and `DataExport`.
It is an included build of `apps/android`, so it compiles and tests without Google's Maven.

### `apps/android/app`
Compose screens and thin ViewModels; Room (`DashDatabase`) implements the core repository
interfaces and stays the local cache (`ConversationSyncService` merges server conversations into it); DataStore holds settings; `KeystoreTokenStore` encrypts the session token with an
Android Keystore AES-GCM key. Manual dependency injection via `AppServices` (`AppContainer` in the
app, `InMemoryServices` in UI tests).

## Chat request lifecycle

1. The user sends a message. `ChatSession` creates the conversation locally (title generated on
   device), persists the user message and builds the history with `ContextBuilder`.
2. Live mode: `RemoteChatGateway` POSTs `ChatStreamRequest` to `/v1/chat/stream` with the session
   token. Demo Mode: `DemoChatGateway` simulates the same event stream on the device.
3. The API validates, resolves the providers, writes `stream.start` (targets with message ids,
   provider, model, `demo` flag and the routing reason), then `message.delta` events, one
   `message.end` or `message.error` per target, optionally `conversation.title`, then `stream.end`.
4. The app shows placeholders per target, appends deltas as they arrive and persists final states.
5. **Stop**: the app cancels the collection (closing the HTTP stream) and calls
   `/v1/chat/streams/:id/cancel`; the server aborts the provider requests and records the partial
   answer as `stopped`.

### SSE events

| Event | Payload |
| --- | --- |
| `stream.start` | `streamId, conversationId, modelChoice, compareGroupId, targets[{messageId, provider, model, demo}], routingReason` |
| `message.delta` | `messageId, text` |
| `message.end` | `messageId, finishReason (stop/length/refusal/cancelled), usage{inputTokens, outputTokens}` |
| `message.error` | `messageId, error{code, message, retryable}` |
| `conversation.title` | `conversationId, title` |
| `tool.call` | `messageId, callId, plugin, tool` — a tool call started (never carries arguments). Android ignores it. |
| `tool.result` | `messageId, callId, plugin, tool, status (ok/invalid_arguments/denied/unknown_tool/timeout/error/cancelled), durationMs` (never carries results) |
| `stream.end` | `streamId` |
| `stream.error` | `error{code, message, retryable}` |

A `: ping` comment is sent every 15 seconds so idle connections are not dropped.

## History model

The server (PostgreSQL) holds the durable record of each account's conversations; the device (Room)
is the local cache the UI reads, so the app works offline and in Demo Mode. Live chat requests still
carry the relevant history (filtered by provider rules; the API re-applies the filter). After sign-in
the device pushes its pending work (conversations written offline, renames, deletions) and pulls server
conversations into Room with deterministic rules ([sync.md](sync.md), [ADR 0009](decisions/0009-conversation-sync.md),
[ADR 0010](decisions/0010-two-way-sync.md)).

## Running the live contract test locally

```bash
pnpm build && PROVIDER_MODE=fake PORT=8787 node apps/api/dist/index.js &
cd apps/android/core && DASH_API_BASE_URL=http://127.0.0.1:8787 ../gradlew test --tests '*LiveApiContractTest*'
```

The same test also covers the sync flow (a second device pulling, renames and deletions). Start the API
with `DATABASE_URL` and `DATA_ENCRYPTION_KEY` set to run it against PostgreSQL.
