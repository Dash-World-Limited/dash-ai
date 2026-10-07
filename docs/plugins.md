# Plugins and tool calling

OpenAI and Claude are the two core AI providers. Everything else Dash AI might reach (GitHub, Gmail,
Calendar, web search, Dash World services, …) is meant to arrive as an **optional plugin**: no plugin
is a hard dependency, none is enabled by default, and the server runs identically with zero plugins.

## What is real today

| Piece | Status |
| --- | --- |
| Plugin/tool contract, registry, permission model, executor, audit, enable/disable API | ✅ Real, tested |
| OpenAI (Responses API) and Claude (Messages API) adapters for the same internal tool definitions | ✅ Real code, tested against the official SDKs with scripted provider wire formats. **Not yet exercised against the live providers** (no keys here): run `pnpm smoke:live` |
| Built-in `dash-demo` plugin (`current_time`, `text_stats`) | ✅ Real and harmless: no network, files, database or credentials |
| GitHub, Gmail, Calendar, web search, Dash World plugins | ❌ **Do not exist.** The only "external" plugin is `mock-github` in `apps/api/test/mockPlugin.ts` (canned data, no network, no credentials, tests only) |
| OAuth / credential storage for external services | ❌ Not built. A real external plugin needs a secrets and consent design first |
| Write tools (anything with side effects) | ❌ Can be *declared*; the executor refuses to run them until a per-call user-confirmation flow exists |
| Android UI for plugins and tool activity | ❌ Not built. The app ignores `tool.*` stream events; manage plugins through the API |

## Concepts

- **Plugin** (`ToolPlugin`): id, name, version, `kind` (`builtin` or `external`), declared **scopes**
  (`demo:read`, `issues:write`, … each `read` or `write`) and a list of tools.
- **Tool** (`ToolDefinition`): name, description for the model, the scope it needs, a risk level and a
  **zod input schema**. The schema is the single source of truth: it validates the model's arguments at
  runtime and is converted to the JSON Schema each provider adapter sends.
- **Qualified name**: providers see `${pluginId}__${toolName}` (e.g. `dash-demo__text_stats`), which
  satisfies both providers' function-name rules; ids/names are restricted at registration.
- **Registration is code-only** (`PluginRegistry.register`). Nothing a model, user or request says can add
  a plugin or tool.

## Permission model

A tool is offered to a model in a request only if **all** of these hold:

1. its plugin is registered on this server,
2. the user has **enabled** the plugin (`PUT /v1/plugins/:id`; default off),
3. the user has **granted** the tool's scope (enabling grants every *read* scope unless the user lists
   scopes; write scopes must be listed explicitly),
4. the tool is read-only (write tools are never offered or run in this milestone),

and the server-wide `TOOLS_ENABLED` kill switch is on. The set is built per request from that user's own
settings; one user's choices never affect another's.

**Permissions are checked again at the moment of invocation.** Before each round of tool calls runs,
the user's current settings are re-read, and only tools that were both offered to the model at the start
of the response *and* are still permitted may execute. Disabling a plugin or revoking a scope while an
answer is streaming takes effect at the next tool call; enabling one mid-response adds nothing to that
response; if the settings cannot be read, nothing runs (fail closed). The tool list sent to the model is
deliberately left unchanged for the whole response (Claude ties replayed thinking to it): revoked tools
are refused at execution instead.

## Execution path

```
model output ──► adapter parses STRUCTURED tool calls only ──► ToolExecutor ──► handler
```

`ToolExecutor` (`apps/api/src/tools/executor.ts`) is the only way anything runs. For each call it:

1. rejects tools not in this request's offered set, intersected with the user's current permissions
   (`denied` if the tool exists but is not permitted,
   `unknown_tool` otherwise; the model is told neither which plugins exist nor why),
2. refuses write tools even if something offered them,
3. bounds the arguments (16 KB), requires valid JSON and validates against the tool's **strict** schema
   (unknown properties are rejected; error text never echoes submitted values),
4. runs the handler under a hard timeout (default 10 s, per-tool override, 120 s ceiling) and the user's
   cancellation, even when the handler ignores its abort signal,
5. bounds the output (`TOOL_MAX_RESULT_CHARS`) and turns every failure into a short generic message
   (`ToolUserError` is the only way a handler can pass specific text to the model),
6. records an audit row: user, conversation, message, provider, plugin, tool, status, duration, argument
   size, result size. **Never the arguments or results.**

**Text that merely looks like a tool call is just text.** Only the structured tool-call channel of each
provider's API (OpenAI `function_call` items, Anthropic `tool_use` blocks) reaches the executor, and tests
check that look-alike text, unknown names, unoffered tools, write tools, invalid arguments and slow
handlers never run side effects.

Tool results go back to the model through the provider's tool-result channel, and the system prompt tells
the model to treat them as untrusted data, not instructions. The loop is bounded (`TOOL_MAX_ROUNDS`, the
last round keeps the same tools with tool use switched off; at most 8 calls per round, extra calls are
refused but still answered).

`apps/api/test/tool-adversarial.test.ts` attacks this path directly: forged, case-variant, Unicode
look-alike, NUL-terminated and prototype-named tool names (`__proto__`, `constructor`, …), hostile call
ids, prototype-pollution keys and deeply nested or non-object arguments, a byte-counted size limit,
duplicate keys, tools that return circular or throwing values, throw non-Error values carrying secrets,
or answer after their timeout, permissions revoked or the settings store failing mid-response, a tool
result steering the model towards a write tool, and a canary proving that tool arguments and results
reach the model only: never logs, the event stream, audit rows, exports or any database row.

## Exactly-once under retries, reconnects and restarts

- A call id the provider repeats in the same response (same round or a later one) is never run again; it
  gets a `duplicate` result pointing at the earlier one.
- Equivalent read-only calls with different ids **do** run each time: repeating a lookup is intended.
- Tools that change things declare `idempotency: "per-message"` (registration refuses a `write` tool
  without it). Before such a handler runs, the executor claims a ledger row keyed by a SHA-256 of user,
  conversation, **user message**, tool and canonical (key-sorted) arguments (`tool_executions`, migration 5;
  no arguments or results are stored). A second claim fails, so a retried provider request, a re-sent
  message (reconnecting client), a second API instance or a server restart between the tool and the
  provider's continuation cannot repeat the action; a claim whose outcome is unknown (crash mid-run) is
  never re-run (at most once); if the ledger cannot be written, the action does not run. A new user
  message may perform the same action again.
- Provider retries ([ADR 0011](decisions/0011-provider-failures-retry-not-failover.md)) only happen before
  a request produced output, and tools that already ran are part of the retried request's history.

Tested in `apps/api/test/tool-exactly-once.test.ts` (both stores, including two servers racing on one
database) and `provider-resilience.test.ts`.

## Providers: the same definitions, two wire formats

| | OpenAI Responses API | Anthropic Messages API |
| --- | --- | --- |
| Definition | `{type:"function", name, description, parameters, strict:false}` | `{name, description, input_schema}` |
| Call in stream | `function_call` output item (read from `response.completed`) | `tool_use` content block, arguments assembled from `input_json_delta` fragments |
| Replayed call | `function_call` input item with `call_id` (plus encrypted reasoning items when `OPENAI_ENCRYPTED_REASONING=true`) | the assistant turn exactly as produced: `thinking` / `redacted_thinking` blocks, text, `tool_use` |
| Result | `function_call_output` item | user turn with a `tool_result` block (`is_error` set on failure) |

Each provider's tool turns are only replayed to that same provider. In **Compare** the two providers run
independent loops, and call ids from one never appear in the other's requests (tested). Dash Smart picks one
provider by the usual routing and then behaves like a single-provider chat. Persisted history keeps only
the visible text: tool turns are not stored or replayed in later requests.

**Provider caveats to verify live:** `strict` is false because zod schemas can have optional properties;
reasoning models may expect their reasoning items to be passed back with function calls, which this
stateless (`store:false`) replay does not do. The live smoke test's tool round trip exists to surface this.

## API

- `GET /v1/plugins` → `{toolsEnabled, plugins:[{id, name, kind, scopes, tools[{executable}], enabled, grantedScopes}]}`
- `PUT /v1/plugins/:id` `{enabled, grantedScopes?}` → the updated plugin (404 unknown plugin, 400 unknown scope)
- `GET /v1/tools/activity` → the last 100 tool calls (metadata only)
- Stream events `tool.call` and `tool.result` (plugin, tool, status, duration; never arguments or results)
- `GET /v1/me/export` includes plugin choices and tool activity; `DELETE /v1/me` removes them

## Adding a plugin

1. Write a `ToolPlugin` (see `src/tools/builtin.ts`), declaring the narrowest scopes it needs and zod input
   schemas with tight bounds.
2. Register it where the server builds its registry (`ToolRuntime.defaultRegistry()` or `buildApp({plugins})`).
3. Handlers must honour `ctx.signal`, return small results, and throw `ToolUserError` only for messages that
   are safe to show the model.
4. A plugin that calls an external service needs its credentials from server configuration or a per-user
   secret store (not built yet), and a review of what data it sends out, since results flow into a provider.
5. Add tests like `apps/api/test/toolcalling.test.ts`, including the denial cases.

## Configuration

`TOOLS_ENABLED` (default `true`), `TOOL_TIMEOUT_MS` (10000), `TOOL_MAX_ROUNDS` (4),
`TOOL_MAX_RESULT_CHARS` (20000). See [environment.md](environment.md).
