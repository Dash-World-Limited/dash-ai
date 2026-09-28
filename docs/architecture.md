# Architecture

```
┌──────────────────────────── Android (com.dashworldng.ai) ────────────────────────────┐
│ Compose UI (screens, Material 3)                                                     │
│   └─ ViewModels (thin) ──► core: ChatSession state machine                           │
│                              ├─ ChatGateway ── DemoChatGateway (on-device, Demo Mode) │
│                              │              └─ RemoteChatGateway (OkHttp SSE) ───────┼──► Dash AI API
│                              ├─ ConversationRepository ── Room (on device)           │
│                              └─ ContextBuilder, SmartRouting, TitleGenerator         │
│ DataStore settings · Android Keystore token store · connectivity monitor             │
└──────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────── Dash AI API (apps/api, Fastify) ─────────────────────────┐
│ auth · conversations · chat/stream (SSE) · cancel · documents · usage · export      │
│ Orchestrator ─► resolveProviders (contracts) ─► ProviderAdapter                      │
│                                                   ├─ OpenAIAdapter (official SDK)  ──┼──► OpenAI Responses API
│                                                   ├─ AnthropicAdapter (official SDK) ┼──► Anthropic Messages API
│                                                   └─ FakeAdapter (tests, demos)       │
│ Store interface (MemoryStore today) · rate limiter · privacy-safe logger             │
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
  `POST|GET /v1/documents`, `DELETE /v1/documents/:id`.
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
- **Store** (`src/store`): an async `Store` interface with an in-memory implementation. A database
  implementation can replace it without touching routes.

### `apps/android/core` (pure Kotlin, separate Gradle build)
Everything that does not need Android: `ChatSession` (send, stream, stop, regenerate, retry with the
other provider, edit & resend, Compare, crash-safe restore), `ContextBuilder`, `SmartRouting`,
`SseParser` + `StreamEventDecoder`, `DashApiClient` (Retrofit + OkHttp), `RemoteChatGateway`,
`RemoteDocumentGateway` (streamed multipart with progress), `DemoChatGateway`, `DemoDocumentGateway`,
`Markdown` parser, `PromptLibrary`, `FileRules`, `TitleGenerator` and `DataExport`.
It is an included build of `apps/android`, so it compiles and tests without Google's Maven.

### `apps/android/app`
Compose screens and thin ViewModels; Room (`DashDatabase`) implements the core repository
interfaces; DataStore holds settings; `KeystoreTokenStore` encrypts the session token with an
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
| `stream.end` | `streamId` |
| `stream.error` | `error{code, message, retryable}` |

A `: ping` comment is sent every 15 seconds so idle connections are not dropped.

## History model

History is **local-first**: the device (Room) is the source of truth for what the user sees.
Live requests carry the relevant history, and the API also keeps a server-side record per account
(for export, deletion and future sync). See [ADR 0002](decisions/0002-local-first-history.md).

## Running the live contract test locally

```bash
pnpm build && PROVIDER_MODE=fake PORT=8787 node apps/api/dist/index.js &
cd apps/android/core && DASH_API_BASE_URL=http://127.0.0.1:8787 ../gradlew test --tests '*LiveApiContractTest*'
```
