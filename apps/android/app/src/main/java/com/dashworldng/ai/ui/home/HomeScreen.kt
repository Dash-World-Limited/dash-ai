package com.dashworldng.ai.ui.home

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.Extension
import androidx.compose.material.icons.rounded.Lightbulb
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.TravelExplore
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.Conversation
import com.dashworldng.ai.core.presentation.Greeting
import com.dashworldng.ai.core.presentation.QuickAction
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.ui.chat.AppDrawer
import com.dashworldng.ai.ui.chat.ChatViewModel
import com.dashworldng.ai.ui.chat.DrawerCallbacks
import com.dashworldng.ai.ui.components.Avatar
import com.dashworldng.ai.ui.components.BrandWordmark
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.SectionHeader
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/** What Home shows. Built from the shared chat state and settings. */
data class HomeUiState(
    val account: AccountInfo?,
    val demoMode: Boolean,
    val online: Boolean,
    val recent: List<Conversation>,
    val allConversations: List<Conversation>,
    val search: String,
    val hour: Int,
)

class HomeEvents(
    val onAsk: (String) -> Unit,
    val onQuickAction: (QuickAction) -> Unit,
    val onOpenConversation: (String) -> Unit,
    val onOpenAccount: () -> Unit,
)

@Composable
fun HomeScreen(
    vm: ChatViewModel,
    drawer: DrawerCallbacks,
    onOpenChat: () -> Unit,
    onOpenTools: () -> Unit,
    onOpenAccount: () -> Unit,
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching { DocumentReader.read(context, uri) }
                .onSuccess {
                    vm.startChat(AssistantMode.DOCUMENTS)
                    vm.attach(it)
                    onOpenChat()
                }
                .onFailure { vm.notice("That file could not be opened.") }
        }
    }
    val home = HomeUiState(
        account = state.account,
        demoMode = state.demoMode,
        online = state.online,
        recent = state.conversations.take(5),
        allConversations = state.conversations,
        search = state.search,
        hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY),
    )
    HomeContent(
        state = home,
        drawer = drawer,
        events = HomeEvents(
            onAsk = { text ->
                vm.sendFromHome(text)
                onOpenChat()
            },
            onQuickAction = { action ->
                when {
                    action.opensTools -> onOpenTools()
                    action.asksForFile -> picker.launch(FileRules.pickerMimeTypes)
                    else -> {
                        vm.startChat(action.mode, action.prompt)
                        onOpenChat()
                    }
                }
            },
            onOpenConversation = { id ->
                vm.openConversation(id)
                onOpenChat()
            },
            onOpenAccount = onOpenAccount,
        ),
    )
}

@Composable
fun HomeContent(state: HomeUiState, drawer: DrawerCallbacks, events: HomeEvents) {
    val c = DashTheme.colors
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val account = state.account
    // System Back closes the open history drawer first, before leaving the screen.
    BackHandler(enabled = drawerState.isOpen) { scope.launch { drawerState.close() } }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            AppDrawer(state.allConversations, state.search, null, drawer, close = { scope.launch { drawerState.close() } })
        },
    ) {
        Scaffold(
            containerColor = c.background,
            topBar = {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(top = Spacing.xs)
                        .statusBarsPadding()
                        .padding(horizontal = Spacing.xs),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val unread by drawer.unread.collectAsState()
                    IconButton(onClick = { scope.launch { drawerState.open() } }, modifier = Modifier.testTag("open_history")) {
                        Box {
                            Icon(
                                Icons.Rounded.Menu,
                                contentDescription = if (unread > 0) "Open menu and chat history ($unread new results)" else "Open menu and chat history",
                                tint = c.ink,
                            )
                            // A quiet dot for new Automates results; the count is on the Automates entry.
                            if (unread > 0) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(c.accent).testTag("menu_unread_dot"))
                        }
                    }
                    Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            BrandWordmark(fontSize = 13.sp)
                            if (state.demoMode) {
                                Spacer(Modifier.width(Spacing.sm))
                                DemoBadge()
                            }
                        }
                    }
                    Avatar(
                        initials = Greeting.initials(account?.displayName, account?.email),
                        contentDescription = "Account",
                        onClick = events.onOpenAccount,
                        modifier = Modifier.testTag("open_account"),
                    )
                }
            },
        ) { padding ->
            ContentWidth(Modifier.fillMaxSize().padding(padding)) {
                Column(
                    Modifier
                        .fillMaxSize()
                        .imePadding()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = Spacing.gutter)
                        .navigationBarsPadding()
                        .testTag("home_screen"),
                ) {
                    Spacer(Modifier.height(Spacing.xxl))
                    Text(
                        Greeting.forHour(state.hour, account?.displayName.takeUnless { account?.isDemo == true }),
                        style = MaterialTheme.typography.headlineLarge,
                        color = c.ink,
                        modifier = Modifier.semantics { heading() }.testTag("home_greeting"),
                    )
                    Spacer(Modifier.height(Spacing.xs))
                    Text("What are we building today?", style = MaterialTheme.typography.bodyLarge, color = c.inkSecondary)
                    Spacer(Modifier.height(Spacing.xl))
                    AskField(onAsk = events.onAsk, enabled = state.demoMode || state.online)
                    if (!state.demoMode && !state.online) {
                        Notice(
                            "You're offline. Your chats are still here; new answers need a connection.",
                            tone = com.dashworldng.ai.core.presentation.StatusTone.WARNING,
                            modifier = Modifier.padding(top = Spacing.md).testTag("offline_banner"),
                        )
                    }
                    Spacer(Modifier.height(Spacing.lg))
                    QuickActions(events.onQuickAction)
                    SectionHeader("Recent chats")
                    if (state.recent.isEmpty()) {
                        QuietCard(modifier = Modifier.fillMaxWidth().testTag("home_empty")) {
                            Text("No chats yet", style = MaterialTheme.typography.titleSmall, color = c.ink)
                            Spacer(Modifier.height(Spacing.xxs))
                            Text(
                                if (state.demoMode) {
                                    "Ask anything above. In Demo Mode answers are simulated and stay on this device."
                                } else {
                                    "Ask anything above. Your chats sync with your account and appear here."
                                },
                                style = MaterialTheme.typography.bodyMedium,
                                color = c.inkSecondary,
                            )
                        }
                    } else {
                        QuietCard(modifier = Modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = Spacing.xs)) {
                            state.recent.forEach { conversation ->
                                RecentRow(conversation) { events.onOpenConversation(conversation.id) }
                            }
                        }
                        if (state.allConversations.size > state.recent.size) {
                            TextAction("See all chats", { scope.launch { drawerState.open() } }, modifier = Modifier.padding(top = Spacing.xs))
                        }
                    }
                    Spacer(Modifier.height(Spacing.xxl))
                }
            }
        }
    }
}

@Composable
private fun AskField(onAsk: (String) -> Unit, enabled: Boolean) {
    val c = DashTheme.colors
    var text by rememberSaveable { mutableStateOf("") }
    val submit = {
        if (text.isNotBlank() && enabled) {
            onAsk(text.trim())
            text = ""
        }
    }
    Surface(
        shape = Radii.xl,
        color = c.surface,
        border = BorderStroke(1.dp, c.outline),
        shadowElevation = if (c.isDark) 0.dp else 2.dp,
        modifier = Modifier.fillMaxWidth().testTag("home_ask"),
    ) {
        Row(Modifier.padding(start = Spacing.lg, end = Spacing.sm, top = Spacing.sm, bottom = Spacing.sm), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f).heightIn(min = Sizing.minTouch), contentAlignment = Alignment.CenterStart) {
                if (text.isEmpty()) Text("Ask DASH AI anything...", style = MaterialTheme.typography.bodyLarge, color = c.inkTertiary)
                BasicTextField(
                    value = text,
                    onValueChange = { text = it },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = c.ink),
                    cursorBrush = SolidColor(c.accentInk),
                    maxLines = 5,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                    keyboardActions = KeyboardActions(onSend = { submit() }),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Ask DASH AI anything" }.testTag("home_input"),
                )
            }
            Spacer(Modifier.width(Spacing.sm))
            FilledIconButton(
                onClick = submit,
                enabled = enabled && text.isNotBlank(),
                modifier = Modifier.size(Sizing.minTouch).testTag("home_send"),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = c.accent,
                    contentColor = c.onAccent,
                    disabledContainerColor = c.surfaceMuted,
                    disabledContentColor = c.inkTertiary,
                ),
            ) { Icon(Icons.Rounded.ArrowUpward, contentDescription = "Send") }
        }
    }
}

private fun QuickAction.icon(): ImageVector = when (this) {
    QuickAction.WRITE -> Icons.Rounded.EditNote
    QuickAction.ANALYSE_FILE -> Icons.Rounded.Description
    QuickAction.BRAINSTORM -> Icons.Rounded.Lightbulb
    QuickAction.CODE -> Icons.Rounded.Code
    QuickAction.RESEARCH -> Icons.Rounded.TravelExplore
    QuickAction.MORE_TOOLS -> Icons.Rounded.Extension
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun QuickActions(onAction: (QuickAction) -> Unit) {
    val c = DashTheme.colors
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        QuickAction.entries.forEach { action ->
            Row(
                Modifier
                    .heightIn(min = Sizing.minTouch)
                    .clip(Radii.pill)
                    .clickable(role = Role.Button, onClick = { onAction(action) })
                    .background(c.surface)
                    .border(1.dp, c.outline, Radii.pill)
                    .padding(horizontal = Spacing.lg)
                    .testTag("quick_${action.name.lowercase()}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(action.icon(), contentDescription = null, tint = c.accentInk, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(Spacing.sm))
                Text(action.label, style = MaterialTheme.typography.labelLarge, color = c.ink)
            }
        }
    }
}

@Composable
private fun RecentRow(conversation: Conversation, onClick: () -> Unit) {
    val c = DashTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = Spacing.lg)
            .testTag("recent_chat"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Rounded.Chat, contentDescription = null, tint = c.inkTertiary, modifier = Modifier.size(Sizing.iconSmall))
        Spacer(Modifier.width(Spacing.md))
        Text(conversation.title, style = MaterialTheme.typography.bodyLarge, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(Spacing.md))
        Text(
            DateFormat.getDateInstance(DateFormat.SHORT).format(Date(conversation.updatedAt)),
            style = MaterialTheme.typography.bodySmall,
            color = c.inkTertiary,
        )
    }
}
