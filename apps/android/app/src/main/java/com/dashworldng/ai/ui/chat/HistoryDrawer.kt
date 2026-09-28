package com.dashworldng.ai.ui.chat

import android.text.format.DateUtils
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Bookmarks
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.NavigationDrawerItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.ui.components.DashWordmark
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.components.GoldButton
import com.dashworldng.ai.ui.theme.DashColors

enum class DrawerDestination { DOCUMENTS, PROMPTS, SETTINGS, ACCOUNT }

@Composable
fun HistoryDrawer(
    state: ChatUiState,
    onSearch: (String) -> Unit,
    onOpen: (String) -> Unit,
    onNewChat: () -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onNavigate: (DrawerDestination) -> Unit,
) {
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }

    ModalDrawerSheet(drawerContainerColor = DashColors.Surface, modifier = Modifier.testTag("history_drawer")) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                DashWordmark(size = 20.dp)
                Spacer(Modifier.weight(1f))
                if (state.demoMode) DemoBadge()
            }
            Spacer(Modifier.padding(6.dp))
            GoldButton("New chat", onClick = onNewChat, icon = Icons.Rounded.Add, modifier = Modifier.fillMaxWidth().testTag("drawer_new_chat"))
            Spacer(Modifier.padding(6.dp))
            OutlinedTextField(
                value = state.search,
                onValueChange = onSearch,
                placeholder = { Text("Search conversations") },
                leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().testTag("history_search"),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = DashColors.GoldDeep,
                    unfocusedBorderColor = DashColors.Outline,
                    cursorColor = DashColors.Gold,
                ),
            )
        }
        Text(
            "HISTORY",
            style = MaterialTheme.typography.labelMedium,
            color = DashColors.Gold,
            modifier = Modifier.padding(start = 20.dp, top = 4.dp, bottom = 4.dp),
        )
        Box(Modifier.weight(1f)) {
            if (state.conversations.isEmpty()) {
                EmptyState(
                    title = if (state.search.isBlank()) "No conversations yet" else "No matches",
                    body = if (state.search.isBlank()) "Your chats are saved on this device." else "Try a different word.",
                    icon = Icons.Rounded.Forum,
                )
            } else {
                LazyColumn(Modifier.fillMaxWidth().testTag("history_list")) {
                    items(state.conversations, key = { it.id }) { conversation ->
                        ConversationRow(
                            conversation = conversation,
                            selected = conversation.id == state.session.conversation?.id,
                            onOpen = { onOpen(conversation.id) },
                            onRename = { renaming = conversation },
                            onDelete = { deleting = conversation },
                        )
                    }
                }
            }
        }
        HorizontalDivider(color = DashColors.OutlineSoft)
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            DrawerLink("Documents", Icons.Rounded.FolderOpen, "drawer_documents") { onNavigate(DrawerDestination.DOCUMENTS) }
            DrawerLink("Prompt library", Icons.Rounded.Bookmarks, "drawer_prompts") { onNavigate(DrawerDestination.PROMPTS) }
            DrawerLink("Settings", Icons.Rounded.Settings, "drawer_settings") { onNavigate(DrawerDestination.SETTINGS) }
            DrawerLink(state.account?.displayName ?: "Account", Icons.Rounded.Person, "drawer_account") { onNavigate(DrawerDestination.ACCOUNT) }
        }
    }

    renaming?.let { conversation ->
        RenameDialog(
            initial = conversation.title,
            onDismiss = { renaming = null },
            onConfirm = {
                onRename(conversation.id, it)
                renaming = null
            },
        )
    }
    deleting?.let { conversation ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete this conversation?") },
            text = { Text("“${conversation.title}” will be permanently deleted from this device. This can't be undone.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        onDelete(conversation.id)
                        deleting = null
                    },
                    modifier = Modifier.testTag("confirm_delete"),
                ) { Text("Delete", color = DashColors.Error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }
}

@Composable
private fun ConversationRow(conversation: Conversation, selected: Boolean, onOpen: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    NavigationDrawerItem(
        selected = selected,
        onClick = onOpen,
        modifier = Modifier.padding(horizontal = 8.dp).testTag("conversation_item"),
        colors = NavigationDrawerItemDefaults.colors(
            selectedContainerColor = DashColors.GoldContainer,
            unselectedContainerColor = DashColors.Surface,
        ),
        label = {
            Column {
                Text(conversation.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, color = DashColors.White)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${conversation.mode.label} · ${DateUtils.getRelativeTimeSpanString(conversation.updatedAt)}",
                        style = MaterialTheme.typography.labelSmall,
                        color = DashColors.GreyDim,
                    )
                    if (conversation.isDemo) {
                        Spacer(Modifier.width(6.dp))
                        DemoBadge()
                    }
                }
            }
        },
        badge = {
            Box {
                IconButton(onClick = { menu = true }) {
                    Icon(Icons.Rounded.MoreVert, contentDescription = "Conversation options", tint = DashColors.Grey)
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(
                        text = { Text("Rename") },
                        leadingIcon = { Icon(Icons.Rounded.Edit, contentDescription = null) },
                        onClick = {
                            menu = false
                            onRename()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("Delete", color = DashColors.Error) },
                        leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null, tint = DashColors.Error) },
                        onClick = {
                            menu = false
                            onDelete()
                        },
                    )
                }
            }
        },
    )
}

@Composable
private fun DrawerLink(label: String, icon: ImageVector, tag: String, onClick: () -> Unit) {
    NavigationDrawerItem(
        selected = false,
        onClick = onClick,
        icon = { Icon(icon, contentDescription = null, tint = DashColors.Gold) },
        label = { Text(label, color = DashColors.White) },
        modifier = Modifier.testTag(tag),
        colors = NavigationDrawerItemDefaults.colors(unselectedContainerColor = DashColors.Surface),
    )
}

@Composable
fun RenameDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename conversation") },
        text = {
            OutlinedTextField(value = text, onValueChange = { text = it.take(120) }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("rename_input"))
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text) }, enabled = text.isNotBlank(), modifier = Modifier.testTag("confirm_rename")) {
                Text("Save", color = DashColors.Gold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = DashColors.SurfaceHigh,
    )
}
