package com.dashworldng.ai.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DriveFileRenameOutline
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.Extension
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.automirrored.rounded.LibraryBooks
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Schedule
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
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.presentation.HistoryGrouping
import com.dashworldng.ai.ui.components.BrandWordmark
import com.dashworldng.ai.ui.components.ConfirmDialog
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing
import com.dashworldng.ai.ui.automates.CountBadge
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.text.DateFormat
import java.util.Date

enum class DrawerDestination { HOME, DOCUMENTS, AUTOMATES, TOOLS, PROMPTS, SETTINGS }

/** What the drawer can do; shared by Home and the chat screen. */
class DrawerCallbacks(
    val onSearch: (String) -> Unit,
    val onOpen: (String) -> Unit,
    val onNewChat: () -> Unit,
    val onRename: (String, String) -> Unit,
    val onDelete: (String) -> Unit,
    val onNavigate: (DrawerDestination) -> Unit,
    val now: () -> Long = System::currentTimeMillis,
    /** Unread Automates results, shown as a count on the menu. */
    val unread: StateFlow<Int> = MutableStateFlow(0),
)

/**
 * The side drawer: new chat, search, history grouped by day (Today, Yesterday, Previous 7 days,
 * Older), then the app's destinations. Lazily laid out, so long histories stay smooth.
 */
@Composable
fun AppDrawer(
    conversations: List<Conversation>,
    search: String,
    openConversationId: String?,
    callbacks: DrawerCallbacks,
    close: () -> Unit,
) {
    val c = DashTheme.colors
    var renaming by remember { mutableStateOf<Conversation?>(null) }
    var deleting by remember { mutableStateOf<Conversation?>(null) }
    val groups = remember(conversations) { HistoryGrouping.group(conversations, callbacks.now()) }
    val unread by callbacks.unread.collectAsState()

    ModalDrawerSheet(drawerContainerColor = c.background, drawerContentColor = c.ink, modifier = Modifier.testTag("history_drawer")) {
        Column(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.md)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.heightIn(min = Sizing.minTouch)) {
                BrandWordmark(fontSize = 14.sp)
                Spacer(Modifier.weight(1f))
                IconButton(onClick = close) { Icon(Icons.Rounded.Close, contentDescription = "Close menu", tint = c.inkSecondary) }
            }
            DrawerRow("New chat", Icons.Rounded.EditNote, tag = "drawer_new_chat", emphasised = true) {
                callbacks.onNewChat()
                close()
            }
            Spacer(Modifier.size(Spacing.sm))
            DashTextField(
                value = search,
                onValueChange = callbacks.onSearch,
                label = "Search chats",
                leading = { Icon(Icons.Rounded.Search, contentDescription = null, tint = c.inkTertiary) },
                trailing = if (search.isNotEmpty()) {
                    { IconButton(onClick = { callbacks.onSearch("") }) { Icon(Icons.Rounded.Close, contentDescription = "Clear search", tint = c.inkTertiary) } }
                } else {
                    null
                },
                modifier = Modifier.testTag("history_search"),
            )
        }
        LazyColumn(Modifier.weight(1f).testTag("history_list")) {
            if (groups.isEmpty()) {
                item {
                    Text(
                        if (search.isBlank()) "No chats yet. Start one and it will appear here." else "No chats match “$search”.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.inkSecondary,
                        modifier = Modifier.padding(horizontal = Spacing.xl, vertical = Spacing.lg).testTag("history_empty"),
                    )
                }
            }
            groups.forEach { group ->
                item(key = "h-${group.section.name}") {
                    Text(
                        group.section.label,
                        style = MaterialTheme.typography.labelMedium,
                        color = c.inkTertiary,
                        modifier = Modifier.padding(start = Spacing.xl, top = Spacing.lg, bottom = Spacing.xs).semantics { heading() },
                    )
                }
                items(group.conversations, key = { it.id }) { conversation ->
                    ConversationRow(
                        conversation = conversation,
                        selected = conversation.id == openConversationId,
                        onOpen = {
                            callbacks.onOpen(conversation.id)
                            close()
                        },
                        onRename = { renaming = conversation },
                        onDelete = { deleting = conversation },
                    )
                }
            }
        }
        HorizontalDivider(color = c.outline)
        Column(Modifier.padding(horizontal = Spacing.sm, vertical = Spacing.sm)) {
            DrawerRow("Home", Icons.Rounded.Home, tag = "drawer_home") { close(); callbacks.onNavigate(DrawerDestination.HOME) }
            DrawerRow("Documents", Icons.Rounded.FolderOpen, tag = "drawer_documents") { close(); callbacks.onNavigate(DrawerDestination.DOCUMENTS) }
            DrawerRow("Automates", Icons.Rounded.Schedule, tag = "drawer_automates", count = unread) { close(); callbacks.onNavigate(DrawerDestination.AUTOMATES) }
            DrawerRow("Tools & Connections", Icons.Rounded.Extension, tag = "drawer_tools") { close(); callbacks.onNavigate(DrawerDestination.TOOLS) }
            DrawerRow("Prompt library", Icons.AutoMirrored.Rounded.LibraryBooks, tag = "drawer_prompts") { close(); callbacks.onNavigate(DrawerDestination.PROMPTS) }
            DrawerRow("Settings", Icons.Rounded.Settings, tag = "drawer_settings") { close(); callbacks.onNavigate(DrawerDestination.SETTINGS) }
        }
    }

    renaming?.let { conversation ->
        RenameDialog(
            initial = conversation.title,
            onDismiss = { renaming = null },
            onConfirm = { title ->
                callbacks.onRename(conversation.id, title)
                renaming = null
            },
        )
    }
    deleting?.let { conversation ->
        ConfirmDialog(
            title = "Delete this chat?",
            text = "“${conversation.title}” will be removed from this device and, when you're signed in, from your account on every device.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                callbacks.onDelete(conversation.id)
                deleting = null
            },
            onDismiss = { deleting = null },
            modifier = Modifier.testTag("confirm_delete"),
        )
    }
}

@Composable
private fun DrawerRow(label: String, icon: ImageVector, tag: String, emphasised: Boolean = false, count: Int = 0, onClick: () -> Unit) {
    val c = DashTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Sizing.minTouch)
            .clip(Radii.md)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = Spacing.md)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = if (emphasised) c.accentInk else c.inkSecondary, modifier = Modifier.size(Sizing.icon))
        Spacer(Modifier.width(Spacing.md))
        Text(label, style = if (emphasised) MaterialTheme.typography.titleSmall else MaterialTheme.typography.bodyLarge, color = c.ink, modifier = Modifier.weight(1f))
        CountBadge(count)
    }
}

@Composable
private fun ConversationRow(conversation: Conversation, selected: Boolean, onOpen: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit) {
    val c = DashTheme.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.sm)
            .clip(Radii.md)
            .then(if (selected) Modifier.background(c.surfaceSelected) else Modifier)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics { this.selected = selected }
            .padding(start = Spacing.md)
            .heightIn(min = 56.dp)
            .testTag("conversation_item"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null, tint = c.inkTertiary, modifier = Modifier.size(Sizing.iconSmall))
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f).padding(vertical = Spacing.sm)) {
            Text(conversation.title, style = MaterialTheme.typography.bodyLarge, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${conversation.mode.label} · ${DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(conversation.updatedAt)).let { time -> lastActivity(conversation.updatedAt, time) }}",
                style = MaterialTheme.typography.bodySmall,
                color = c.inkTertiary,
                maxLines = 1,
            )
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Rounded.MoreVert, contentDescription = "Options for ${conversation.title}", tint = c.inkTertiary)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = c.surface) {
                DropdownMenuItem(
                    text = { Text("Rename") },
                    leadingIcon = { Icon(Icons.Rounded.DriveFileRenameOutline, contentDescription = null) },
                    onClick = {
                        menu = false
                        onRename()
                    },
                )
                DropdownMenuItem(
                    text = { Text("Delete", color = c.error) },
                    leadingIcon = { Icon(Icons.Rounded.Delete, contentDescription = null, tint = c.error) },
                    onClick = {
                        menu = false
                        onDelete()
                    },
                )
            }
        }
    }
}

/** Today and Yesterday show the time (the section names the day); older chats show their date. */
private fun lastActivity(timestamp: Long, time: String): String {
    val days = (System.currentTimeMillis() - timestamp) / 86_400_000L
    return if (days < 2) time else DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(timestamp))
}

@Composable
fun RenameDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val c = DashTheme.colors
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        titleContentColor = c.ink,
        title = { Text("Rename chat") },
        text = {
            DashTextField(
                value = text,
                onValueChange = { text = it.take(Limits.MAX_TITLE_CHARS) },
                label = "Title",
                modifier = Modifier.testTag("rename_input"),
            )
        },
        confirmButton = { TextAction("Save", { onConfirm(text) }, enabled = text.isNotBlank(), modifier = Modifier.testTag("confirm_rename")) },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = c.inkSecondary) } },
    )
}
