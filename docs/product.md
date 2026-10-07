# Product

## Vision
Dash AI is Dash World's own premium, multi-model assistant. It helps people think, create and
execute: everyday conversations, business planning, professional writing, working with
documents and structured research. It should feel like a distinctive Dash World product — calm,
confident, black and gold — not a copy of another chat app.

## Platform
Native Android first (Kotlin, Jetpack Compose, Material 3). Reference test device: Samsung A55.
A small secure backend holds all provider credentials; the app talks only to that backend.

## Experience

| Area | What the MVP provides |
| --- | --- |
| First run | Branded splash → four-page onboarding (what DASH AI is, modes, privacy) → sign in, create account, or continue in Demo Mode. |
| Assistant | New chat, streaming answers, stop, regenerate, edit and resend, copy, share, Markdown (headings, lists, tables, quotes, links, code blocks with language labels and copy buttons). |
| History | Conversation drawer with search, rename, delete (with confirmation); automatic titles; history survives app restarts. Signed-in users also get their server conversations pulled into the device after sign-in ([sync.md](sync.md)). |
| Routing | No provider selector: DASH AI routes every request itself and every answer is labelled "DASH AI" ([provider-neutrality.md](provider-neutrality.md)). |
| Modes | General, Business, Writing, Documents, Research — each changes the server instructions and the suggested prompts. Research states that live web search is not connected. |
| Documents | Pick PDF, DOCX, TXT or images; validation; upload progress; attachment chips in the composer; Summarise; Ask a question; Remove. |
| Prompt library | 29 starter prompts in 7 categories, search, favourites, create/edit/delete personal prompts, "Use prompt". |
| Settings & account | Demo Mode, simulated errors, server address and connection test (DASH AI availability), chat defaults (mode), privacy explanation, export, local data deletion, sign out, account deletion, usage totals. |
| States | Loading, empty, offline, streaming, stopped, failed (with retry), length-limited and refused answers. |

## Demo Mode
Demo Mode works with no server and no credits: navigation, persistent local conversations,
simulated streaming, stopping, regenerating, editing, prompt library, the document picker and all main
loading and error states (Settings → Simulate errors). Demo answers are generated on the device,
labelled "Demo response · simulated by DASH AI", marked with a DEMO badge and never presented as a
real answer. Demo documents are validated by name/type/size only and never read.

## Optional plugins (backend only so far)
Tool calling is an optional extension, never a requirement. Tools are capabilities the person grants, separate from the AI infrastructure DASH AI uses;
anything else (GitHub, Gmail, Calendar, web search, Dash World services…) is meant to be an opt-in plugin
the user turns on and grants scopes to ([plugins.md](plugins.md)). Today the only real plugin is a harmless
built-in demo (time and text statistics); there are no external-service plugins, and the Android app has no
plugin screen yet (manage them through the API).

## Product boundaries (deliberate)
- The apps never call an AI provider directly and never hold provider keys.
- No AI provider is named or selectable anywhere in the apps; the privacy text discloses that DASH AI
  may use third-party AI service providers to process requests.
- Research does not browse the web: no search provider is configured, and the UI says so.
- Document analysis is only claimed where text was actually extracted (TXT, DOCX, text-based PDF).
  Images and scanned PDFs are accepted but not analysed, and the app says so.
- No Compare: DASH AI gives one answer.
- No voice yet ([voice.md](voice.md) records the direction; nothing is shown in the apps).
- Plugins are off until the user enables them; the model can only use tools the user enabled and granted,
  and nothing with side effects runs yet.

## Personas
- **Founder / operator** — business plans, pricing, go-to-market, board updates.
- **Professional** — emails, rewrites, executive summaries, proofreading.
- **Analyst / student** — structured research and document summaries.
