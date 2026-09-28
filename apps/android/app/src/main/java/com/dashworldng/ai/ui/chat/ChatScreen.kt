package com.dashworldng.ai.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.EditNote
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Menu
import androidx.compose.material.icons.rounded.Science
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dashworldng.ai.core.chat.ChatItem
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.ModelChoice
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.Banner
import com.dashworldng.ai.ui.components.BannerTone
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.DashWordmark
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    services: AppServices,
    onOpenDocuments: () -> Unit,
    onOpenPrompts: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenAccount: () -> Unit,
) {
    val vm = dashViewModel { ChatViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    var editing by remember { mutableStateOf<ChatMessage?>(null) }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            runCatching { DocumentReader.read(context, uri) }
                .onSuccess(vm::attach)
                .onFailure { vm.notice("That file could not be opened.") }
        }
    }

    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            vm.notice(null)
        }
    }

    val actions = remember(vm) {
        MessageActions(
            onRegenerate = vm::regenerate,
            onRetryOther = vm::retryWithOtherProvider,
            onEdit = { editing = it },
            onNotice = { vm.notice(it) },
        )
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            HistoryDrawer(
                state = state,
                onSearch = vm::setSearch,
                onOpen = { id ->
                    vm.openConversation(id)
                    scope.launch { drawerState.close() }
                },
                onNewChat = {
                    vm.newChat()
                    scope.launch { drawerState.close() }
                },
                onRename = vm::renameConversation,
                onDelete = vm::deleteConversation,
                onNavigate = { destination ->
                    scope.launch { drawerState.close() }
                    when (destination) {
                        DrawerDestination.DOCUMENTS -> onOpenDocuments()
                        DrawerDestination.PROMPTS -> onOpenPrompts()
                        DrawerDestination.SETTINGS -> onOpenSettings()
                        DrawerDestination.ACCOUNT -> onOpenAccount()
                    }
                },
            )
        },
    ) {
        Scaffold(
            containerColor = DashColors.Black,
            snackbarHost = { SnackbarHost(snackbar) },
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = DashColors.Black),
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }, modifier = Modifier.testTag("open_history")) {
                            Icon(Icons.Rounded.Menu, contentDescription = "Open conversation history")
                        }
                    },
                    title = {
                        Column {
                            Text(
                                state.session.conversation?.title ?: "Dash AI",
                                style = MaterialTheme.typography.titleMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.testTag("chat_title"),
                            )
                            ModelSelector(state, onSelect = vm::selectChoice)
                        }
                    },
                    actions = {
                        IconButton(onClick = vm::newChat, modifier = Modifier.testTag("new_chat")) {
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
                StatusBanners(state, onRetry = vm::retryLast, onDismissError = vm::dismissError, onOpenSettings = onOpenSettings)
                ModeSelector(state.mode, onSelect = vm::selectMode)
                Box(Modifier.weight(1f)) {
                    if (state.items.isEmpty()) {
                        EmptyChat(state.mode, state.demoMode, onSuggestion = vm::useSuggestion)
                    } else {
                        MessageList(state, actions)
                    }
                }
                Composer(
                    state = state,
                    onTextChange = vm::onComposerChange,
                    onSend = vm::send,
                    onStop = vm::stop,
                    onAttach = { picker.launch(FileRules.pickerMimeTypes) },
                    onRemoveAttachment = vm::removeAttachment,
                )
            }
        }
    }

    if (state.confirmCompare) {
        AlertDialog(
            onDismissRequest = { vm.confirmCompare(false) },
            icon = { Icon(Icons.Rounded.Warning, contentDescription = null, tint = DashColors.Gold) },
            title = { Text("Compare uses both providers") },
            text = {
                Text(
                    "Each prompt will be sent to both OpenAI and Anthropic (Claude), and you'll see the two answers side by side. " +
                        "This uses both providers and may cost more. Neither provider sees the other's answer.",
                )
            },
            confirmButton = {
                TextButton(onClick = { vm.confirmCompare(true) }, modifier = Modifier.testTag("confirm_compare")) {
                    Text("Use Compare", color = DashColors.Gold)
                }
            },
            dismissButton = { TextButton(onClick = { vm.confirmCompare(false) }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }

    editing?.let { message ->
        EditMessageDialog(
            initial = message.content,
            onDismiss = { editing = null },
            onConfirm = { text ->
                vm.editAndResend(message.id, text)
                editing = null
            },
        )
    }
}

@Composable
private fun ModelSelector(state: ChatUiState, onSelect: (ModelChoice) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .clickable { expanded = true }
                .testTag("model_selector")
                .padding(vertical = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Rounded.AutoAwesome, contentDescription = null, tint = DashColors.Gold, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(4.dp))
            Text(state.choice.label, style = MaterialTheme.typography.labelMedium, color = DashColors.Gold, modifier = Modifier.testTag("selected_model"))
            Icon(Icons.Rounded.ArrowDropDown, contentDescription = "Choose model", tint = DashColors.Gold)
            if (state.demoMode) DemoBadge()
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            ModelChoice.entries.forEach { choice ->
                val available = state.providers.isAvailable(choice)
                DropdownMenuItem(
                    modifier = Modifier.testTag("model_option_${choice.wire}"),
                    enabled = available,
                    leadingIcon = {
                        if (choice == state.choice) Icon(Icons.Rounded.Check, contentDescription = "Selected", tint = DashColors.Gold)
                        else Spacer(Modifier.size(24.dp))
                    },
                    text = {
                        Column(Modifier.padding(vertical = 4.dp)) {
                            Text(choice.label, style = MaterialTheme.typography.titleSmall)
                            Text(
                                when {
                                    !available -> "Not configured on this server"
                                    choice == ModelChoice.COMPARE -> "Sends to both providers · may cost more"
                                    else -> choice.description
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = if (choice == ModelChoice.COMPARE && available) DashColors.GoldLight else DashColors.Grey,
                            )
                        }
                    },
                    onClick = {
                        expanded = false
                        onSelect(choice)
                    },
                )
            }
        }
    }
}

@Composable
private fun ModeSelector(selected: AssistantMode, onSelect: (AssistantMode) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AssistantMode.entries.forEach { mode ->
            FilterChip(
                selected = mode == selected,
                onClick = { onSelect(mode) },
                label = { Text(mode.label) },
                modifier = Modifier.testTag("mode_${mode.wire}"),
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = DashColors.GoldContainer,
                    selectedLabelColor = DashColors.GoldLight,
                    labelColor = DashColors.Grey,
                ),
                border = FilterChipDefaults.filterChipBorder(
                    enabled = true,
                    selected = mode == selected,
                    borderColor = DashColors.Outline,
                    selectedBorderColor = DashColors.GoldDeep,
                ),
            )
        }
    }
}

@Composable
private fun StatusBanners(state: ChatUiState, onRetry: () -> Unit, onDismissError: () -> Unit, onOpenSettings: () -> Unit) {
    Column(Modifier.padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (state.demoMode) {
            Banner(
                "Demo Mode · answers are simulated on this device. No AI provider is used.",
                icon = Icons.Rounded.Science,
                tone = BannerTone.WARNING,
                actionLabel = "Settings",
                onAction = onOpenSettings,
                modifier = Modifier.testTag("demo_banner"),
            )
        } else if (!state.online) {
            Banner(
                "You're offline. Live answers need a connection — your history is still available.",
                icon = Icons.Rounded.CloudOff,
                tone = BannerTone.ERROR,
                modifier = Modifier.testTag("offline_banner"),
            )
        } else if (state.providers.error != null) {
            Banner("Couldn't check the server: ${state.providers.error}", icon = Icons.Rounded.Info, actionLabel = "Settings", onAction = onOpenSettings)
        }
        val error = state.session.error
        if (error != null) {
            Banner(
                error.message,
                tone = BannerTone.ERROR,
                icon = Icons.Rounded.Warning,
                actionLabel = if (error.retryable) "Retry" else null,
                onAction = if (error.retryable) onRetry else null,
                onDismiss = onDismissError,
                modifier = Modifier.testTag("error_banner"),
            )
        }
    }
}

@Composable
private fun EmptyChat(mode: AssistantMode, demo: Boolean, onSuggestion: (String) -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp)
            .testTag("empty_chat"),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        DashWordmark(size = 26.dp)
        Text("How can I help today?", style = MaterialTheme.typography.headlineSmall, color = DashColors.White)
        Text("${mode.label} · ${mode.tagline}", style = MaterialTheme.typography.bodyMedium, color = DashColors.Grey)
        mode.limitation?.let {
            Banner(it, icon = Icons.Rounded.Info, modifier = Modifier.testTag("mode_limitation"))
        }
        if (demo) {
            Text(
                "You're in Demo Mode — try sending anything. Answers are clearly labelled simulations.",
                style = MaterialTheme.typography.bodySmall,
                color = DashColors.GreyDim,
            )
        }
        Spacer(Modifier.height(4.dp))
        mode.suggestions.forEach { suggestion ->
            Surface(
                onClick = { onSuggestion(suggestion) },
                shape = RoundedCornerShape(14.dp),
                color = DashColors.Surface,
                border = BorderStroke(1.dp, DashColors.OutlineSoft),
                modifier = Modifier.fillMaxWidth().testTag("suggestion"),
            ) {
                Text(suggestion, modifier = Modifier.padding(14.dp), style = MaterialTheme.typography.bodyMedium, color = DashColors.White)
            }
        }
    }
}

@Composable
private fun MessageList(state: ChatUiState, actions: MessageActions) {
    val listState = rememberLazyListState()
    val reversed = remember(state.items) { state.items.asReversed() }
    // Newest item sits at index 0 with reverseLayout, so streaming text stays anchored at the bottom.
    LaunchedEffect(state.items.size) {
        if (listState.firstVisibleItemIndex <= 1) listState.scrollToItem(0)
    }
    LazyColumn(
        state = listState,
        reverseLayout = true,
        modifier = Modifier.fillMaxSize().testTag("message_list"),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        items(reversed, key = { it.key }) { item ->
            when (item) {
                is ChatItem.User -> UserMessage(item.message, state.isGenerating, actions)
                is ChatItem.Assistant -> AssistantMessage(item.message, state.isGenerating, actions)
                is ChatItem.Compare -> CompareRow(item.answers, state.isGenerating, actions)
            }
        }
    }
}

@Composable
private fun EditMessageDialog(initial: String, onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit and resend") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Answers after this message will be replaced.", style = MaterialTheme.typography.bodySmall, color = DashColors.Grey)
                OutlinedTextField(value = text, onValueChange = { text = it }, modifier = Modifier.fillMaxWidth().testTag("edit_input"), maxLines = 8)
            }
        },
        confirmButton = {
            TextButton(onClick = { onConfirm(text) }, enabled = text.isNotBlank()) { Text("Resend", color = DashColors.Gold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = DashColors.SurfaceHigh,
    )
}
