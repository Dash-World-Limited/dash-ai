package com.dashworldng.ai.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing

/**
 * The composer: text, attachments and the assistant mode (DASH AI decides how to answer). Every control does
 * something real; there is no microphone because the app has no voice input.
 */
@Composable
fun Composer(
    state: ChatUiState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    onOpenModes: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = DashTheme.colors
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = Radii.xl,
        color = c.surface,
        border = BorderStroke(1.dp, c.outline),
        shadowElevation = if (c.isDark) 0.dp else 2.dp,
    ) {
        Column(Modifier.padding(start = Spacing.sm, end = Spacing.sm, top = Spacing.sm, bottom = Spacing.xs)) {
            if (state.attachments.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = Spacing.xs, vertical = Spacing.xs),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    state.attachments.forEach { AttachmentChip(it, onRemove = { onRemoveAttachment(it.localId) }) }
                }
            }
            Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = Spacing.md, vertical = Spacing.sm)) {
                if (state.composer.isEmpty()) {
                    Text(state.mode.composerHint, style = MaterialTheme.typography.bodyLarge, color = c.inkTertiary)
                }
                BasicTextField(
                    value = state.composer,
                    onValueChange = onTextChange,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.ink),
                    cursorBrush = SolidColor(c.accentInk),
                    maxLines = 8,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier
                        .fillMaxWidth()
                        .semantics { contentDescription = "Message DASH AI" }
                        .testTag("composer_input"),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onAttach, enabled = !state.isGenerating, modifier = Modifier.testTag("attach_button")) {
                    Icon(Icons.Rounded.Add, contentDescription = "Add a document", tint = c.inkSecondary)
                }
                Row(
                    Modifier.weight(1f).horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    ComposerChip(
                        label = state.mode.label,
                        description = "Mode: ${state.mode.label}. Change mode",
                        onClick = onOpenModes,
                        enabled = !state.isGenerating,
                        modifier = Modifier.testTag("mode_selector"),
                    )
                }
                Spacer(Modifier.width(Spacing.xs))
                if (state.isGenerating) {
                    FilledIconButton(
                        onClick = onStop,
                        modifier = Modifier.size(Sizing.minTouch).testTag("stop_button"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = c.ink, contentColor = c.surface),
                    ) { Icon(Icons.Rounded.Stop, contentDescription = "Stop generating") }
                } else {
                    FilledIconButton(
                        onClick = onSend,
                        enabled = state.canSend,
                        modifier = Modifier.size(Sizing.minTouch).testTag("send_button"),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = c.accent,
                            contentColor = c.onAccent,
                            disabledContainerColor = c.surfaceMuted,
                            disabledContentColor = c.inkTertiary,
                        ),
                    ) { Icon(Icons.Rounded.ArrowUpward, contentDescription = "Send message") }
                }
            }
            Text(
                state.recipientLabel,
                style = MaterialTheme.typography.labelSmall,
                color = c.inkTertiary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = Spacing.md, bottom = Spacing.xs).testTag("recipient_label"),
            )
        }
    }
}

@Composable
private fun ComposerChip(
    label: String,
    description: String,
    onClick: () -> Unit,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    labelModifier: Modifier = Modifier,
    accent: Boolean = false,
) {
    val c = DashTheme.colors
    Row(
        modifier
            .heightIn(min = Sizing.minTouch)
            .clip(Radii.pill)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = description, onClick = onClick)
            .semantics { contentDescription = description },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .clip(Radii.pill)
                .background(if (accent) c.accentContainer else c.surfaceMuted)
                .border(1.dp, if (accent) c.accent else c.outline, Radii.pill)
                .padding(start = Spacing.md, end = Spacing.sm, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = if (enabled) c.ink else c.inkTertiary, modifier = labelModifier)
            Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = null, tint = c.inkTertiary, modifier = Modifier.size(Sizing.iconSmall))
        }
    }
}

@Composable
private fun AttachmentChip(attachment: PendingAttachment, onRemove: () -> Unit) {
    val c = DashTheme.colors
    val failed = attachment.error != null
    Surface(
        shape = Radii.md,
        color = if (failed) c.errorContainer else c.surfaceMuted,
        border = BorderStroke(1.dp, if (failed) c.error.copy(alpha = 0.4f) else c.outline),
        modifier = Modifier.widthIn(max = 260.dp).testTag("attachment_chip"),
    ) {
        Row(Modifier.padding(start = Spacing.md), verticalAlignment = Alignment.CenterVertically) {
            when {
                attachment.uploading -> CircularProgressIndicator(
                    progress = { attachment.progress },
                    modifier = Modifier.size(Sizing.iconSmall),
                    strokeWidth = 2.dp,
                    color = c.accent,
                    trackColor = c.outline,
                )
                failed -> Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = c.error, modifier = Modifier.size(Sizing.iconSmall))
                else -> Icon(Icons.Rounded.Description, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(Sizing.iconSmall))
            }
            Spacer(Modifier.width(Spacing.sm))
            Column(Modifier.weight(1f, fill = false).padding(vertical = 6.dp)) {
                Text(attachment.name, style = MaterialTheme.typography.labelMedium, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    attachment.error ?: if (attachment.uploading) "Uploading ${(attachment.progress * 100).toInt()}%" else FileRules.formatSize(attachment.sizeBytes),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) c.error else c.inkSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Rounded.Close, contentDescription = "Remove ${attachment.name}", tint = c.inkSecondary, modifier = Modifier.size(Sizing.iconSmall))
            }
        }
    }
}

/** A small dot used in sheets to mark the current selection. */
@Composable
internal fun SelectionDot(selected: Boolean) {
    val c = DashTheme.colors
    Box(
        Modifier.size(22.dp).clip(CircleShape).border(1.5.dp, if (selected) c.accentInk else c.fieldOutline, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        if (selected) Box(Modifier.size(12.dp).clip(CircleShape).background(c.accentInk))
    }
}
