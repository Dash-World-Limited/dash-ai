# Provider verification

> Internal engineering document. Providers are infrastructure behind DASH AI and are never shown to
> people ([ADR 0012](decisions/0012-dash-ai-is-the-product.md)). The explicit routes and Compare
> described here exist only in the engineering view (`PROVIDER_DETAILS=exposed`, used by tests and the
> live smoke run). Since ADR 0012, DASH AI also fails over internally when a provider fails before any
> output; the "never switches" statements below describe explicit routes in the engineering view.

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

## Failures, retries and recovery

Retryable failures (429, 5xx, timeouts, malformed or reset streams) are retried by the orchestrator only
**before the request produced any output**, with bounded exponential backoff; permanent errors are not
retried; SDK retries are off. A final failure is stored as failed and sent with
`recovery: { attempts, alternatives }`: the user may retry or explicitly choose another provider; the
server never switches provider on its own ([ADR 0011](decisions/0011-provider-failures-retry-not-failover.md)).
`apps/api/test/provider-resilience.test.ts` covers timeout, 429, 5xx, malformed stream, mid-stream
disconnect, cancellation during the backoff, failure after a tool ran (the tool ran once), success after
retries, repeated failures (bounded), the time budget, Smart and Compare, and an explicit switch afterwards,
all through the real SDKs.

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

- configuration from the environment only (`provider-readiness.test.ts`): both providers live with the
  configured models; keys trimmed (secret managers often add a newline); a half-configured provider stays
  off with a warning naming the variable, never the value; one provider is enough; placeholder values
  (`your-api-key`, `sk-...`, `<…>`) are flagged at start-up; keys never appear in `/v1/providers`;
- Compare through **both real SDK adapters** and the whole API: two labelled, stored answers under one
  compare group, each request sent to its provider's own endpoint with the configured model, and usage
  accounted per provider in `/v1/usage`.

Mutation checks were run on the main fixes: disabling the Claude continuation, or dropping `tools` on the
last round, makes the contract tests fail.

## Turning on real providers (production)

Nothing in the code or the repository changes. Keys live only in the deployment's secret store:

1. Put `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in the secret manager of the host running the API
   (never in `.env.example`, the repository, a client app or a build). Set `OPENAI_MODEL` /
   `ANTHROPIC_MODEL` to current model ids from each provider's documentation. For Amazon Bedrock see
   [below](#amazon-bedrock-amazon-nova).
2. Set `PROVIDER_MODE=live` (the default when unset). Keep `PROVIDER_MODE=fake` for demos and CI.
3. Start the API. In production (`NODE_ENV=production`) it **refuses to start** (exit 1, one line on
   stderr naming variables, never values) when no provider is complete, when a provider is
   half-configured, when a key looks copied from an example, or when the Bedrock settings are
   incomplete or name the wrong Nova tier. Outside production the same
   problems are start-up warnings. With only one provider configured, production warns that DASH AI has
   nothing to fail over to. `GET /v1/providers` (operator token) must show `mode: "live"` for each
   provider you configured.
4. Run the live smoke (below) once per provider and model before inviting users.

### Amazon Bedrock (Amazon Nova)

What the AWS account needs before DASH can use Bedrock (all in the Region set as `BEDROCK_REGION`,
`eu-west-1` for the DASH stack):

1. **Model access** to the Nova tiers you will configure (Amazon Nova Micro, Nova Lite, Nova 2 Lite).
2. **Model or inference-profile ids**: in Regions where Nova is served through cross-Region inference,
   use the inference-profile id (for example `eu.amazon.nova-lite-v1:0`) rather than the bare model id;
   a bare id that the Region cannot serve on demand is treated as a configuration failure.
3. **Credentials**, either:
   - `BEDROCK_AUTH=iam` (recommended): an IAM user (or role) whose policy allows only
     `bedrock:InvokeModelWithResponseStream` (and `bedrock:InvokeModel`) on those foundation models and
     inference profiles; its `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` go into the server's secret
     store, where the AWS SDK reads them; or
   - `BEDROCK_AUTH=api_key`: a Bedrock API key in `BEDROCK_API_KEY` (long-term keys suit trials; AWS
     recommends short-term credentials for production).
4. **Prices** for the cost ledger: confirm the Nova prices for the Region and set `MODEL_PRICES` where
   they differ from the built-in estimates (`apps/api/src/intelligence/cost.ts`).

Then verify from the server, with the same environment, before switching (about 3 extra requests for
the tier check): `PROVIDER_MODE=live DASH_LIVE_SMOKE=1 node --env-file=<file> dist/smoke/main.js --provider bedrock`.
It checks a normal answer, streaming, cancellation, a tool round trip and one answer from each configured
Nova tier, and prints no key.

### Switching a running production server from `fake` to `live`

The order keeps the server answering at every step and makes a mistake cheap to undo:

1. **Deploy the code first, still in `fake` mode.** The new start-up check does not apply to `fake`, so
   this deploy changes nothing visible. Confirm `/health`, `/ready`, sign-in, Automates and push.
2. **Add the credentials to the server's secret store / environment file**, typed or pasted on the
   server itself, never through chat, tickets, the repository or CI logs: `OPENAI_API_KEY`,
   `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (both providers, so DASH AI can fail over).
   Keep `PROVIDER_MODE=fake` for now; keep `PROVIDER_DETAILS=hidden`.
3. **Verify the credentials before switching**, from the built API on the server with the same
   environment: `DASH_LIVE_SMOKE=1 node dist/smoke/main.js` in `apps/api` (with the environment file
   loaded, e.g. `node --env-file=<file> dist/smoke/main.js`). It uses an in-memory store and never the
   production database; it needs `PROVIDER_MODE=live` in its own environment
   (`PROVIDER_MODE=live DASH_LIVE_SMOKE=1 node --env-file=<file> dist/smoke/main.js`, since a value set
   on the command line wins over the file). With both providers it sends about 22 small real requests,
   each capped in output tokens, and prints no key.
4. **Switch:** set `PROVIDER_MODE=live` and restart the API. If a credential is missing or malformed it
   exits at once with the variable named; the previous process is gone, so either fix the value or set
   `PROVIDER_MODE=fake` again and restart.
5. **Check:** start-up log `provider configuration` shows `openai:live` and `anthropic:live` and no
   warning; `GET /v1/assistant` answers `available: true, demo: false`; one chat and one Run-now
   automation from a real account answer; `dash_provider_failures_total` stays flat in `/metrics`.
6. **Roll back** at any time with `PROVIDER_MODE=fake` and a restart: keys can stay in place.

The clients need no change: both read `/v1/providers` and only offer what is configured; Demo Mode
stays available in the apps and never calls a provider.

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
