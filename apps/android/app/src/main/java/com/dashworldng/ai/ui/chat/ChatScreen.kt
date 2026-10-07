package com.dashworldng.ai.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.History
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dashworldng.ai.core.chat.ChatItem
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.core.model.ProviderId
import com.dashworldng.ai.core.presentation.ProviderOptions
import com.dashworldng.ai.core.presentation.Recovery
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.system.rememberReducedMotion
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.launch

/** Every user action on the chat screen, so the layout can be rendered without a ViewModel. */
class ChatEvents(
    val onBack: () -> Unit,
    val onText: (String) -> Unit,
    val onSend: () -> Unit,
    val onStop: () -> Unit,
    val onAttach: () -> Unit,
    val onRemoveAttachment: (String) -> Unit,
    val onSelectChoice: (ModelChoice) -> Unit,
    val onConfirmCompare: (Boolean) -> Unit,
    val onSelectMode: (AssistantMode) -> Unit,
    val onSuggestion: (String) -> Unit,
    val onNewChat: () -> Unit,
    val onRetryLast: () -> Unit,
    val onDismissError: () -> Unit,
    val onOpenSettings: () -> Unit,
    val onOpenTools: () -> Unit,
    val onNotice: (String?) -> Unit,
    val onRegenerate: (String) -> Unit,
    val onRetryOther: (String) -> Unit,
    val onEditAndResend: (String, String) -> Unit,
    val onRetryAnswer: (String) -> Unit,
    val onAnswerWith: (String, ProviderId) -> Unit,
    val onContinueLater: (String) -> Unit,
)

@Composable
fun ChatScreen(vm: ChatViewModel, drawer: DrawerCallbacks, onBack: () -> Unit, onOpenSettings: () -> Unit, onOpenTools: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching { DocumentReader.read(context, uri) }
                .onSuccess(vm::attach)
                .onFailure { vm.notice("That file could not be opened.") }
        }
    }
    val events = remember(vm) {
        ChatEvents(
            onBack = onBack,
            onText = vm::onComposerChange,
            onSend = vm::send,
            onStop = vm::stop,
            onAttach = { picker.launch(FileRules.pickerMimeTypes) },
            onRemoveAttachment = vm::removeAttachment,
            onSelectChoice = vm::selectChoice,
            onConfirmCompare = vm::confirmCompare,
            onSelectMode = vm::selectMode,
            onSuggestion = vm::useSuggestion,
            onNewChat = vm::newChat,
            onRetryLast = vm::retryLast,
            onDismissError = vm::dismissError,
            onOpenSettings = onOpenSettings,
            onOpenTools = onOpenTools,
            onNotice = vm::notice,
            onRegenerate = vm::regenerate,
            onRetryOther = vm::retryWithOtherProvider,
            onEditAndResend = vm::editAndResend,
            onRetryAnswer = vm::retryAnswer,
            onAnswerWith = vm::answerWith,
            onContinueLater = vm::continueLater,
        )
    }
    ChatContent(state, events, drawer, reducedMotion = rememberReducedMotion())
}

@Composable
fun ChatContent(state: ChatUiState, events: ChatEvents, drawer: DrawerCallbacks, reducedMotion: Boolean) {
    val c = DashTheme.colors
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var editing by remember { mutableStateOf<ChatMessage?>(null) }
    var providerSheet by rememberSaveable { mutableStateOf(false) }
    var modeSheet by rememberSaveable { mutableStateOf(false) }
    var alternatives by remember { mutableStateOf<Pair<String, List<ProviderId>>?>(null) }

    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            events.onNotice(null)
        }
    }

    val actions = remember(events) {
        MessageActions(
            onRegenerate = events.onRegenerate,
            onRetryOther = events.onRetryOther,
            onEdit = { editing = it },
            onNotice = { events.onNotice(it) },
            onRetryAnswer = events.onRetryAnswer,
            onChangeProvider = { id, alts -> alternatives = id to alts },
            onContinueLater = events.onContinueLater,
        )
    }
    val configured = if (state.demoMode) ProviderId.entries.toSet() else state.providers.configured
    val extras = AnswerExtras(
        tools = { id -> state.session.toolUses[id].orEmpty() },
        recovery = { m ->
            if (m.id in state.dismissedRecovery) null else Recovery.card(m, state.session.recovery[m.id], configured, state.online || state.demoMode)
        },
        pluginNames = state.pluginNames,
        reducedMotion = reducedMotion,
    )

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            AppDrawer(
                conversations = state.conversations,
                search = state.search,
                openConversationId = state.session.conversation?.id,
                callbacks = drawer,
                close = { scope.launch { drawerState.close() } },
            )
        },
    ) {
        Scaffold(
            containerColor = c.background,
            snackbarHost = { SnackbarHost(snackbar) },
            topBar = {
                DashTopBar(
                    title = state.session.conversation?.title ?: "New chat",
                    onBack = events.onBack,
                    modifier = Modifier.testTag("chat_top_bar"),
                    titleContent = {
                        Text(
                            state.session.conversation?.title ?: "New chat",
                            style = MaterialTheme.typography.titleMedium,
                            color = c.ink,
                            maxLines = 1,
                            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                            modifier = Modifier.semantics { heading() }.testTag("chat_title"),
                        )
                    },
                    actions = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }, modifier = Modifier.testTag("open_history")) {
                            Icon(Icons.Rounded.History, contentDescription = "Chat history")
                        }
                        IconButton(onClick = events.onNewChat, enabled = !state.isGenerating, modifier = Modifier.testTag("new_chat")) {
                            Icon(Icons.Rounded.EditNote, contentDescription = "New chat")
                        }
                    },
                )
            },
        ) { padding ->
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .consumeWindowInsets(padding)
                    .imePadding(),
            ) {
                StatusNotices(state, events)
                Box(Modifier.weight(1f)) {
                    if (state.items.isEmpty()) {
                        EmptyChat(state.mode, state.demoMode, onSuggestion = events.onSuggestion)
                    } else {
                        MessageList(state, actions, extras)
                    }
                }
                ContentWidth {
                    Composer(
                        state = state,
                        onTextChange = events.onText,
                        onSend = events.onSend,
                        onStop = events.onStop,
                        onAttach = events.onAttach,
                        onRemoveAttachment = events.onRemoveAttachment,
                        onOpenProviders = { providerSheet = true },
                        onOpenModes = { modeSheet = true },
                        modifier = Modifier.padding(horizontal = Spacing.md).padding(bottom = Spacing.sm).navigationBarsPadding(),
                    )
                }
            }
        }
    }

    if (providerSheet) {
        ProviderSheet(
            options = ProviderOptions.build(state.providers, state.choice, state.demoMode),
            demoMode = state.demoMode,
            onSelect = {
                events.onSelectChoice(it.choice)
                providerSheet = false
            },
            onDismiss = { providerSheet = false },
        )
    }
    if (modeSheet) {
        ModeSheet(
            selected = state.mode,
            onSelect = {
                events.onSelectMode(it)
                modeSheet = false
            },
            onOpenTools = {
                modeSheet = false
                events.onOpenTools()
            },
            onDismiss = { modeSheet = false },
        )
    }
    alternatives?.let { (messageId, providers) ->
        AlternativeProviderSheet(
            alternatives = providers,
            onSelect = {
                events.onAnswerWith(messageId, it)
                alternatives = null
            },
            onDismiss = { alternatives = null },
        )
    }

    if (state.confirmCompare) {
        AlertDialog(
            onDismissRequest = { events.onConfirmCompare(false) },
            containerColor = c.surface,
            titleContentColor = c.ink,
            textContentColor = c.inkSecondary,
            title = { Text("Compare uses both providers") },
            text = {
                Text(
                    "Each message is sent to both OpenAI and Anthropic's Claude, and you'll see the two answers together. " +
                        "This makes two requests. Neither provider sees the other's answer.",
                )
            },
            confirmButton = { TextAction("Use Compare", { events.onConfirmCompare(true) }, modifier = Modifier.testTag("confirm_compare")) },
            dismissButton = { TextButton(onClick = { events.onConfirmCompare(false) }) { Text("Cancel", color = c.inkSecondary) } },
        )
    }

    editing?.let { message ->
        EditMessageDialog(
            initial = message.content,
            onDismiss = { editing = null },
            onConfirm = { text ->
                events.onEditAndResend(message.id, text)
                editing = null
            },
        )
    }
}

@Composable
private fun StatusNotices(state: ChatUiState, events: ChatEvents) {
    ContentWidth {
        Column(Modifier.padding(horizontal = Spacing.lg), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            if (state.demoMode) {
                Notice(
                    "Demo Mode: answers are simulated on this device. No AI provider is used.",
                    title = null,
                    actionLabel = "Settings",
                    onAction = events.onOpenSettings,
                    modifier = Modifier.testTag("demo_banner"),
                )
            } else if (!state.online) {
                Notice(
                    "You're offline. Your chats are still here; new answers need a connection.",
                    tone = StatusTone.WARNING,
                    modifier = Modifier.testTag("offline_banner"),
                )
            } else if (state.providers.error != null) {
                Notice("Couldn't check the server: ${state.providers.error}", tone = StatusTone.WARNING, actionLabel = "Settings", onAction = events.onOpenSettings)
            }
            val error = state.session.error
            if (error != null) {
                Notice(
                    error.message,
                    tone = StatusTone.ERROR,
                    actionLabel = if (error.retryable) "Retry" else null,
                    onAction = if (error.retryable) events.onRetryLast else null,
                    onDismiss = events.onDismissError,
                    modifier = Modifier.testTag("error_banner"),
                )
            }
        }
    }
}

/** A restrained start: one question, the mode's focus, three suggestions. */
@Composable
private fun EmptyChat(mode: AssistantMode, demo: Boolean, onSuggestion: (String) -> Unit) {
    val c = DashTheme.colors
    ContentWidth(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.gutter, vertical = Spacing.xl)
                .testTag("empty_chat"),
            verticalArrangement = Arrangement.spacedBy(Spacing.md),
        ) {
            Spacer(Modifier.height(Spacing.xl))
            Text("What do you want to work on?", style = MaterialTheme.typography.headlineMedium, color = c.ink, modifier = Modifier.semantics { heading() })
            Text("${mode.label} · ${mode.tagline}", style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
            mode.limitation?.let { Notice(it, modifier = Modifier.testTag("mode_limitation")) }
            if (demo) {
                Text(
                    "You're in Demo Mode. Try anything; every answer is labelled as a simulation.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkTertiary,
                )
            }
            Spacer(Modifier.height(Spacing.sm))
            mode.suggestions.take(3).forEach { suggestion ->
                QuietCard(onClick = { onSuggestion(suggestion) }, modifier = Modifier.fillMaxWidth().testTag("suggestion")) {
                    Text(suggestion, style = MaterialTheme.typography.bodyMedium, color = c.ink)
                }
            }
        }
    }
}

@Composable
private fun MessageList(state: ChatUiState, actions: MessageActions, extras: AnswerExtras) {
    val c = DashTheme.colors
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val reversed = remember(state.items) { state.items.asReversed() }
    // reverseLayout keeps the newest item at index 0, so streaming text stays anchored at the bottom
    // unless the reader has scrolled up to read something earlier.
    LaunchedEffect(state.items.size) {
        if (listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0)
    }
    val showJump by remember { derivedStateOf { listState.firstVisibleItemIndex > 1 } }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            reverseLayout = true,
            modifier = Modifier.fillMaxSize().testTag("message_list"),
            contentPadding = PaddingValues(horizontal = Spacing.gutter, vertical = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.xl),
        ) {
            items(reversed, key = { it.key }, contentType = { it::class }) { item ->
                // Each row receives the message object itself: rows whose message did not change are
                // skipped while another answer streams.
                ContentWidth {
                    when (item) {
                        is ChatItem.User -> UserMessage(item.message, state.isGenerating, actions)
                        is ChatItem.Assistant -> AssistantMessage(item.message, state.isGenerating, actions, extras)
                        is ChatItem.Compare -> CompareRow(item.answers, state.isGenerating, actions, extras)
                    }
                }
            }
        }
        if (showJump) {
            SmallFloatingActionButton(
                onClick = { scope.launch { listState.animateScrollToItem(0) } },
                containerColor = c.surface,
                contentColor = c.ink,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = Spacing.md).testTag("jump_to_latest"),
            ) { Icon(Icons.Rounded.KeyboardArrowDown, contentDescription = "Jump to the latest message") }
        }
    }
}

@Composable
private fun EditMessageDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    val c = DashTheme.colors
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        titleContentColor = c.ink,
        title = { Text("Edit and resend") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                Text("Answers after this message will be replaced.", style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
                DashTextField(value = text, onValueChange = { text = it }, label = "Message", singleLine = false, modifier = Modifier.testTag("edit_input"))
            }
        },
        confirmButton = { TextAction("Resend", { onConfirm(text) }, enabled = text.isNotBlank()) },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = c.inkSecondary) } },
    )
}
