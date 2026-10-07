package com.dashworldng.ai.ui.brand

/**
 * Everything that identifies the product, in one place. See docs/branding.md for replacing the mark.
 *
 * The mark is SVG path data in the 108-unit viewport of Android's adaptive icons. The in-app mark
 * (BrandMark), the launcher icon (res/drawable/ic_launcher_foreground.xml, ic_launcher_monochrome.xml)
 * and the splash icon (res/drawable/ic_splash_mark.xml) all use this geometry; a unit test fails if
 * a drawable and this constant disagree.
 */
object DashBrand {
    const val NAME = "DASH AI"

    /** Wordmark parts: the second carries the gold accent. */
    const val WORDMARK_PRIMARY = "DASH"
    const val WORDMARK_ACCENT = "AI"

    /**
     * The faceted diamond: four crystal facets separated by hairline cuts, so it stays faceted in a
     * single colour (themed icons). Working mark from the approved splash concept, pending the
     * Director's final SVG; same geometry as apps/web/src/brand/mark.svg.
     */
    const val MARK_PATH = "M53.43,23.94 L55.68,47.8 L33.62,49.15 Z M54.99,24.47 L74.36,49.12 L57.19,47.8 Z M33.29,50.67 L55.69,49.3 L53.41,83.59 Z M57.2,49.31 L74.72,50.65 L54.95,83 Z"

    /** The part of the 108-unit viewport the mark occupies (left, top, right, bottom). */
    val MARK_BOUNDS = floatArrayOf(33f, 23.5f, 75f, 84f)

    /** True until the Director approves the final mark artwork. */
    const val TEMPORARY_MARK = true
}
