# Design

## Identity
| Token | Value | Use |
| --- | --- | --- |
| Black | `#0A0A0B` | App background |
| Surface / SurfaceHigh / SurfaceHighest | `#121214` / `#1A1A1E` / `#232328` | Cards, composer, drawer, bubbles |
| Gold | `#D4AF37` (gradient `#F3D98A → #D4AF37 → #9C7A1F`) | Primary actions, highlights, labels |
| White | `#F7F7F5` | Primary text |
| Grey | `#A1A1A8` (secondary) / `#7A7A82` (tertiary) | Secondary text |
| Error | `#FF7A70` | Failures |

Contrast: white on black ≈ 19:1, grey on black ≈ 7.8:1, gold on black ≈ 9.6:1, black on gold
≈ 9.6:1 — all above WCAG AA. Touch targets are at least 48 dp (icon buttons, chips) and primary
buttons are 52 dp tall.

Typography uses the system sans-serif with a restrained scale: light display weights for the
wordmark and headlines, semibold labels, 16 sp body text with 24 sp line height.

Motion is restrained: splash fade/scale (≈1.6 s), pager transitions, drawer, typing indicator.

## Brand mark — action required
**The official Dash World logo is not in this repository.** The build uses a clean temporary
typographic mark:

- Launcher icon / system splash: a gold-gradient "D" letterform on black
  (`app/src/main/res/drawable/ic_launcher_foreground.xml`, `ic_splash_mark.xml`,
  `ic_launcher_monochrome.xml`).
- In-app wordmark: "DASH" in gold gradient + "AI" in white light weight (`DashWordmark` in
  `ui/components/Components.kt`).

This is a placeholder, not a replacement corporate logo. Supply the official vector asset
(SVG or Android vector drawable, plus monochrome variant) and replace those three drawables and
`DashWordmark`.

## Key screens
- **Splash** — mark, wordmark, "Think. Create. Execute.".
- **Onboarding** — pager with Skip / Next / Get started and gold page indicator.
- **Assistant** — top bar (history, title, model selector, new chat), status banners
  (Demo, offline, errors), mode chips, message list (reverse layout so streaming stays anchored),
  composer (attachment chips, recipient line, attach, input, send/stop).
- **Compare** — two equal cards side by side, each labelled with its provider and model.
- **Documents, Prompt library, Settings, Account** — card-based layouts on black.
