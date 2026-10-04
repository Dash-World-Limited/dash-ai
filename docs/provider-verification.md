# Provider verification

Dash AI talks to OpenAI through the **Responses API** and to Anthropic through the **Messages API**,
both via the official SDKs (`apps/api/src/providers`). Model ids come from server configuration only.

## What is verified automatically (no keys, no cost)

CI and `pnpm test` run the real adapters and real SDKs against **scripted HTTP responses in each
provider's wire format**, plus the in-process API:

- streaming text, usage, finish reasons (stop / length / refusal), served-model capture;
- tool definitions, tool calls (including Anthropic's partial-JSON arguments) and tool-result replay;
- HTTP errors and in-stream failures map to safe, correctly retryable errors without copying provider text;
- a stream that ends without its terminal event is an **error**, never a "complete" answer;
- aborting a stream mid-flight is a **cancellation** (the SDKs end aborted streams silently, which once
  would have turned Stop into a failed message; there are regression tests), and the timeout reason is a timeout;
- the opt-in smoke harness itself, including negative tests (non-streaming, missing usage, deaf cancellation,
  secret leakage).

This proves our code against the documented shapes. It **cannot** prove the live services behave
identically: that is what the smoke command is for.

## Live smoke test (opt-in)

It calls the real APIs, so it never runs in CI and never runs unless you ask.

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

| Check | Verifies |
| --- | --- |
| normal response | non-empty answer that follows a trivial instruction, `stop` finish, input and output token usage reported |
| streaming | the answer arrives in several pieces and the first text precedes the end |
| provider/model metadata | the provider reports which model served the request (shows configured vs served when an alias resolves) |
| cancellation | aborting after the first text ends the stream as a clean cancellation within 5 s |
| tool round trip | the model calls the harmless built-in tool, the backend runs it, the result goes back in the provider's format and the final answer uses it |
| dash smart (general / writing) | routing matches the shared table for the configured providers, labels are live (not demo), models match config |
| explicit openai / claude, compare | single-provider answers, and two stored, labelled answers under one compare group |
| cancel via API | the cancel endpoint stops a real stream and the partial answer is kept as stopped |

Cost: about 8 small requests per provider plus a few through the API, each capped at 400 output tokens.
Output prints only safe summaries (counts, timings, model ids; never the model's answers); every configured secret is redacted from
everything printed, and the command never writes files. Compare and the other provider's checks are
reported as **skipped**, not passed, when only one provider is configured.

**Status:** the harness is tested offline. It has **not been run against the live providers** by the
authors of this milestone (no API keys were available). Run it before relying on the adapters.
