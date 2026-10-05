package com.dashworldng.ai.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.presentation.ProviderOption
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Spacing

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DashSheet(onDismiss: () -> Unit, tag: String, content: @Composable () -> Unit) {
    val c = DashTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.surface,
        contentColor = c.ink,
        scrimColor = c.scrim,
        shape = Radii.sheet,
        modifier = Modifier.testTag(tag),
    ) {
        Column(Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = Spacing.lg)) { content() }
    }
}

@Composable
private fun SheetTitle(title: String, subtitle: String?) {
    val c = DashTheme.colors
    Column(Modifier.padding(horizontal = Spacing.xl).padding(bottom = Spacing.md)) {
        Text(title, style = MaterialTheme.typography.titleLarge, color = c.ink, modifier = Modifier.semantics { heading() })
        if (subtitle != null) {
            Spacer(Modifier.padding(top = Spacing.xs))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        }
    }
}

/** A selectable row: title, description, an optional note, and a selection mark. */
@Composable
private fun ChoiceRow(
    title: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    note: String? = null,
    badge: (@Composable () -> Unit)? = null,
) {
    val c = DashTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.md)
            .clip(Radii.lg)
            .clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 64.dp)
            .padding(horizontal = Spacing.md, vertical = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = if (enabled) c.ink else c.inkTertiary)
                if (badge != null) {
                    Spacer(Modifier.width(Spacing.sm))
                    badge()
                }
            }
            Text(description, style = MaterialTheme.typography.bodySmall, color = if (enabled) c.inkSecondary else c.inkTertiary)
            if (note != null) {
                Text(note, style = MaterialTheme.typography.labelSmall, color = if (enabled) c.inkTertiary else c.warning, modifier = Modifier.padding(top = 2.dp))
            }
        }
        Spacer(Modifier.width(Spacing.md))
        SelectionDot(selected)
    }
}

/**
 * Provider selection: only the choices the app really supports. Dash Smart is DASH AI's automatic
 * routing (implemented on the server); unavailable providers are explained, not hidden.
 */
@Composable
fun ProviderSheet(
    options: List<ProviderOption>,
    demoMode: Boolean,
    onSelect: (ProviderOption) -> Unit,
    onDismiss: () -> Unit,
) {
    DashSheet(onDismiss, "provider_sheet") {
        SheetTitle("Choose a provider", "Applies to your next messages in this chat. Your choice is remembered.")
        options.forEach { option ->
            ChoiceRow(
                title = option.title,
                description = option.description,
                selected = option.selected,
                enabled = option.available,
                onClick = { onSelect(option) },
                note = option.unavailableReason ?: option.model?.let { "Model: $it" },
                badge = if (demoMode) ({ DemoBadge() }) else null,
                modifier = Modifier.testTag("model_option_${option.choice.wire}"),
            )
        }
    }
}

@Composable
fun ModeSheet(selected: AssistantMode, onSelect: (AssistantMode) -> Unit, onOpenTools: () -> Unit, onDismiss: () -> Unit) {
    val c = DashTheme.colors
    DashSheet(onDismiss, "mode_sheet") {
        SheetTitle("Mode", "Shapes how DASH AI answers. You can change it at any time.")
        AssistantMode.entries.forEach { mode ->
            ChoiceRow(
                title = mode.label,
                description = mode.tagline,
                selected = mode == selected,
                enabled = true,
                onClick = { onSelect(mode) },
                note = mode.limitation,
                modifier = Modifier.testTag("mode_${mode.wire}"),
            )
        }
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.md, vertical = Spacing.sm)
                .clip(Radii.lg)
                .clickable(role = Role.Button, onClick = onOpenTools)
                .heightIn(min = 56.dp)
                .padding(horizontal = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Tools & Connections", style = MaterialTheme.typography.titleSmall, color = c.ink)
                Text("Choose which tools DASH AI may use.", style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
            }
            Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, contentDescription = null, tint = c.inkTertiary)
        }
    }
}

/** "Change provider" after a failure: the user picks; nothing switches automatically. */
@Composable
fun AlternativeProviderSheet(alternatives: List<ProviderId>, onSelect: (ProviderId) -> Unit, onDismiss: () -> Unit) {
    DashSheet(onDismiss, "alternative_sheet") {
        SheetTitle("Answer with another provider", "The same question is sent again to the provider you choose.")
        alternatives.forEach { provider ->
            ChoiceRow(
                title = provider.displayName,
                description = "Every message in this chat goes to ${if (provider == ProviderId.ANTHROPIC) "Anthropic's Claude" else "OpenAI"} from now on.",
                selected = false,
                enabled = true,
                onClick = { onSelect(provider) },
                modifier = Modifier.testTag("alternative_${provider.wire}"),
            )
        }
    }
}
