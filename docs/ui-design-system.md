# DASH AI design system (Android)

DASH AI — *Beyond the Digital.* — A Dash World product.

The Android app is Jetpack Compose + Material 3. Every screen reads its colours, spacing, radii,
sizes and type from `apps/android/app/src/main/java/com/dashworldng/ai/ui/theme/Theme.kt` and its
building blocks from `ui/components/Components.kt`. No screen hard-codes a colour.

## Principles

- **Calm and native.** Warm ivory surfaces, deep charcoal text, generous whitespace, Material 3
  behaviour (sheets, drawers, dialogs, ripple, system back).
- **Gold is an accent, not a theme.** Champagne gold is used sparingly for important DASH AI brand
  moments, primary actions where appropriate, selected interface states, progress, focus and subtle
  highlights. Nothing else is gold. No neon, no purple/blue "AI" gradients, no loud yellow metallic gold.
- **DASH AI is the product.** No AI provider name, logo, selector or comparison appears in the
  interface ([provider-neutrality.md](provider-neutrality.md)).
- **Honest.** Only features that exist are shown. Demo Mode is always labelled. Security text says
  exactly what the architecture does (encryption in transit and at rest, *not* end-to-end).
- **Readable first.** Assistant answers sit in open reading space (no bubble); user messages are a
  quiet bubble. Content is capped at 720 dp and centred on tablets, foldables and landscape.

## Tokens

### Colour (`DashColorTokens`, light default + dark)

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `background` | `#FAF8F3` ivory | `#141413` charcoal | screens |
| `surface` | `#FFFFFF` | `#1C1B19` | cards, sheets, composer |
| `surfaceMuted` | `#F2EEE5` | `#242320` | user messages, chips, code |
| `surfaceSelected` | `#EBE5D8` | `#2D2B27` | selected rows |
| `outline` / `outlineStrong` | `#E5DFD3` / `#CFC7B7` | `#34322D` / `#4A473F` | hairlines, card borders |
| `fieldOutline` | `#8F8A80` | `#7A766C` | text-field borders (≥ 3:1) |
| `ink` / `inkSecondary` / `inkTertiary` | `#1D1C1A` / `#57534B` / `#706B62` | `#F4F1EA` / `#BDB7AB` / `#9E978A` | text |
| `accent` | `#C9A75B` | `#D4B46C` | gold fills (primary buttons, switches) |
| `onAccent` | `#1D1C1A` | `#1D1C1A` | labels on gold |
| `accentInk` | `#7A5C1C` | `#DCC07F` | gold that must be legible (text, selection marks) |
| `accentContainer` | `#F4ECD9` | `#3A3221` | soft gold washes |
| `success`, `warning`, `error` (+ containers) | green / amber / red | lighter tints | status badges and notices |
| `brandCanvas` / `brandInk` | `#141413` / `#F4F1EA` | same | splash (dark in both themes) |

**Contrast** (WCAG 2.1, computed from the values above):

| Pair | Light | Dark |
| --- | --- | --- |
| ink on background | 16.0 : 1 | 16.3 : 1 |
| inkSecondary on background | 7.2 : 1 | 9.2 : 1 |
| inkTertiary on background / surface | 5.0 / 5.3 : 1 | 6.4 / 5.9 : 1 |
| accentInk on background | 5.9 : 1 | 10.4 : 1 |
| onAccent on accent (button labels) | 7.4 : 1 | 8.6 : 1 |
| success / warning / error on their containers | 5.2 / 5.0 / 5.7 : 1 | 6.8 / 7.1 / 7.8 : 1 |
| fieldOutline on surface | 3.4 : 1 | 3.8 : 1 |

The light gold *fill* (`accent`) is 2.2 : 1 against ivory. It is therefore only used where the
element is identified by its label or icon (buttons: label 7.4 : 1) or by position (switch thumb).
Selection marks (radio dots, the selected filter chip border) use `accentInk` instead.

### Spacing, radii, elevation, sizing

- `Spacing`: 2, 4, 8, 12, 16, 24, 32, 48 dp; screen gutter 20 dp.
- `Radii`: 8, 12, 16, 24 dp and pill; user bubble 20 dp with a 6 dp corner toward the sender; sheets 24 dp.
- `Elevation`: 0 / 1 / 3 / 6 dp. Light theme uses a 2 dp shadow on the composer only; cards use hairlines.
- `Sizing`: touch targets ≥ 48 dp, icons 20 dp (16 dp small), buttons 52 dp, avatar 34 dp,
  reading width ≤ 720 dp, forms ≤ 480 dp.

### Typography

Serif (`BrandSerif`, the platform serif) for brand moments and greetings — display and headline
sizes. Sans-serif for everything people read and operate. All sizes are in `sp`, so system font
scaling applies everywhere.

### Palette review (champagne)

The palette is locked. Light: `#FAF8F3` background, `#FFFFFF` surface, `#F2EEE5` muted surface, `#1D1C1A`
ink, `#57534B` secondary ink, `#C9A75B` champagne, `#7A5C1C` deep champagne (legible gold),
`#F4ECD9` champagne container. Dark: `#141413`, `#1C1B19`, `#F4F1EA` ink, `#D4B46C` champagne,
`#DCC07F` legible gold. Status: `#2E6E47` success, `#8A5A10` warning, `#A3302A` error.

Reviewed against the rendered splash in this milestone: the champagne reads warm and restrained next to
the ivory horizon, so it is **unchanged**. A slight move toward warm nude (for example `#C9A75B` →
`#C8A866`) is only a proposal for the Director; it has not been applied or rendered side by side.

### Splash

Always dark, independent of the theme: see [branding.md](branding.md#the-splash-intelligence-possibility-arrival).

### Theme

`Settings → Appearance`: System default (initial), Light, Dark, stored in DataStore (`theme`). The
activity switches the system-bar icon colour with the theme; the bars are transparent (edge to edge).

## Components (`ui/components/Components.kt` unless noted)

| Component | Notes |
| --- | --- |
| `BrandMark`, `BrandWordmark` | The faceted diamond drawn in code from `DashBrand.MARK_PATH` (same geometry as the launcher, themed and splash icons; `luminous = true` on the dark splash) and "DASH AI" in spaced capitals. Working mark pending the Director's final artwork ([branding.md](branding.md)). |
| `DashTopBar` | Back or custom navigation icon, calm title, actions |
| `PrimaryButton`, `SecondaryButton`, `TextAction` | Gold pill / outlined pill / quiet text; loading state |
| `DashTextField` | Outlined, labelled, error and supporting text |
| `Composer` (`ui/chat`) | Text, attachments, mode chip, send/stop, and the line "DASH AI · <mode>". No provider chip. No microphone (no voice input exists; see [voice.md](voice.md)). |
| `QuietCard`, `SettingsGroup`, `SettingsRow` | Surfaces and settings lists |
| `StatusBadge`, `Notice`, `DemoBadge` | Status tone → semantic colour |
| `EmptyState`, `ErrorState`, `LoadingState`, `ConfirmDialog` | Intentional states everywhere |
| `ModeSheet` (`ui/chat/Sheets.kt`) | Bottom sheet (mode and a link to Tools & Connections) |
| `UserMessage`, `AssistantMessage` (labelled "DASH AI"), `ToolActivity`, recovery card with Retry / Continue later (`ui/chat/MessageViews.kt`) | Conversation |
| `DocumentRow`, `UploadRow` (`ui/documents`) | Library rows |
| `MarkdownView` (`ui/markdown`) | Headings, lists, quotes, code with copy, grid tables that scroll sideways |

## States

Every major screen has deliberate empty, loading and error states: Home (no chats), chat (new chat,
working, stopped, provider failure, request error, offline), history (no chats / no matches),
documents (none, uploading, upload failed, no matches), document (not found, unsupported, failed),
tools (signed out, loading, error, tools off on the server, empty registry), account (Demo Mode,
usage unavailable, session expired), settings (connection checking/failed).

## Accessibility

- Touch targets ≥ 48 dp; icon buttons carry content descriptions; decorative icons do not.
- Headings are marked (`heading()`), selection uses `selected`/`stateDescription`, the recovery card
  is a polite live region, the working indicator has a description.
- Text scales with the system font size; no fixed-height text containers.
- Reduced motion: when the system animator scale is 0, the splash and the working indicator are
  static and screen transitions are instant.

## Verification status

See [release-readiness.md](release-readiness.md) → "Android UI". In short: the UI code is compiled
and its UI tests run against Compose Multiplatform 1.7.3 on the JVM (`apps/android/jvm-ui`), and the
screens were rendered with the desktop Skia renderer and inspected. It has **not** been built with
the Android Gradle plugin or run on an emulator or device.
