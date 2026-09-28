package com.dashworldng.ai.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Dash World palette: deep black, metallic gold, white primary text, calm grey secondary text. */
object DashColors {
    val Black = Color(0xFF0A0A0B)
    val Surface = Color(0xFF121214)
    val SurfaceHigh = Color(0xFF1A1A1E)
    val SurfaceHighest = Color(0xFF232328)
    val Outline = Color(0xFF34343B)
    val OutlineSoft = Color(0xFF26262C)
    val Gold = Color(0xFFD4AF37)
    val GoldLight = Color(0xFFF3D98A)
    val GoldDeep = Color(0xFF9C7A1F)
    val GoldContainer = Color(0xFF2E2612)
    val White = Color(0xFFF7F7F5)
    /** Secondary text: ~7.8:1 contrast on Black. */
    val Grey = Color(0xFFA1A1A8)
    val GreyDim = Color(0xFF7A7A82)
    val Error = Color(0xFFFF7A70)
    val ErrorContainer = Color(0xFF3A1614)
    val Success = Color(0xFF6BD49A)
    val CodeBackground = Color(0xFF0F0F12)

    val GoldGradient: Brush = Brush.linearGradient(listOf(GoldLight, Gold, GoldDeep))
}

private val colorScheme = darkColorScheme(
    primary = DashColors.Gold,
    onPrimary = DashColors.Black,
    primaryContainer = DashColors.GoldContainer,
    onPrimaryContainer = DashColors.GoldLight,
    secondary = DashColors.GoldLight,
    onSecondary = DashColors.Black,
    secondaryContainer = DashColors.SurfaceHighest,
    onSecondaryContainer = DashColors.White,
    tertiary = DashColors.GoldLight,
    background = DashColors.Black,
    onBackground = DashColors.White,
    surface = DashColors.Black,
    onSurface = DashColors.White,
    surfaceVariant = DashColors.SurfaceHigh,
    onSurfaceVariant = DashColors.Grey,
    surfaceContainerLowest = DashColors.Black,
    surfaceContainerLow = DashColors.Surface,
    surfaceContainer = DashColors.Surface,
    surfaceContainerHigh = DashColors.SurfaceHigh,
    surfaceContainerHighest = DashColors.SurfaceHighest,
    inverseSurface = DashColors.White,
    inverseOnSurface = DashColors.Black,
    outline = DashColors.Outline,
    outlineVariant = DashColors.OutlineSoft,
    error = DashColors.Error,
    onError = DashColors.Black,
    errorContainer = DashColors.ErrorContainer,
    onErrorContainer = DashColors.White,
)

private val base = TextStyle(fontFamily = FontFamily.SansSerif, color = Color.Unspecified)

private val typography = Typography(
    displaySmall = base.copy(fontSize = 34.sp, lineHeight = 40.sp, fontWeight = FontWeight.Light, letterSpacing = 0.5.sp),
    headlineMedium = base.copy(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Normal),
    headlineSmall = base.copy(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Medium),
    titleLarge = base.copy(fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium),
    titleMedium = base.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.1.sp),
    titleSmall = base.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = base.copy(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = base.copy(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = base.copy(fontSize = 12.sp, lineHeight = 17.sp),
    labelLarge = base.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 0.2.sp),
    labelMedium = base.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.3.sp),
    labelSmall = base.copy(fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.5.sp),
)

private val shapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun DashAiTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colorScheme, typography = typography, shapes = shapes, content = content)
}
