# Branding

The "D" mark in the apps is **temporary**: a typographic placeholder until the official DASH AI logo
is supplied. It has been kept in one place per platform so the real logo is a file swap, not a hunt.

| Where | Single source | Used by |
| --- | --- | --- |
| Web | `apps/web/src/brand/mark.svg` and `apps/web/src/brand/brand.ts` (name, wordmark) | `BrandMark` / `Wordmark` in `src/ui/kit.tsx`, so the splash, sign-in, sidebar, Home and Settings |
| Web tab icon | `apps/web/public/favicon.svg` | The browser tab |
| Android | `DashBrand` in `app/src/main/java/com/dashworldng/ai/ui/brand/DashBrand.kt` (name, wordmark, mark geometry) | `BrandMark` / `BrandWordmark` in `ui/components/Components.kt`, so splash, onboarding, sign-in, drawer, Home and Settings |
| Android launcher and system splash | `res/drawable/ic_launcher_foreground.xml`, `ic_launcher_monochrome.xml`, `ic_splash_mark.xml` | The home-screen icon (including themed icons) and the system splash |

## Replacing the mark with the official logo

You need: a square SVG of the mark (no text), ideally a single-colour version for Android's themed
icons, and the exact brand colours if they differ from the champagne gold in use.

**Web:** replace `apps/web/src/brand/mark.svg` and `apps/web/public/favicon.svg`; set
`temporaryMark: false` in `brand.ts`. Nothing else changes.

**Android:**
- If the logo is a simple vector: put its path data in `DashBrand.MARK_PATH` (108-unit viewport) and
  `MARK_BOUNDS`, and the same path in the three drawables. `AndroidPlatformTest` fails until all four
  agree.
- If it is a richer vector or bitmap: replace the three drawables with it, and change the body of
  `BrandMark` to draw that resource; `DashBrand` keeps the name and wordmark.

The typography of the wordmark ("DASH" in ink, "AI" in gold, spaced capitals) and the colour tokens
(`ui-design-system.md`) are part of the current look and are not affected by the mark swap.
