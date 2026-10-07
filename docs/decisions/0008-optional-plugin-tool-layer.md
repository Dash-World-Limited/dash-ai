# ADR 0008 — Optional, provider-neutral plugin/tool layer

**Status:** accepted

**Context.** Dash AI will want GitHub, Gmail, Calendar, web search and Dash World services, but OpenAI
and Claude must remain the only core dependencies, and a model must never be able to run code just
because it produced text that looks like a command.

**Decision.**
- One internal contract (`ToolPlugin`/`ToolDefinition`, zod input schema as single source of truth) and
  per-provider adapters that translate it to OpenAI function tools and Anthropic tools and back.
- Registration is code-only. Plugins are off until a user enables them and grants scopes; write tools can
  be declared but are not executable until a confirmation flow exists.
- A single `ToolExecutor` is the only path to side effects and enforces permissions per request, strict
  validation, timeouts, cancellation, bounded output and metadata-only audit. Only structured tool calls
  from the providers' tool channels reach it.
- Tool turns are replayed only to the provider that produced them (Compare = two independent loops) and
  are not persisted in history; persisted answers hold the visible text only.
- Additive stream events (`tool.call`, `tool.result`) carry no arguments or results; older clients ignore
  them.

**Consequences.** Real external plugins still need a credential/consent design and a prompt-injection
review. OpenAI reasoning-model replay is unverified until the live smoke test is run.
