package com.dashworldng.ai.ui.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AttachFile
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.ui.theme.DashColors

@Composable
fun Composer(
    state: ChatUiState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    onRemoveAttachment: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(color = DashColors.Surface, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 10.dp)) {
            if (state.attachments.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    state.attachments.forEach { AttachmentChip(it, onRemove = { onRemoveAttachment(it.localId) }) }
                }
            }
            Text(
                state.recipientLabel,
                style = MaterialTheme.typography.labelSmall,
                color = if (state.choice == ModelChoice.COMPARE && !state.demoMode) DashColors.GoldLight else DashColors.GreyDim,
                modifier = Modifier.padding(start = 4.dp, bottom = 6.dp).testTag("recipient_label"),
            )
            Row(verticalAlignment = Alignment.Bottom) {
                IconButton(onClick = onAttach, enabled = !state.isGenerating, modifier = Modifier.testTag("attach_button")) {
                    Icon(Icons.Rounded.AttachFile, contentDescription = "Attach a document", tint = DashColors.Grey)
                }
                OutlinedTextField(
                    value = state.composer,
                    onValueChange = onTextChange,
                    placeholder = { Text(state.mode.composerHint, color = DashColors.GreyDim) },
                    modifier = Modifier.weight(1f).testTag("composer_input"),
                    maxLines = 6,
                    shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = DashColors.GoldDeep,
                        unfocusedBorderColor = DashColors.Outline,
                        focusedContainerColor = DashColors.Black,
                        unfocusedContainerColor = DashColors.Black,
                        cursorColor = DashColors.Gold,
                    ),
                )
                Spacer(Modifier.width(8.dp))
                if (state.isGenerating) {
                    FilledIconButton(
                        onClick = onStop,
                        modifier = Modifier.size(52.dp).testTag("stop_button"),
                        colors = IconButtonDefaults.filledIconButtonColors(containerColor = DashColors.White, contentColor = DashColors.Black),
                    ) {
                        Icon(Icons.Rounded.Stop, contentDescription = "Stop generating")
                    }
                } else {
                    FilledIconButton(
                        onClick = onSend,
                        enabled = state.canSend,
                        modifier = Modifier.size(52.dp).testTag("send_button"),
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = DashColors.Gold,
                            contentColor = DashColors.Black,
                            disabledContainerColor = DashColors.SurfaceHighest,
                            disabledContentColor = DashColors.GreyDim,
                        ),
                    ) {
                        Icon(Icons.Rounded.ArrowUpward, contentDescription = "Send message")
                    }
                }
            }
        }
    }
}

@Composable
private fun AttachmentChip(attachment: PendingAttachment, onRemove: () -> Unit) {
    val failed = attachment.error != null
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (failed) DashColors.ErrorContainer else DashColors.SurfaceHigh,
        border = BorderStroke(1.dp, if (failed) DashColors.Error.copy(alpha = 0.5f) else DashColors.Outline),
        modifier = Modifier.widthIn(max = 260.dp).testTag("attachment_chip"),
    ) {
        Row(Modifier.padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                attachment.uploading -> CircularProgressIndicator(
                    progress = { attachment.progress },
                    modifier = Modifier.size(16.dp),
                    strokeWidth = 2.dp,
                    color = DashColors.Gold,
                )
                failed -> Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = DashColors.Error, modifier = Modifier.size(16.dp))
                else -> Icon(Icons.Rounded.Description, contentDescription = null, tint = DashColors.Gold, modifier = Modifier.size(16.dp))
            }
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f, fill = false).padding(vertical = 6.dp)) {
                Text(attachment.name, style = MaterialTheme.typography.labelMedium, color = DashColors.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    attachment.error ?: if (attachment.uploading) "Uploading ${(attachment.progress * 100).toInt()}%" else FileRules.formatSize(attachment.sizeBytes),
                    style = MaterialTheme.typography.labelSmall,
                    color = if (failed) DashColors.Error else DashColors.Grey,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            IconButton(onClick = onRemove) {
                Icon(Icons.Rounded.Close, contentDescription = "Remove ${attachment.name}", tint = DashColors.Grey, modifier = Modifier.size(16.dp))
            }
        }
    }
}
