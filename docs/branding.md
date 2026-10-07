# Branding

## The mark: the faceted diamond (working mark)

DASH AI's mark is the **faceted diamond** from the approved splash concept: a tall crystal with four
facets separated by hairline cuts, lit in champagne. It replaces the earlier temporary "D". It is a
**working mark** until the Director approves final artwork (an official SVG); the geometry is kept in one
place per platform so the final file is a swap, not a hunt.

| Where | Single source | Used by |
| --- | --- | --- |
| Web mark (colour) | `apps/web/src/brand/mark.svg` (per-facet champagne tones) | `BrandMark` in `src/ui/kit.tsx`: splash, sign-in, sidebar, Home, Settings |
| Web mark (monochrome) | `apps/web/src/brand/mark-mono.svg` (`currentColor`) | Single-colour uses |
| Web tab icon | `apps/web/public/favicon.svg` (mark on graphite) | Browser tab |
| Android mark | `DashBrand.MARK_PATH` / `MARK_BOUNDS` in `ui/brand/DashBrand.kt` (108-unit viewport) | `BrandMark` (theme accent on light surfaces; `luminous = true` on the dark splash) |
| Android launcher icon | `res/drawable/ic_launcher_foreground.xml` on `@color/dash_black` | Home screen |
| Android themed icon | `res/drawable/ic_launcher_monochrome.xml` | Android 13+ themed icons |
| Android system splash | `res/drawable/ic_splash_mark.xml` | Splash before the app draws |

All Android drawables use exactly `DashBrand.MARK_PATH` (`AndroidPlatformTest` fails if they drift).
The web SVGs use the same coordinates. Because the facets are separated by cuts, the mark stays faceted
in one colour, which the themed icon needs.

Colours come only from the approved palette (`ui-design-system.md`): ivory `#FBF6EA`/`#F4ECD9`,
champagne `#DCC07F`/`#C9A75B`, deep champagne `#7A5C1C`. The old yellow `#D4AF37` gradient is gone.

### Replacing the working mark with approved artwork

You need a square SVG of the mark (no text) and, ideally, a single-colour version.

- **Web:** replace `mark.svg`, `mark-mono.svg` and `public/favicon.svg`; set `temporaryMark: false` in
  `brand.ts`.
- **Android:** if it is a simple vector, put its path in `DashBrand.MARK_PATH`/`MARK_BOUNDS` and the same
  path in the three drawables, then set `TEMPORARY_MARK = false`. If it is richer, replace the drawables
  and draw that resource in `BrandMark`.

## Wordmark and tagline

"DASH AI" in spaced capitals ("AI" carries the champagne accent in the app chrome; on the splash the whole
wordmark is a serif with an ivory-to-champagne light). Tagline: **Beyond the Digital.** Footer on the
splash: **A DASH WORLD PRODUCT**.

## The splash: "Intelligence. Possibility. Arrival."

Always dark and cinematic, whatever the app theme. Layout from top to bottom: a vast world with a warm lit
rim (upper right); the luminous faceted diamond; "DASH AI"; "Beyond the Digital."; abstract flowing
terrain with fine luminous contour lines (deliberately data-like, not sand dunes and not a game loading
screen) opening onto a warm ivory/nude/champagne horizon; one tiny anonymous figure looking up; "— A DASH
WORLD PRODUCT —". No buttons and no feature cards. About 1.6 s; shorter, without movement, when the
system asks for reduced motion.

The scene layers are generated once by `tools/brand/splash_scene.py`:

| Output | Web | Android |
| --- | --- | --- |
| Planet | `apps/web/src/brand/splash/planet.svg` | `res/drawable/splash_planet.xml` |
| Terrain and horizon | `.../splash/terrain.svg` (stretched to the screen) | `splash_terrain.xml` |
| Figure | `.../splash/figure.svg` | `splash_figure.xml` |

The mark, wordmark, tagline and footer are drawn by `Splash` (`apps/web/src/screens/Start.tsx`) and
`SplashContent` (`ui/onboarding/SplashAndOnboarding.kt`). Edit the generator, not its outputs, and
run `python3 tools/brand/splash_scene.py` from the repository root.

## Provider names are not brand

No AI provider name or logo appears anywhere a person can see (see `provider-neutrality.md`). The only
reference to third parties is the privacy processor disclosure.

## Public launch messaging

When dates are shown publicly, use **"COMING DECEMBER"** or **"OFFICIALLY LAUNCHING DECEMBER 2026"**.
No other launch month is used. Platforms: Android and Web.

## Director approvals needed

- Final mark artwork (SVG) to replace the working faceted diamond.
- The splash scene as built (vector rendition of the reference image).
- Whether the champagne should move slightly toward warm nude (see `ui-design-system.md`).
