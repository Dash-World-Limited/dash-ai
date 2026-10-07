package com.dashworldng.ai.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.data.settings.ThemePreference

/**
 * The DASH AI design system. Every screen reads colours, spacing, radii and sizes from here:
 * nothing in a screen hard-codes a colour.
 *
 * Light (default): warm ivory surfaces, deep charcoal text. Dark: deep charcoal surfaces, ivory text.
 * Champagne gold is used sparingly for important DASH AI brand moments, primary actions where
 * appropriate, selected interface states, progress, focus and subtle highlights. Contrast is checked against WCAG AA (see docs/ui-design-system.md).
 */
@Immutable
data class DashColorTokens(
    val isDark: Boolean,
    /** Screen background. */
    val background: Color,
    /** Cards, sheets and the composer. */
    val surface: Color,
    /** Quiet fills: user messages, chips, inputs at rest. */
    val surfaceMuted: Color,
    /** Pressed / selected rows. */
    val surfaceSelected: Color,
    val outline: Color,
    val outlineStrong: Color,
    /** Text-field borders: ≥ 3:1 against surfaces (WCAG 1.4.11). */
    val fieldOutline: Color,
    /** Primary text and icons. */
    val ink: Color,
    /** Secondary text (≥ 4.5:1 on background). */
    val inkSecondary: Color,
    /** Tertiary text: metadata, timestamps (≥ 4.5:1 on background). */
    val inkTertiary: Color,
    /** Champagne gold for fills and accents (non-text, ≥ 3:1). */
    val accent: Color,
    /** Text/icons placed on [accent]. */
    val onAccent: Color,
    /** Gold that is legible as text (≥ 4.5:1 on background). */
    val accentInk: Color,
    /** A soft gold wash for selected states. */
    val accentContainer: Color,
    val success: Color,
    val successContainer: Color,
    val warning: Color,
    val warningContainer: Color,
    val error: Color,
    val errorContainer: Color,
    val codeBackground: Color,
    val scrim: Color,
    /** The dark brand canvas used by the splash screen in both themes. */
    val brandCanvas: Color,
    val brandInk: Color,
)

val LightTokens = DashColorTokens(
    isDark = false,
    background = Color(0xFFFAF8F3),
    surface = Color(0xFFFFFFFF),
    surfaceMuted = Color(0xFFF2EEE5),
    surfaceSelected = Color(0xFFEBE5D8),
    outline = Color(0xFFE5DFD3),
    outlineStrong = Color(0xFFCFC7B7),
    fieldOutline = Color(0xFF8F8A80),
    ink = Color(0xFF1D1C1A),
    inkSecondary = Color(0xFF57534B),
    inkTertiary = Color(0xFF706B62),
    accent = Color(0xFFC9A75B),
    onAccent = Color(0xFF1D1C1A),
    accentInk = Color(0xFF7A5C1C),
    accentContainer = Color(0xFFF4ECD9),
    success = Color(0xFF2E6E47),
    successContainer = Color(0xFFE3F0E6),
    warning = Color(0xFF8A5A10),
    warningContainer = Color(0xFFF7ECD6),
    error = Color(0xFFA3302A),
    errorContainer = Color(0xFFF8E3E0),
    codeBackground = Color(0xFFF2EEE5),
    scrim = Color(0x66000000),
    brandCanvas = Color(0xFF141413),
    brandInk = Color(0xFFF4F1EA),
)

val DarkTokens = DashColorTokens(
    isDark = true,
    background = Color(0xFF141413),
    surface = Color(0xFF1C1B19),
    surfaceMuted = Color(0xFF242320),
    surfaceSelected = Color(0xFF2D2B27),
    outline = Color(0xFF34322D),
    outlineStrong = Color(0xFF4A473F),
    fieldOutline = Color(0xFF7A766C),
    ink = Color(0xFFF4F1EA),
    inkSecondary = Color(0xFFBDB7AB),
    inkTertiary = Color(0xFF9E978A),
    accent = Color(0xFFD4B46C),
    onAccent = Color(0xFF1D1C1A),
    accentInk = Color(0xFFDCC07F),
    accentContainer = Color(0xFF3A3221),
    success = Color(0xFF86C79C),
    successContainer = Color(0xFF1E3326),
    warning = Color(0xFFE2B866),
    warningContainer = Color(0xFF3A2E17),
    error = Color(0xFFF0A9A2),
    errorContainer = Color(0xFF3D1E1B),
    codeBackground = Color(0xFF0F0F0E),
    scrim = Color(0x99000000),
    brandCanvas = Color(0xFF141413),
    brandInk = Color(0xFFF4F1EA),
)

/** Spacing scale (dp). Screens use these steps only. */
object Spacing {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
    val xxxl = 48.dp

    /** Horizontal screen gutter. */
    val gutter = 20.dp
}

object Radii {
    val sm = RoundedCornerShape(8.dp)
    val md = RoundedCornerShape(12.dp)
    val lg = RoundedCornerShape(16.dp)
    val xl = RoundedCornerShape(24.dp)
    val pill = RoundedCornerShape(percent = 50)

    /** User message bubble: soft, with a quieter corner toward the sender. */
    val userBubble = RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp, bottomStart = 20.dp, bottomEnd = 6.dp)
    val sheet = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp)
}

object Elevation {
    val none = 0.dp
    val card = 1.dp
    val raised = 3.dp
    val sheet = 6.dp
}

/** Component sizes. Touch targets are never below [minTouch]. */
object Sizing {
    val minTouch = 48.dp
    val icon = 20.dp
    val iconSmall = 16.dp
    val avatar = 34.dp
    val buttonHeight = 52.dp
    val chipHeight = 36.dp
    val composerMinHeight = 52.dp

    /** Reading width: content is centred and capped on tablets, foldables and landscape. */
    val maxContentWidth = 720.dp
    val maxFormWidth = 480.dp
}

private val LocalDashColors = staticCompositionLocalOf { LightTokens }

/** Accessor for the active tokens: `DashTheme.colors.ink`. */
object DashTheme {
    val colors: DashColorTokens
        @Composable @ReadOnlyComposable get() = LocalDashColors.current

    fun toneColor(tokens: DashColorTokens, tone: StatusTone): Pair<Color, Color> = when (tone) {
        StatusTone.SUCCESS -> tokens.success to tokens.successContainer
        StatusTone.WARNING -> tokens.warning to tokens.warningContainer
        StatusTone.ERROR -> tokens.error to tokens.errorContainer
        StatusTone.PROGRESS -> tokens.accentInk to tokens.accentContainer
        StatusTone.NEUTRAL -> tokens.inkSecondary to tokens.surfaceMuted
    }
}

private fun scheme(t: DashColorTokens): ColorScheme {
    val base = if (t.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = t.accent,
        onPrimary = t.onAccent,
        primaryContainer = t.accentContainer,
        onPrimaryContainer = t.ink,
        secondary = t.inkSecondary,
        onSecondary = t.surface,
        secondaryContainer = t.surfaceSelected,
        onSecondaryContainer = t.ink,
        tertiary = t.accentInk,
        background = t.background,
        onBackground = t.ink,
        surface = t.background,
        onSurface = t.ink,
        surfaceVariant = t.surfaceMuted,
        onSurfaceVariant = t.inkSecondary,
        surfaceTint = Color.Transparent,
        surfaceContainerLowest = t.surface,
        surfaceContainerLow = t.surface,
        surfaceContainer = t.surface,
        surfaceContainerHigh = t.surface,
        surfaceContainerHighest = t.surfaceMuted,
        inverseSurface = t.ink,
        inverseOnSurface = t.background,
        outline = t.outlineStrong,
        outlineVariant = t.outline,
        error = t.error,
        onError = t.surface,
        errorContainer = t.errorContainer,
        onErrorContainer = t.ink,
        scrim = t.scrim,
    )
}

/** Elegant serif for brand moments and greetings; a clean sans-serif for everything people read. */
val BrandSerif: FontFamily = FontFamily.Serif
private val sans = TextStyle(fontFamily = FontFamily.SansSerif, color = Color.Unspecified)
private val serif = TextStyle(fontFamily = BrandSerif, color = Color.Unspecified)

val DashTypography = Typography(
    displaySmall = serif.copy(fontSize = 34.sp, lineHeight = 42.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.2).sp),
    headlineLarge = serif.copy(fontSize = 30.sp, lineHeight = 38.sp, fontWeight = FontWeight.Normal, letterSpacing = (-0.2).sp),
    headlineMedium = serif.copy(fontSize = 26.sp, lineHeight = 33.sp, fontWeight = FontWeight.Normal),
    headlineSmall = sans.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = sans.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = sans.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    titleSmall = sans.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = sans.copy(fontSize = 16.sp, lineHeight = 25.sp),
    bodyMedium = sans.copy(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = sans.copy(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = sans.copy(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    labelMedium = sans.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.2.sp),
    labelSmall = sans.copy(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.4.sp),
)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(24.dp),
)

@Composable
fun DashAiTheme(preference: ThemePreference = ThemePreference.SYSTEM, content: @Composable () -> Unit) {
    val dark = when (preference) {
        ThemePreference.SYSTEM -> isSystemInDarkTheme()
        ThemePreference.LIGHT -> false
        ThemePreference.DARK -> true
    }
    val tokens = if (dark) DarkTokens else LightTokens
    CompositionLocalProvider(LocalDashColors provides tokens) {
        MaterialTheme(colorScheme = scheme(tokens), typography = DashTypography, shapes = shapes, content = content)
    }
}
