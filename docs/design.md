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

## Brand mark — Director approval required
The mark is the **faceted diamond** from the approved splash concept (working mark until the Director
approves final artwork). Sources, variants (colour, monochrome, launcher, themed icon, favicon, splash) and
the swap procedure: [branding.md](branding.md).

## Key screens
- **Splash** — the cinematic brand scene: planet, faceted diamond, "DASH AI", "Beyond the Digital.", flowing terrain, the luminous horizon and a tiny figure ([branding.md](branding.md)).
- **Onboarding** — pager with Skip / Next / Get started and gold page indicator.
- **Assistant** — top bar (history, title, new chat), status banners
  (Demo, offline, errors), mode chips, message list (reverse layout so streaming stays anchored),
  composer (attachment chips, recipient line, attach, input, send/stop).
- **Documents, Prompt library, Settings, Account** — card-based layouts on black.
