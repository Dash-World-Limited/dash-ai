package com.dashworldng.ai.ui.chat

import android.content.Context
import android.content.Intent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Build
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ExpandLess
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.core.presentation.RecoveryAction
import com.dashworldng.ai.core.presentation.RecoveryCard
import com.dashworldng.ai.core.presentation.ToolLabels
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.SecondaryButton
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.markdown.MarkdownView
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing

/** What a message row needs besides the message itself. */
class MessageActions(
    val onRegenerate: (String) -> Unit,
    val onRetryOther: (String) -> Unit,
    val onEdit: (ChatMessage) -> Unit,
    val onNotice: (String) -> Unit,
    val onRetryAnswer: (String) -> Unit,
    val onChangeProvider: (String, List<ProviderId>) -> Unit,
    val onContinueLater: (String) -> Unit,
)

/** Per-answer extras from the session: tool activity and recovery. Read lazily by each row. */
class AnswerExtras(
    val tools: (String) -> List<ToolUse>,
    val recovery: (ChatMessage) -> RecoveryCard?,
    val pluginNames: Map<String, String>,
    val reducedMotion: Boolean,
)

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, "Share response").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

/** The user's message: a quiet bubble on the right. */
@Composable
fun UserMessage(message: ChatMessage, generating: Boolean, actions: MessageActions) {
    val c = DashTheme.colors
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Surface(
            shape = Radii.userBubble,
            color = c.surfaceMuted,
            modifier = Modifier.widthIn(max = 520.dp).padding(start = Spacing.xxxl).testTag("user_message"),
        ) {
            Column(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.md)) {
                message.attachments.forEach { a ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = Spacing.sm)) {
                        Icon(Icons.Rounded.Description, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(Sizing.iconSmall))
                        Spacer(Modifier.width(6.dp))
                        Text("${a.name} · ${FileRules.formatSize(a.sizeBytes)}", style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
                    }
                }
                Text(message.content, style = MaterialTheme.typography.bodyLarge, color = c.ink)
            }
        }
        Row {
            IconButton(onClick = {
                clipboard.setText(AnnotatedString(message.content))
                actions.onNotice("Message copied")
            }) {
                Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy message", tint = c.inkTertiary, modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = { actions.onEdit(message) }, enabled = !generating) {
                Icon(Icons.Rounded.Edit, contentDescription = "Edit and resend", tint = c.inkTertiary, modifier = Modifier.size(18.dp))
            }
        }
    }
}

/** The assistant's answer: open reading space, no bubble. */
@Composable
fun AssistantMessage(message: ChatMessage, generating: Boolean, actions: MessageActions, extras: AnswerExtras, compact: Boolean = false) {
    val c = DashTheme.colors
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val recovery = extras.recovery(message)
    Column(Modifier.fillMaxWidth().testTag("assistant_message"), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        SourceLabel(message)
        val tools = extras.tools(message.id)
        if (tools.isNotEmpty()) ToolActivity(tools, extras.pluginNames)
        if (message.content.isEmpty() && message.status == MessageStatus.STREAMING) {
            WorkingIndicator(extras.reducedMotion, usingTools = tools.any { it.running })
        } else if (message.content.isNotEmpty()) {
            MarkdownView(
                markdown = message.content,
                textStyle = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                onCopied = actions.onNotice,
            )
        }
        if (recovery != null) {
            RecoveryCardView(message, recovery, generating, actions)
        } else {
            StatusLine(message)
        }
        if (message.status != MessageStatus.STREAMING && recovery == null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (message.content.isNotEmpty()) {
                    IconButton(onClick = {
                        clipboard.setText(AnnotatedString(message.content))
                        actions.onNotice("Response copied")
                    }) {
                        Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy response", tint = c.inkTertiary, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = { shareText(context, message.content) }) {
                        Icon(Icons.Rounded.Share, contentDescription = "Share response", tint = c.inkTertiary, modifier = Modifier.size(18.dp))
                    }
                }
                IconButton(onClick = { actions.onRegenerate(message.id) }, enabled = !generating) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Regenerate response", tint = c.inkTertiary, modifier = Modifier.size(18.dp))
                }
                val other = message.provider?.other
                if (other != null && message.compareGroupId == null && !compact) {
                    TextAction("Try ${other.displayName}", onClick = { actions.onRetryOther(message.id) }, enabled = !generating)
                }
            }
        }
    }
}

@Composable
private fun SourceLabel(message: ChatMessage) {
    val c = DashTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            message.sourceLabel ?: "DASH AI",
            style = MaterialTheme.typography.labelMedium,
            color = c.inkTertiary,
            modifier = Modifier.testTag("model_label"),
        )
        if (message.isDemo) {
            Spacer(Modifier.width(Spacing.sm))
            DemoBadge()
        }
    }
}

@Composable
private fun StatusLine(message: ChatMessage) {
    val c = DashTheme.colors
    val text = when {
        message.status == MessageStatus.STOPPED -> "Stopped"
        message.status == MessageStatus.FAILED -> message.errorMessage ?: "This answer was not completed."
        message.finishReason == FinishReason.LENGTH -> "The answer reached the length limit and may be cut off."
        message.finishReason == FinishReason.REFUSAL -> "The provider declined part of this request."
        else -> null
    } ?: return
    Text(text, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary, modifier = Modifier.testTag("message_status"))
}

/** "Provider temporarily unavailable" with Retry / Change provider / Continue later. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RecoveryCardView(message: ChatMessage, card: RecoveryCard, generating: Boolean, actions: MessageActions) {
    val c = DashTheme.colors
    Surface(
        shape = Radii.lg,
        color = c.surface,
        border = BorderStroke(1.dp, c.outline),
        modifier = Modifier.fillMaxWidth().testTag("recovery_card").semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Column(Modifier.padding(Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Text(card.title, style = MaterialTheme.typography.titleSmall, color = c.ink, modifier = Modifier.testTag("message_status"))
            Text(card.message, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
            card.attemptsNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary) }
            Text(
                "DASH AI never switches provider on its own.",
                style = MaterialTheme.typography.bodySmall,
                color = c.inkTertiary,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm), modifier = Modifier.padding(top = Spacing.xs)) {
                card.actions.forEach { action ->
                    when (action) {
                        RecoveryAction.RETRY -> PrimaryButton(
                            "Retry",
                            onClick = { actions.onRetryAnswer(message.id) },
                            enabled = !generating,
                            icon = Icons.Rounded.Refresh,
                            modifier = Modifier.testTag("recovery_retry"),
                        )
                        RecoveryAction.CHANGE_PROVIDER -> SecondaryButton(
                            "Change provider",
                            onClick = { actions.onChangeProvider(message.id, card.alternatives) },
                            enabled = !generating,
                            icon = Icons.Rounded.SwapHoriz,
                            modifier = Modifier.testTag("recovery_change_provider"),
                        )
                        RecoveryAction.CONTINUE_LATER -> TextAction(
                            "Continue later",
                            onClick = { actions.onContinueLater(message.id) },
                            modifier = Modifier.testTag("recovery_later"),
                        )
                    }
                }
            }
        }
    }
}

/**
 * Compact, expandable tool activity: "Used Text stats". Only names and outcomes; the server never
 * sends tool arguments or results to the app, so they cannot be shown.
 */
@Composable
fun ToolActivity(uses: List<ToolUse>, pluginNames: Map<String, String>) {
    val c = DashTheme.colors
    var expanded by rememberSaveable(uses.firstOrNull()?.callId) { mutableStateOf(false) }
    val summary = ToolLabels.summary(uses)
    Column(
        Modifier
            .clip(Radii.md)
            .background(c.surfaceMuted)
            .testTag("tool_activity"),
    ) {
        Row(
            Modifier
                .heightIn(min = 40.dp)
                .clickable(role = Role.Button, onClickLabel = if (expanded) "Hide tool details" else "Show tool details") { expanded = !expanded }
                .padding(horizontal = Spacing.md)
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.Build, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(Spacing.sm))
            Text(summary, style = MaterialTheme.typography.labelMedium, color = c.inkSecondary)
            Spacer(Modifier.width(Spacing.xs))
            Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, contentDescription = null, tint = c.inkTertiary, modifier = Modifier.size(Sizing.iconSmall))
        }
        AnimatedVisibility(expanded) {
            Column(Modifier.padding(start = Spacing.md, end = Spacing.md, bottom = Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                uses.forEach { use ->
                    val label = ToolLabels.label(use, pluginNames)
                    val (ink, _) = DashTheme.toneColor(c, label.tone)
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.semantics(mergeDescendants = true) {}) {
                        androidx.compose.foundation.layout.Box(Modifier.size(6.dp).clip(Radii.pill).background(ink))
                        Spacer(Modifier.width(Spacing.sm))
                        Column {
                            Text(label.title, style = MaterialTheme.typography.labelMedium, color = c.ink)
                            Text(label.detail, style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
                        }
                    }
                }
            }
        }
    }
}

/** Shown while an answer has not produced text yet. Static when animations are off. */
@Composable
fun WorkingIndicator(reducedMotion: Boolean, usingTools: Boolean = false) {
    val c = DashTheme.colors
    val label = if (usingTools) "Using tools…" else "Working…"
    val alpha = if (reducedMotion) {
        1f
    } else {
        val transition = rememberInfiniteTransition(label = "working")
        val a by transition.animateFloat(0.35f, 1f, infiniteRepeatable(tween(800), RepeatMode.Reverse), label = "workingAlpha")
        a
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.testTag("typing_indicator").semantics { contentDescription = "DASH AI is working on an answer" },
    ) {
        repeat(3) {
            androidx.compose.foundation.layout.Box(Modifier.padding(end = 4.dp).size(6.dp).alpha(alpha).clip(Radii.pill).background(c.accent))
        }
        Spacer(Modifier.width(Spacing.sm))
        Text(label, style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
    }
}

/** Both Compare answers, each labelled with its provider: side by side when wide, stacked on phones. */
@Composable
fun CompareRow(answers: List<ChatMessage>, generating: Boolean, actions: MessageActions, extras: AnswerExtras) {
    val c = DashTheme.colors
    Column(Modifier.fillMaxWidth().testTag("compare_row"), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Text("Compare · same question, two providers", style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val wide = maxWidth >= 600.dp
            val card: @Composable (ChatMessage, Modifier) -> Unit = { answer, modifier ->
                Surface(modifier = modifier, shape = Radii.lg, color = c.surface, border = BorderStroke(1.dp, c.outline)) {
                    Column(Modifier.padding(Spacing.md)) { AssistantMessage(answer, generating, actions, extras, compact = true) }
                }
            }
            if (wide) {
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) { answers.forEach { card(it, Modifier.weight(1f)) } }
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) { answers.forEach { card(it, Modifier.fillMaxWidth()) } }
            }
        }
    }
}
