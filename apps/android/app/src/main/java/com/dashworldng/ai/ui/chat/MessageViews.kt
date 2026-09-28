package com.dashworldng.ai.ui.chat

import android.content.Context
import android.content.Intent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material.icons.rounded.SwapHoriz
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.FinishReason
import com.dashworldng.ai.core.model.MessageStatus
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.markdown.MarkdownView
import com.dashworldng.ai.ui.theme.DashColors

/** Callbacks for the actions available on a message. */
class MessageActions(
    val onRegenerate: (String) -> Unit,
    val onRetryOther: (String) -> Unit,
    val onEdit: (ChatMessage) -> Unit,
    val onNotice: (String) -> Unit,
)

fun shareText(context: Context, text: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    context.startActivity(Intent.createChooser(send, "Share response").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

@Composable
fun UserMessage(message: ChatMessage, generating: Boolean, actions: MessageActions) {
    val clipboard = LocalClipboardManager.current
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
        Surface(
            shape = RoundedCornerShape(topStart = 18.dp, topEnd = 6.dp, bottomStart = 18.dp, bottomEnd = 18.dp),
            color = DashColors.SurfaceHighest,
            modifier = Modifier.widthIn(max = 320.dp).testTag("user_message"),
        ) {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 10.dp)) {
                message.attachments.forEach { a ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 6.dp)) {
                        Icon(Icons.Rounded.Description, contentDescription = null, tint = DashColors.Gold, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("${a.name} · ${FileRules.formatSize(a.sizeBytes)}", style = MaterialTheme.typography.labelMedium, color = DashColors.GoldLight)
                    }
                }
                Text(message.content, style = MaterialTheme.typography.bodyLarge, color = DashColors.White)
            }
        }
        Row {
            IconButton(onClick = {
                clipboard.setText(AnnotatedString(message.content))
                actions.onNotice("Message copied")
            }) {
                Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy message", tint = DashColors.GreyDim, modifier = Modifier.size(18.dp))
            }
            IconButton(onClick = { actions.onEdit(message) }, enabled = !generating) {
                Icon(Icons.Rounded.Edit, contentDescription = "Edit and resend", tint = DashColors.GreyDim, modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
fun AssistantMessage(message: ChatMessage, generating: Boolean, actions: MessageActions, compact: Boolean = false) {
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().testTag("assistant_message"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SourceLabel(message)
        if (message.content.isEmpty() && message.status == MessageStatus.STREAMING) {
            TypingIndicator()
        } else if (message.content.isNotEmpty()) {
            MarkdownView(
                markdown = message.content,
                textStyle = if (compact) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.bodyLarge,
                onCopied = actions.onNotice,
            )
        }
        StatusLine(message, actions, generating)
        if (message.status != MessageStatus.STREAMING) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (message.content.isNotEmpty()) {
                    IconButton(onClick = {
                        clipboard.setText(AnnotatedString(message.content))
                        actions.onNotice("Response copied")
                    }) {
                        Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy response", tint = DashColors.Grey, modifier = Modifier.size(18.dp))
                    }
                    IconButton(onClick = { shareText(context, message.content) }) {
                        Icon(Icons.Rounded.Share, contentDescription = "Share response", tint = DashColors.Grey, modifier = Modifier.size(18.dp))
                    }
                }
                IconButton(onClick = { actions.onRegenerate(message.id) }, enabled = !generating) {
                    Icon(Icons.Rounded.Refresh, contentDescription = "Regenerate response", tint = DashColors.Grey, modifier = Modifier.size(18.dp))
                }
                val other = message.provider?.other
                if (other != null && message.compareGroupId == null) {
                    TextButton(onClick = { actions.onRetryOther(message.id) }, enabled = !generating) {
                        Icon(Icons.Rounded.SwapHoriz, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(4.dp))
                        Text("Try ${other.displayName}", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun SourceLabel(message: ChatMessage) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(
            message.sourceLabel ?: "Dash AI",
            style = MaterialTheme.typography.labelMedium,
            color = DashColors.Gold,
            modifier = Modifier.testTag("model_label"),
        )
        if (message.isDemo) {
            Spacer(Modifier.width(8.dp))
            DemoBadge()
        }
    }
}

@Composable
private fun StatusLine(message: ChatMessage, actions: MessageActions, generating: Boolean) {
    val text = when {
        message.status == MessageStatus.STREAMING -> "Generating…"
        message.status == MessageStatus.STOPPED -> "Stopped"
        message.status == MessageStatus.FAILED -> message.errorMessage ?: "This response failed."
        message.finishReason == FinishReason.LENGTH -> "The answer reached the length limit and may be cut off."
        message.finishReason == FinishReason.REFUSAL -> "The provider declined part of this request."
        else -> null
    } ?: return
    val failed = message.status == MessageStatus.FAILED
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (failed) {
            Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = DashColors.Error, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
        }
        Text(
            text,
            style = MaterialTheme.typography.bodySmall,
            color = if (failed) DashColors.Error else DashColors.GreyDim,
            modifier = Modifier.weight(1f, fill = false).testTag("message_status"),
        )
        if (failed && message.errorRetryable) {
            TextButton(onClick = { actions.onRegenerate(message.id) }, enabled = !generating) {
                Text("Retry", color = DashColors.Gold)
            }
        }
    }
}

@Composable
fun TypingIndicator() {
    val transition = rememberInfiniteTransition(label = "typing")
    val alpha by transition.animateFloat(
        initialValue = 0.3f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "typingAlpha",
    )
    Text("●  ●  ●", color = DashColors.Gold, modifier = Modifier.alpha(alpha).testTag("typing_indicator"), style = MaterialTheme.typography.labelSmall)
}

/** Both Compare answers side by side, each clearly labelled with its provider. */
@Composable
fun CompareRow(answers: List<ChatMessage>, generating: Boolean, actions: MessageActions) {
    Column(Modifier.fillMaxWidth().testTag("compare_row"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Compare · same prompt, two providers", style = MaterialTheme.typography.labelMedium, color = DashColors.Grey)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            answers.forEach { answer ->
                Surface(
                    modifier = Modifier.weight(1f),
                    shape = RoundedCornerShape(14.dp),
                    color = DashColors.Surface,
                    border = BorderStroke(1.dp, DashColors.OutlineSoft),
                ) {
                    Column(Modifier.padding(10.dp)) {
                        AssistantMessage(answer, generating, actions, compact = true)
                    }
                }
            }
        }
    }
}
