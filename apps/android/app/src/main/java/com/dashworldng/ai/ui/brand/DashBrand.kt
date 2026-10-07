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

    /** TEMPORARY typographic "D" until the official DASH AI logo is supplied. */
    const val MARK_PATH = "M37,33 L52,33 A21,21 0,0 1,52 75 L37,75 Z M44.5,40.5 L52,40.5 A13.5,13.5 0,0 1,52 67.5 L44.5,67.5 Z"

    /** The part of the 108-unit viewport the mark occupies (left, top, right, bottom). */
    val MARK_BOUNDS = floatArrayOf(37f, 33f, 73f, 75f)

    const val TEMPORARY_MARK = true
}
