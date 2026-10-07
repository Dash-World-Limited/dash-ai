package com.dashworldng.ai.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashworldng.ai.core.presentation.StatusLabel
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.ui.brand.DashBrand
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing

// ---- Brand -------------------------------------------------------------------------------------

/**
 * The DASH AI mark, drawn from [DashBrand.MARK_PATH] (the same geometry as the launcher and splash
 * icons) and scaled to fit [size]. Replace the mark in DashBrand, not here.
 */
@Composable
fun BrandMark(size: Dp, modifier: Modifier = Modifier, luminous: Boolean = false) {
    val c = DashTheme.colors
    // Luminous: lit champagne for the dark brand canvas (splash). Otherwise the theme's accent, which
    // keeps contrast on light surfaces.
    val gold = if (luminous) {
        Brush.linearGradient(
            listOf(Color(0xFFFBF6EA), Color(0xFFF4ECD9), Color(0xFFDCC07F), Color(0xFFC9A75B), Color(0xFF7A5C1C)),
            // In the mark's own 108-unit coordinates: light from the upper left, deepening below.
            start = Offset(38f, 24f),
            end = Offset(70f, 84f),
        )
    } else {
        Brush.linearGradient(listOf(c.accent, c.accentInk))
    }
    val mark = remember { PathParser().parsePathString(DashBrand.MARK_PATH).toPath().apply { fillType = PathFillType.EvenOdd } }
    Canvas(modifier.size(size).semantics { contentDescription = DashBrand.NAME }) {
        val (left, top, right, bottom) = DashBrand.MARK_BOUNDS
        val width = right - left
        val height = bottom - top
        val factor = this.size.minDimension / (maxOf(width, height) + 8f)
        translate(left = (this.size.width - width * factor) / 2f, top = (this.size.height - height * factor) / 2f) {
            scale(factor, pivot = Offset.Zero) {
                translate(left = -left, top = -top) { drawPath(mark, gold) }
            }
        }
    }
}

/** "DASH AI" set in spaced capitals; "AI" carries the gold accent. */
@Composable
fun BrandWordmark(modifier: Modifier = Modifier, fontSize: TextUnit = 15.sp, onDark: Boolean = false) {
    val c = DashTheme.colors
    val ink = if (onDark) c.brandInk else c.ink
    Text(
        buildAnnotatedString {
            withStyle(SpanStyle(color = ink, fontWeight = FontWeight.SemiBold)) { append(DashBrand.WORDMARK_PRIMARY) }
            withStyle(SpanStyle(color = if (onDark) c.accent else c.accentInk, fontWeight = FontWeight.Medium)) { append(" ${DashBrand.WORDMARK_ACCENT}") }
        },
        modifier = modifier.semantics { contentDescription = DashBrand.NAME },
        fontSize = fontSize,
        letterSpacing = (fontSize.value * 0.22f).sp,
        maxLines = 1,
    )
}

/** Initials in a soft circle; used for the account entry point. */
@Composable
fun Avatar(initials: String?, contentDescription: String, onClick: (() -> Unit)?, modifier: Modifier = Modifier) {
    val c = DashTheme.colors
    Box(
        modifier
            .size(Sizing.minTouch)
            .clip(CircleShape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = contentDescription, onClick = onClick) else Modifier)
            .semantics { this.contentDescription = contentDescription },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(Sizing.avatar).clip(CircleShape).background(c.accentContainer).border(1.dp, c.outline, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (initials != null) {
                Text(initials, style = MaterialTheme.typography.labelLarge, color = c.ink)
            } else {
                Icon(Icons.Rounded.Info, contentDescription = null, tint = c.inkSecondary, modifier = Modifier.size(Sizing.iconSmall))
            }
        }
    }
}

// ---- Buttons -----------------------------------------------------------------------------------

/** The one primary action on a screen: champagne gold, charcoal label. */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    icon: ImageVector? = null,
) {
    val c = DashTheme.colors
    androidx.compose.material3.Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier.heightIn(min = Sizing.buttonHeight),
        shape = Radii.pill,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.accent,
            contentColor = c.onAccent,
            disabledContainerColor = c.surfaceMuted,
            disabledContentColor = c.inkTertiary,
        ),
        contentPadding = PaddingValues(horizontal = Spacing.xl, vertical = Spacing.md),
        elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = c.inkSecondary)
            Spacer(Modifier.width(Spacing.sm))
        } else if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(Sizing.icon))
            Spacer(Modifier.width(Spacing.sm))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A secondary action: outlined, neutral. */
@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    destructive: Boolean = false,
) {
    val c = DashTheme.colors
    val ink = if (destructive) c.error else c.ink
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = Sizing.minTouch),
        shape = Radii.pill,
        border = BorderStroke(1.dp, if (enabled) c.outlineStrong else c.outline),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = ink, disabledContentColor = c.inkTertiary),
        contentPadding = PaddingValues(horizontal = Spacing.lg, vertical = Spacing.sm),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(Spacing.sm))
        }
        Text(text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A quiet text action. */
@Composable
fun TextAction(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, destructive: Boolean = false) {
    val c = DashTheme.colors
    TextButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.heightIn(min = Sizing.minTouch),
        colors = ButtonDefaults.textButtonColors(contentColor = if (destructive) c.error else c.accentInk),
    ) { Text(text, style = MaterialTheme.typography.labelLarge) }
}

// ---- Inputs ------------------------------------------------------------------------------------

@Composable
fun DashTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    error: String? = null,
    supporting: String? = null,
    singleLine: Boolean = true,
    enabled: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = DashTheme.colors
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.fillMaxWidth(),
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it, color = c.inkTertiary) } },
        isError = error != null,
        supportingText = (error ?: supporting)?.let { { Text(it) } },
        singleLine = singleLine,
        enabled = enabled,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        visualTransformation = visualTransformation,
        leadingIcon = leading,
        trailingIcon = trailing,
        shape = Radii.md,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = c.accentInk,
            unfocusedBorderColor = c.fieldOutline,
            focusedLabelColor = c.accentInk,
            unfocusedLabelColor = c.inkSecondary,
            cursorColor = c.accentInk,
            focusedContainerColor = c.surface,
            unfocusedContainerColor = c.surface,
            errorBorderColor = c.error,
            errorLabelColor = c.error,
            errorSupportingTextColor = c.error,
            focusedSupportingTextColor = c.inkSecondary,
            unfocusedSupportingTextColor = c.inkSecondary,
        ),
    )
}

// ---- Structure ---------------------------------------------------------------------------------

/** Centres content and caps its width so long lines stay readable on tablets and in landscape. */
@Composable
fun ContentWidth(modifier: Modifier = Modifier, maxWidth: Dp = Sizing.maxContentWidth, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) {
        Box(Modifier.widthIn(max = maxWidth).fillMaxWidth(), content = content)
    }
}

/** The standard top bar: back or menu on the left, a calm title, actions on the right. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashTopBar(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    navigationIcon: (@Composable () -> Unit)? = null,
    titleContent: (@Composable () -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val c = DashTheme.colors
    TopAppBar(
        modifier = modifier,
        title = {
            if (titleContent != null) {
                titleContent()
            } else {
                Column {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        color = c.ink,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.semantics { heading() },
                    )
                    if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, maxLines = 1)
                }
            }
        },
        navigationIcon = {
            when {
                navigationIcon != null -> navigationIcon()
                onBack != null -> IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back", tint = c.ink)
                }
            }
        },
        actions = actions,
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = c.background,
            scrolledContainerColor = c.background,
            titleContentColor = c.ink,
            navigationIconContentColor = c.ink,
            actionIconContentColor = c.ink,
        ),
    )
}

/** A subtle card: white (or raised charcoal) surface, hairline outline, generous radius. */
@Composable
fun QuietCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    selected: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(Spacing.lg),
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = DashTheme.colors
    val border = BorderStroke(1.dp, if (selected) c.accent else c.outline)
    val color = if (selected) c.accentContainer else c.surface
    if (onClick != null) {
        Surface(onClick = onClick, modifier = modifier, shape = Radii.lg, color = color, border = border) {
            Column(Modifier.padding(contentPadding), content = content)
        }
    } else {
        Surface(modifier = modifier, shape = Radii.lg, color = color, border = border) {
            Column(Modifier.padding(contentPadding), content = content)
        }
    }
}

@Composable
fun SectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = DashTheme.colors.inkTertiary,
        modifier = modifier.padding(top = Spacing.xl, bottom = Spacing.sm).semantics { heading() },
    )
}

/** A group of settings rows inside one card, separated by hairlines. */
@Composable
fun SettingsGroup(title: String?, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier) {
        if (title != null) SectionHeader(title)
        QuietCard(contentPadding = PaddingValues(0.dp), content = content)
    }
}

@Composable
fun SettingsDivider() {
    HorizontalDivider(Modifier.padding(start = Spacing.lg), color = DashTheme.colors.outline)
}

@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    icon: ImageVector? = null,
    onClick: (() -> Unit)? = null,
    destructive: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = DashTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = Spacing.lg, vertical = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = if (destructive) c.error else c.inkSecondary, modifier = Modifier.size(Sizing.icon))
            Spacer(Modifier.width(Spacing.lg))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = if (destructive) c.error else c.ink)
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
        }
        if (trailing != null) {
            Spacer(Modifier.width(Spacing.md))
            trailing()
        }
    }
}

// ---- Status ------------------------------------------------------------------------------------

@Composable
fun StatusBadge(label: StatusLabel, modifier: Modifier = Modifier) = StatusBadge(label.text, label.tone, modifier)

@Composable
fun StatusBadge(text: String, tone: StatusTone, modifier: Modifier = Modifier) {
    val (ink, fill) = DashTheme.toneColor(DashTheme.colors, tone)
    Row(
        modifier.clip(Radii.pill).background(fill).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).clip(CircleShape).background(ink))
        Spacer(Modifier.width(6.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = ink, maxLines = 1)
    }
}

/** Marks everything simulated in Demo Mode. */
@Composable
fun DemoBadge(modifier: Modifier = Modifier) {
    val c = DashTheme.colors
    Text(
        "DEMO",
        modifier = modifier
            .clip(Radii.pill)
            .border(1.dp, c.accent, Radii.pill)
            .padding(horizontal = 8.dp, vertical = 2.dp)
            .semantics { contentDescription = "Demo Mode: simulated by DASH AI, not a real answer" },
        style = MaterialTheme.typography.labelSmall,
        color = c.accentInk,
    )
}

/** An inline notice. Calm by default; warning and error tones for problems. */
@Composable
fun Notice(
    text: String,
    modifier: Modifier = Modifier,
    tone: StatusTone = StatusTone.NEUTRAL,
    title: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    onDismiss: (() -> Unit)? = null,
) {
    val c = DashTheme.colors
    val (ink, fill) = DashTheme.toneColor(c, tone)
    val icon = when (tone) {
        StatusTone.ERROR -> Icons.Rounded.ErrorOutline
        StatusTone.WARNING -> Icons.Rounded.WarningAmber
        else -> Icons.Rounded.Info
    }
    Row(
        modifier.fillMaxWidth().clip(Radii.md).background(fill).padding(start = Spacing.md, top = Spacing.sm, bottom = Spacing.sm, end = Spacing.xs),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = ink, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f).padding(vertical = Spacing.xs)) {
            if (title != null) Text(title, style = MaterialTheme.typography.titleSmall, color = c.ink)
            Text(text, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
        }
        if (actionLabel != null && onAction != null) TextAction(actionLabel, onAction)
        if (onDismiss != null) TextAction("Dismiss", onDismiss)
    }
}

// ---- Screen states -----------------------------------------------------------------------------

@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    message: String,
    modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null,
) {
    val c = DashTheme.colors
    Column(
        modifier.fillMaxWidth().padding(horizontal = Spacing.xl, vertical = Spacing.xxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        Box(Modifier.size(56.dp).clip(CircleShape).background(c.accentContainer), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(26.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, color = c.ink, textAlign = TextAlign.Center, modifier = Modifier.semantics { heading() })
        Text(message, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, textAlign = TextAlign.Center)
        if (action != null) {
            Spacer(Modifier.size(Spacing.xs))
            action()
        }
    }
}

@Composable
fun ErrorState(title: String, message: String, modifier: Modifier = Modifier, onRetry: (() -> Unit)? = null) {
    EmptyState(
        icon = Icons.Rounded.ErrorOutline,
        title = title,
        message = message,
        modifier = modifier,
        action = onRetry?.let { { SecondaryButton("Try again", it) } },
    )
}

@Composable
fun LoadingState(label: String, modifier: Modifier = Modifier) {
    val c = DashTheme.colors
    Column(
        modifier.fillMaxWidth().padding(vertical = Spacing.xxl).semantics(mergeDescendants = true) {},
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp, color = c.accent, trackColor = c.surfaceMuted)
        Text(label, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
    }
}

@Composable
fun ConfirmDialog(
    title: String,
    text: String,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    destructive: Boolean = false,
) {
    val c = DashTheme.colors
    AlertDialog(
        modifier = modifier,
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        titleContentColor = c.ink,
        textContentColor = c.inkSecondary,
        title = { Text(title) },
        text = { Text(text) },
        confirmButton = { TextAction(confirmLabel, onConfirm, destructive = destructive) },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = c.inkSecondary) } },
    )
}

/** Full-screen centred box with the screen background. */
@Composable
fun ScreenBackground(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.fillMaxSize().background(DashTheme.colors.background), content = content)
}
