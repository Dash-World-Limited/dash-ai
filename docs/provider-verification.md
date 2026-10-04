# Provider verification

Dash AI talks to OpenAI through the **Responses API** and to Anthropic through the **Messages API**,
both via the official SDKs (`apps/api/src/providers`). Model ids come from server configuration only.
Both adapters translate one provider-neutral conversation model (`ProviderTurn`: user / assistant /
assistant-with-tool-calls / tool results) into their own wire format; one provider's turns are only
ever replayed to that same provider.

## Status at a glance

| Area | Mocked (scripted wire format, in CI) | Live (real provider) |
| --- | --- | --- |
| OpenAI streaming, usage, errors, cancellation, tools | verified | **not verified**: no API key was available |
| Anthropic streaming, usage, errors, cancellation, tools, thinking replay | verified | **not verified**: no API key was available |
| Dash Smart, Compare, cancel through the API | verified | **not verified** |

"Verified" in the mocked column means the real SDK and adapter ran against HTTP responses in the
provider's documented wire format, including the rules below that the scripted servers enforce. It
does not prove that the live services behave identically. Run the live smoke (below) before
relying on either adapter.

## Contract rules the adapters follow (and the scripted servers enforce)

- **Claude thinking in tool loops.** Current Claude models think by default. An assistant turn that
  called a tool must go back **byte-for-byte as the model produced it**: `thinking` /
  `redacted_thinking` blocks first, unmodified, in order, with their signatures, or the request is
  a 400. The adapter returns that turn as an opaque, provider-owned `continuation` that the
  orchestrator replays only to Claude; it falls back to rebuilding the turn when the continuation is
  absent or does not match the tool calls. Signatures never reach clients, logs or OpenAI.
- **The tool set never changes inside a tool loop.** Claude ties replayed thinking to the tool set it
  was produced under. On the last allowed tool round the adapters send **the same tools with tool
  choice "none"** (Claude `{type: "none"}`, OpenAI `"none"`) instead of dropping `tools`, which
  would have invalidated the thinking replayed from earlier rounds. Tool calls a model emits after
  tool use is switched off are ignored. Permissions revoked mid-response are enforced at execution
  (see [plugins.md](plugins.md)), never by editing the tool list.
- **Thinking and reasoning count against the output limit.** `MAX_OUTPUT_TOKENS` (default 16,000)
  includes thinking/reasoning tokens, so it must leave room for the answer.
- **Prompt-cache tokens are input tokens.** Claude reports cache reads and writes separately from
  `input_tokens`; usage adds them so totals are not undercounted.
- **OpenAI reasoning replay is opt-in.** Requests use `store: false`. With
  `OPENAI_ENCRYPTED_REASONING=true`, tool rounds request `reasoning.encrypted_content` and replay
  the reasoning items with their function calls (stateless reasoning continuity). It stays off by
  default until verified live for your model; with it off, turns are rebuilt without item ids.

## What is verified automatically (no keys, no cost)

CI and `pnpm test` run the real adapters and real SDKs against **scripted HTTP responses in each
provider's wire format** (`apps/api/test/providerServer.ts`), plus the in-process API:

- streaming text, usage (including cache tokens), finish reasons (stop / length / refusal), served-model capture;
- tool definitions, tool calls (including Anthropic's partial-JSON arguments), tool-result replay, thinking and
  encrypted-reasoning replay, tool choice "none" on the last round, and a rebuilt or tool-set-changed turn being
  rejected by the scripted API exactly as the real one would;
- HTTP errors and in-stream failures map to safe, correctly retryable errors without copying provider text;
  credential failures (401/403) say the administrator must check the key and are not retryable;
- malformed responses: invalid JSON events, HTML or empty bodies instead of a stream, connection resets
  mid-stream (partial text kept, retryable error), unknown event types (ignored), broken tool names or
  arguments (refused by the backend; the loop still finishes), a stalled stream (idle timeout through the
  real SDK), and an outage during Compare (the healthy answer is kept);
- a stream that ends without its terminal event is an **error**, never a "complete" answer;
- aborting a stream mid-flight is a **cancellation**, and the timeout reason is a timeout;
- the opt-in smoke harness itself, including negative tests (non-streaming, missing usage, deaf cancellation,
  secret leakage).

Mutation checks were run on the main fixes: disabling the Claude continuation, or dropping `tools` on the
last round, makes the contract tests fail.

## Live smoke test (opt-in, never in PR CI)

It calls the real APIs, so it only runs when you ask: locally, or with the manual
**Live provider smoke** workflow (`.github/workflows/live-smoke.yml`).

```bash
# apps/api/.env  (git-ignored; never commit it)
PROVIDER_MODE=live
OPENAI_API_KEY=…      OPENAI_MODEL=…
ANTHROPIC_API_KEY=…   ANTHROPIC_MODEL=…

DASH_LIVE_SMOKE=1 pnpm smoke:live              # everything configured
DASH_LIVE_SMOKE=1 pnpm smoke:live -- --provider anthropic --skip-tools
```

Without `DASH_LIVE_SMOKE=1` it prints how to enable itself and exits 0 without touching any provider.
It refuses `PROVIDER_MODE=fake` and missing configuration (exit 2); a failed check exits 1.

**In GitHub Actions:** create a protected environment named `live-smoke` (Settings → Environments,
ideally with required reviewers) holding secrets `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and variables
`OPENAI_MODEL` / `ANTHROPIC_MODEL`, then run *Actions → Live provider smoke → Run workflow*. A provider
without a key and model is **skipped** (not green) and the run summary says "not verified".

| Check | Verifies |
| --- | --- |
| normal response | non-empty answer that follows a trivial instruction, `stop` finish, input and output token usage reported |
| streaming | the answer arrives in several pieces and the first text precedes the end |
| provider/model metadata | the provider reports which model served the request (shows configured vs served when an alias resolves) |
| cancellation | aborting after the first text ends the stream as a clean cancellation within 5 s |
| tool round trip | the model calls the harmless built-in tool, the backend runs it, the turn (thinking / encrypted reasoning included) and result go back in the provider's format, and the final answer, requested with tool choice "none", uses it |
| dash smart (general / writing) | routing matches the shared table for the configured providers, labels are live (not demo), models match config |
| explicit openai / claude, compare | single-provider answers, and two stored, labelled answers under one compare group |
| cancel via API | the cancel endpoint stops a real stream and the partial answer is kept as stopped |

Cost: about 8 small requests per provider plus a few through the API. Each adapter check allows up to
2,048 output tokens because thinking/reasoning tokens count against the limit; trivial prompts use far
fewer. Output prints only safe summaries (counts, timings, model ids; never the model's answers); every
configured secret is redacted from everything printed, and the command never writes files. Compare and
the other provider's checks are reported as **skipped**, not passed, when only one provider is configured.

**Status:** the harness and both adapters are verified offline only. Neither has been run against the
live providers by the authors of these milestones (no API keys were available).
