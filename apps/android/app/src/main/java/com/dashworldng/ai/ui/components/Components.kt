package com.dashworldng.ai.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashworldng.ai.ui.theme.DashColors

/**
 * Temporary typographic Dash AI wordmark. The official Dash World logo is not in this repository;
 * replace this with the approved asset when it is supplied (see docs/design.md).
 */
@OptIn(ExperimentalTextApi::class)
@Composable
fun DashWordmark(modifier: Modifier = Modifier, size: Dp = 28.dp) {
    val fontSize = (size.value).sp
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(
            text = "DASH",
            style = TextStyle(
                brush = DashColors.GoldGradient,
                fontSize = fontSize,
                fontWeight = FontWeight.SemiBold,
                letterSpacing = (size.value * 0.18f).sp,
            ),
        )
        Spacer(Modifier.width(size * 0.3f))
        Text(
            text = "AI",
            style = TextStyle(
                color = DashColors.White,
                fontSize = fontSize,
                fontWeight = FontWeight.Light,
                letterSpacing = (size.value * 0.12f).sp,
            ),
        )
    }
}

@Composable
fun GoldButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 52.dp),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = DashColors.Gold,
            contentColor = DashColors.Black,
            disabledContainerColor = DashColors.SurfaceHighest,
            disabledContentColor = DashColors.GreyDim,
        ),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 14.dp),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun QuietButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = 52.dp),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, DashColors.Outline),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = DashColors.White),
    ) {
        Text(text, style = MaterialTheme.typography.labelLarge)
    }
}

/** Marks simulated content everywhere it appears. */
@Composable
fun DemoBadge(modifier: Modifier = Modifier, text: String = "DEMO") {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(6.dp),
        color = DashColors.GoldContainer,
        border = BorderStroke(1.dp, DashColors.GoldDeep),
    ) {
        Text(
            text,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            color = DashColors.GoldLight,
        )
    }
}

enum class BannerTone { INFO, WARNING, ERROR }

@Composable
fun Banner(
    text: String,
    modifier: Modifier = Modifier,
    tone: BannerTone = BannerTone.INFO,
    icon: ImageVector? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
) {
    val (container, border, content) = when (tone) {
        BannerTone.INFO -> Triple(DashColors.Surface, DashColors.OutlineSoft, DashColors.Grey)
        BannerTone.WARNING -> Triple(DashColors.GoldContainer, DashColors.GoldDeep, DashColors.GoldLight)
        BannerTone.ERROR -> Triple(DashColors.ErrorContainer, DashColors.Error.copy(alpha = 0.5f), DashColors.White)
    }
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = container,
        border = BorderStroke(1.dp, border),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 6.dp, bottom = 6.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            if (icon != null) {
                Icon(icon, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
            }
            Text(text, style = MaterialTheme.typography.bodySmall, color = content, modifier = Modifier.weight(1f).padding(vertical = 6.dp))
            if (actionLabel != null && onAction != null) {
                androidx.compose.material3.TextButton(onClick = onAction) {
                    Text(actionLabel, color = DashColors.Gold, style = MaterialTheme.typography.labelMedium)
                }
            }
            if (onDismiss != null) {
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Rounded.Close, contentDescription = "Dismiss", tint = content, modifier = Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        modifier = modifier.padding(top = 20.dp, bottom = 8.dp),
        style = MaterialTheme.typography.labelMedium,
        color = DashColors.Gold,
    )
}

@Composable
fun EmptyState(title: String, body: String, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    Column(
        modifier = modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (icon != null) {
            Box(
                Modifier.size(56.dp).background(DashColors.SurfaceHigh, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(icon, contentDescription = null, tint = DashColors.Gold)
            }
        }
        Text(title, style = MaterialTheme.typography.titleMedium, color = DashColors.White)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = DashColors.Grey)
    }
}

@Composable
fun Dot(color: Color, modifier: Modifier = Modifier, size: Dp = 8.dp) {
    Box(modifier.size(size).background(color, CircleShape))
}
