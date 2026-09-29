# UI CONCEPTS

Dashboard design studies for Dash AI. Four layouts, each a standalone HTML file you can
open in any browser — no build step, no server, nothing to install.

Start at **[index.html](index.html)**, or open any concept directly. Every page carries a
switcher at the bottom so you can flip between all four.

| File | Name | What it is |
| --- | --- | --- |
| `01-aurora-glass.html` | **Aurora Glass** | The one with the calendar. Frosted panels over an ambient gold wash, white metric cards on dark, calendar and scheduled list in a right-hand rail. |
| `02-signal-board.html` | **Signal Board** | Control room. Horizontal nav, four metric tiles, throughput charted against latency, model routing zones, live feed of dispatched prompts. |
| `03-ops-timeline.html` | **Ops Timeline** | Automations as a week. Day strip on top, one row per run with a status stripe, summary rail with counts and token spend. |
| `04-console-light.html` | **Console Light** | The admin face. Black labelled sidebar with live capacity meters, light working canvas, dense activity table with route and status on every row. |

## Where these came from

A reference reel (Instagram, `@code.xr`, "Admin Dashboard V7") showing two skins toggled by a
pill switcher: a glassy dark fitness dashboard and a blue corporate admin panel. What was worth
keeping was the **layout grammar**, not the fitness content:

- fixed icon or label rail → content column → context rail
- a KPI row above one hero chart above a list or table
- state as a coloured text chip, never a heavy badge
- a floating pill switcher for swapping the whole shell
- large radii (14–22px), one accent per skin, a small lift on hover

The reel's stack was React + Tailwind + framer-motion + lucide-react. These files are plain HTML
and CSS so nothing has to be installed to look at them.

## What changed for Dash

The reference's orange-on-glass became Dash's gold-on-black from
[`docs/design.md`](../docs/design.md), and the fitness metrics became real Dash concerns:

- conversations, tokens against the monthly pool, time to first token, documents analysed
- Dash Smart / OpenAI / Claude / Compare routing splits, with the reason a route was chosen
- prompt library usage, scheduled automations, seats, provider rate limits

### Palette

| Token | Value | Use |
| --- | --- | --- |
| Black | `#0A0A0B` | Page ground |
| Surface / high / highest | `#121214` / `#1A1A1E` / `#232328` | Panels, rows, chips |
| Gold | `#D4AF37`, gradient `#F3D98A → #D4AF37 → #9C7A1F` | Accent, primary action, **running** |
| White | `#F7F7F5` | Primary text, light cards |
| Grey | `#A1A1A8` / `#7A7A82` | Secondary / tertiary text |
| Done | `#5FD4A0` | Completed |
| Scheduled | `#7FA8FF` | Queued, upcoming |
| Failed | `#FF7A70` | Errors (matches the existing error token) |

Semantic colours stay separate from the brand accent, so green/blue/coral can signal status
anywhere without competing with gold.

### Type

Manrope for interface text, JetBrains Mono for every figure, timestamp and identifier — digits
set `tabular-nums` so columns line up. Both load from Google Fonts with a system fallback, so
the pages still read correctly offline.

## Status

Reference material only. Sample figures throughout — none of it is wired to `apps/api`, and
none of it is Compose code. The app itself is Kotlin and Jetpack Compose; if one of these
directions is chosen, the layout and colour decisions port over, the HTML does not.
