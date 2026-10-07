# Android navigation and screens

Single activity (`MainActivity`), Jetpack Compose, `navigation-compose`. Routes live in
`ui/DashAiApp.kt` (`Routes`). There are no bottom tabs: Home is the root, a side drawer holds chat
history and the app's destinations, and the chat screen keeps the full height for reading.

```
System splash (until settings load)
  └─ Splash (≈0.8 s; instant with reduced motion)
       ├─ first launch ───────────────► Onboarding ─► Auth
       ├─ no account ─────────────────► Auth ──(sign in / create / Demo Mode)──► Home
       └─ signed in or Demo Mode ─────► Home

Home (root)
  ├─ Ask field / quick action / recent chat ─► Chat
  ├─ Avatar ─► Account ─► (sign out / everywhere / delete) ─► Auth
  └─ Drawer: New chat · Search · History (Today / Yesterday / Previous 7 days / Older)
             Home · Documents · Tools & Connections · Prompt library · Settings

Chat ─ back ─► Home        (history icon opens the same drawer)
Documents ─► Document detail ─ "Ask about this document" / suggestion ─► Chat (Home stays below)
Prompt library ─ "Use prompt" ─► Chat
Settings ─► Tools & Connections, Account (sign out and sessions), Auth (to leave Demo Mode)
```

`goFresh` clears the back stack for the auth boundary (after splash, onboarding, sign-in and
sign-out), so Back never returns to a signed-out or previous-account screen. Other destinations are
opened with `launchSingleTop`. System Back follows the stack; Back from Chat returns to Home.

## State ownership

- One `ChatViewModel` is created at the app level and shared by Home and Chat, so a question asked
  on Home continues in the chat. When the account changes (sign-in, sign-out, Demo Mode) it starts a
  new chat and clears search, notices and tool names, so nothing of the previous account remains on
  screen. Data separation itself is enforced by `LocalAccountGuard` (core).
- Other screens have their own ViewModel per destination (`dashViewModel`).
- Pure UI decisions live in `apps/android/core/.../presentation` and are unit-tested: start route,
  greeting and initials, quick actions, history grouping, DASH AI availability,
  failure recovery, sync status, document labels and filters, auth failures, tool connection states
  and tool activity labels.

## Screens

| Screen | What is real | Deliberately absent |
| --- | --- | --- |
| Splash | The cinematic brand scene: planet, faceted diamond, "DASH AI", "Beyond the Digital.", flowing terrain, luminous horizon, tiny figure, "A DASH WORLD PRODUCT" ([branding.md](branding.md)); about 1.6 s | Buttons, feature cards |
| Onboarding | One screen: "What are we building today?", three cues, Get started; shown once | Carousel |
| Auth | Email + password sign-in and account creation (the only methods the server supports), validation, offline, wrong credentials, existing account, rate limit, server failure with Retry, server address, Demo Mode | Google / Microsoft / Apple, email codes, password reset (not in the API) |
| Home | Time-aware greeting with the account's own first name (none in Demo Mode), Ask field, quick actions mapped to real modes (Write, Analyse a file, Brainstorm, Code, Research, More tools → Tools), recent chats, empty state | Invented names |
| Chat | Streaming answers, working state, stop, copy, share (Android share sheet), regenerate, edit and resend, markdown (headings, lists, code, tables), attachments, mode sheet, answers labelled "DASH AI", tool activity, recovery card, jump to latest | Provider selector, Compare, microphone (no voice input) |
| Recovery | "DASH AI couldn't complete that response" (or "This answer couldn't be completed"), DASH AI's neutral message and attempt count, Retry, Continue later | Any provider name or provider switch |
| History | Search, grouped by day, rename, delete (synced when signed in) | |
| Documents | Search, filters for the kinds present, rows with type, size, date and status (Ready / Processing / Unsupported / Failed / Demo), upload with progress | "Analysed" claims |
| Document detail | Metadata, the server's status explanation, Ask about this document, three suggestions that only pre-fill the composer, remove | |
| Tools & Connections | The server's plugin registry (today: built-in "Dash demo tools"), Available / Connected / Disabled / Requires permission, switch, permissions | Fabricated integrations |
| Account | Name, email, sync status with Sync now, this phone, usage, sign out, sign out everywhere, delete account; Demo Mode explanation | Device list (the server keeps none), plans or tiers |
| Settings | Appearance, chat defaults, Privacy & Security, Connected tools, Data & Sync, Demo Mode (with simulated errors), Server, About | Notifications (not implemented) |

## Insets, keyboard and sizes

The activity is edge to edge. Scaffolds handle bar insets; the chat column uses `imePadding` so the
composer rises with the keyboard; forms scroll under the keyboard. Content is centred and capped
(720 dp reading, 480 dp forms), so tablets, foldables and landscape stay readable.
