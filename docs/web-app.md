# DASH AI web app (`apps/web`)

The same assistant as the Android app, in the browser: React 19 + TypeScript, built with Vite. It
talks only to the DASH AI API (the same contracts as Android, from `packages/contracts`); AI-provider
keys never reach the browser.

## What it does

| Area | Web app |
| --- | --- |
| Start | Brand splash, one onboarding screen ("What are we building today?"), email/password sign-in or account creation (the only methods the API supports), Demo Mode |
| Home | Greeting with the account's own first name, Ask field, quick actions (Write, Analyse a file, Brainstorm, Code, Research, More tools), recent chats |
| Chat | Streaming answers, stop, copy, share (where the browser supports it), regenerate, try the other provider, edit and resend, Compare, Markdown (headings, lists, tables, code with copy), attachments, mode sheet, provider sheet (remembered), tool activity (names and outcomes only, shown again when a chat is reopened), recovery card (Retry / Change provider / Continue later; never automatic), offline and error notices |
| History | Sidebar grouped Today / Yesterday / Previous 7 days / Older, search, rename, delete. On phones the sidebar slides in |
| Documents | Library with search and type filters, upload with progress, status (Ready / Unsupported / Demo), detail page, "Ask about this document" and suggestions that only fill the composer |
| Prompt library | The same 29 starter prompts, categories, search, favourites and "My prompts" as Android (shared from `packages/contracts`, checked against `fixtures/prompt-library.json` by both test suites). "Use prompt" opens a new chat in the prompt's mode with the text ready to edit. Custom prompts and favourites stay in this browser for this account and are removed on sign-out, like Android |
| Tools & Connections | The server's real plugin registry with Available / Connected / Disabled / Requires permission |
| Account | Name, email, usage, sign out, sign out everywhere, delete account |
| Settings | Appearance (System / Light / Dark), defaults, Privacy & Security (accurate: encrypted at rest, not end-to-end), Demo Mode and simulated errors, About |

The design tokens (ivory and charcoal, champagne gold as an accent) are the same as Android's; see
[ui-design-system.md](ui-design-system.md).

## Run it locally

```bash
pnpm install
pnpm build                                   # contracts, API and web
# terminal 1: the API (fake providers; add DATABASE_URL for durable storage)
PROVIDER_MODE=fake pnpm --filter @dash-ai/api start
# terminal 2: the web app with hot reload, proxying /v1 to http://127.0.0.1:8787
pnpm --filter @dash-ai/web dev               # http://127.0.0.1:5173
```

`DASH_API_PROXY` points the dev/preview proxy at another API address.

## Tests

| Command | What runs |
| --- | --- |
| `pnpm --filter @dash-ai/web test` | Unit tests (Vitest + jsdom): UI logic, the SSE parser against the shared contract fixtures, the chat engine (streaming, tool activity, recovery without automatic switching, stop, request failures, history filtering, Demo Mode) |
| `pnpm --filter @dash-ai/web e2e` | Playwright in Chromium at phone (Pixel 7) and desktop sizes against a running API (`PROVIDER_MODE=fake`, PostgreSQL) and `vite preview`. Set `DASH_SHOTS_DIR` to save screenshots. CI job: `web-e2e` in `ci.yml` |

## Deploying (prepared, not done)

Serve the built files (`apps/web/dist`) and the API from **one HTTPS origin** behind a reverse proxy:
`/v1/*`, `/health` and `/ready` go to the API, everything else to `dist/` with a fallback to
`index.html` (client-side routes such as `/chat/…`). Same origin means no CORS configuration and the
page's Content-Security-Policy (`connect-src 'self'`) holds. Example (Caddy):

```
dash.example.com {
  handle /v1/* { reverse_proxy 127.0.0.1:8787 }
  handle /health { reverse_proxy 127.0.0.1:8787 }
  handle {
    root * /srv/dash-web
    try_files {path} /index.html
    file_server
  }
}
```

SSE needs proxy buffering off for `/v1/chat/stream` (Caddy streams by default; for nginx set
`proxy_buffering off`). See [staging-runbook.md](staging-runbook.md) for the API side.

## Security notes

- Production builds carry a strict Content-Security-Policy: scripts, styles, images and API calls
  from this origin only; no third-party code or fonts.
- Answers are rendered as Markdown with raw HTML disabled; links open in a new tab with
  `noopener noreferrer`.
- The session token is kept in `sessionStorage` (this tab) by default, or `localStorage` when the
  person chooses "Keep me signed in". Script injection could read it, which is why the CSP matters;
  an HttpOnly cookie session would need API changes (not done).
- A 401 from the API signs the browser out ("Your session has ended").
- Demo Mode chats and document details stay in this browser's `localStorage`, separate from any
  account; Settings → "Delete Demo Mode data" removes them.

## Known limits

- Custom prompts and favourites are kept per device (browser or phone); the API does not sync them yet.
- Not tested in Safari or Firefox; Playwright runs Chromium only.
- The "D" brand mark is temporary until the official Dash World asset is supplied.
