package com.dashworldng.ai.ui.automates

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.NotificationsNone
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.presentation.AutomationDraft
import com.dashworldng.ai.core.presentation.AutomationLabels
import com.dashworldng.ai.core.presentation.RepeatKind
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.core.remote.AppNotificationDto
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationRunSummaryDto
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.chat.shareText
import com.dashworldng.ai.ui.components.ConfirmDialog
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.components.ErrorState
import com.dashworldng.ai.ui.components.LoadingState
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.SecondaryButton
import com.dashworldng.ai.ui.components.StatusBadge
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.markdown.MarkdownView
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.delay
import java.time.Instant

/** How often an open screen checks on a run in progress (bounded, so nothing polls forever). */
private const val RUNNING_POLL_MS = 3_000L
private const val RUNNING_POLL_LIMIT = 200

private fun AppServices.nowInstant(): Instant = Instant.ofEpochMilli(clock.now())

// ---- List ---------------------------------------------------------------------------------------

@Composable
fun AutomatesScreen(
    services: AppServices,
    onBack: () -> Unit,
    onSignIn: () -> Unit,
    onNew: () -> Unit,
    onOpen: (String) -> Unit,
    onOpenRun: (String, String) -> Unit,
) {
    val vm = dashViewModel { AutomatesListViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val running = state.automations.any { it.state == "running" }
    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(running) {
        if (running) repeat(RUNNING_POLL_LIMIT) {
            delay(RUNNING_POLL_MS)
            vm.load(quiet = true)
        }
    }
    val c = DashTheme.colors
    val now = services.nowInstant()
    Scaffold(
        containerColor = c.background,
        topBar = {
            DashTopBar("Automates", onBack = onBack, actions = {
                if (state.signedIn) IconButton(onClick = onNew, modifier = Modifier.testTag("automation_new")) {
                    Icon(Icons.Rounded.Add, contentDescription = "New automation", tint = c.ink)
                }
            })
        },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("automates_screen"),
                contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, bottom = Spacing.xxl),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                item {
                    Text(
                        "Give DASH AI a task and a schedule. It runs on the server, even when your phone is off, and the result waits here for you to review and share.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = c.inkSecondary,
                    )
                }
                when {
                    !state.signedIn -> item {
                        EmptyState(
                            icon = Icons.Rounded.Schedule,
                            title = "Sign in to use Automates",
                            message = "Automations run on your DASH AI server for your account. Demo Mode doesn't run any.",
                            action = { PrimaryButton("Sign in", onSignIn) },
                            modifier = Modifier.testTag("automates_signed_out"),
                        )
                    }
                    state.loading -> item { LoadingState("Loading automations…") }
                    state.error != null && state.automations.isEmpty() -> item {
                        ErrorState("Couldn't load automations", state.error!!, onRetry = { vm.load() })
                    }
                    else -> {
                        if (state.notices.isNotEmpty()) {
                            item { NoticesCard(state.notices, now, onOpenRun = onOpenRun, onDismiss = vm::dismissNotices) }
                        }
                        if (state.automations.isEmpty()) {
                            item {
                                EmptyState(
                                    icon = Icons.Rounded.Schedule,
                                    title = "No automations yet",
                                    message = "For example: every weekday at 08:00, draft three priorities for my day.",
                                    action = { PrimaryButton("New automation", onNew, icon = Icons.Rounded.Add) },
                                    modifier = Modifier.testTag("automates_empty"),
                                )
                            }
                        }
                        items(state.automations, key = { it.id }) { a -> AutomationCard(a, now, onClick = { onOpen(a.id) }) }
                        if (state.automations.isNotEmpty()) {
                            item {
                                Text(
                                    "Results are only ever shown to you. DASH AI never posts anything for you.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = c.inkTertiary,
                                    modifier = Modifier.padding(top = Spacing.sm),
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun NoticesCard(notices: List<AppNotificationDto>, now: Instant, onOpenRun: (String, String) -> Unit, onDismiss: () -> Unit) {
    val c = DashTheme.colors
    QuietCard(Modifier.fillMaxWidth().testTag("automates_notices"), selected = true) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.NotificationsNone, contentDescription = null, tint = c.accentInk, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(Spacing.sm))
            Text("New results", style = MaterialTheme.typography.titleSmall, color = c.ink, modifier = Modifier.weight(1f).semantics { heading() })
            TextAction("Mark all read", onDismiss)
        }
        notices.take(5).forEach { n ->
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(Radii.md)
                    .clickable(role = Role.Button) { onOpenRun(n.automationId, n.runId) }
                    .padding(vertical = Spacing.sm)
                    .testTag("automates_notice"),
            ) {
                Text(n.title, style = MaterialTheme.typography.bodyMedium, color = if (n.kind == "automation.failed") c.error else c.ink)
                Text(
                    AutomationLabels.formatWhen(n.createdAt, now) + if (n.body.isNotBlank()) " · ${n.body}" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun AutomationCard(a: AutomationDto, now: Instant, onClick: () -> Unit) {
    val c = DashTheme.colors
    QuietCard(Modifier.fillMaxWidth().testTag("automation_card"), onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                a.name,
                style = MaterialTheme.typography.titleMedium,
                color = c.ink,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
            Spacer(Modifier.width(Spacing.sm))
            StatusBadge(AutomationLabels.state(a.state), Modifier.testTag("automation_state"))
        }
        Spacer(Modifier.height(Spacing.xs))
        Text(AutomationLabels.schedule(a.schedule), style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        Spacer(Modifier.height(Spacing.xs))
        Text(timingLine(a, now), style = MaterialTheme.typography.bodySmall, color = c.inkTertiary)
    }
}

private fun timingLine(a: AutomationDto, now: Instant): String {
    val next = a.nextRunAt?.let { "Next: ${AutomationLabels.formatWhen(it, now)}" }
        ?: when (a.status) {
            "paused" -> "Paused"
            "completed" -> "Finished"
            else -> null
        }
    val last = a.lastRun?.let { "Last: ${AutomationLabels.formatWhen(it.createdAt, now)}" }
    return listOfNotNull(next, last).joinToString(" · ").ifEmpty { "Not run yet" }
}

// ---- Detail -------------------------------------------------------------------------------------

@Composable
fun AutomationDetailScreen(
    services: AppServices,
    automationId: String,
    onBack: () -> Unit,
    onEdit: () -> Unit,
    onOpenRun: (String) -> Unit,
) {
    val vm = dashViewModel { AutomationDetailViewModel(services, automationId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var confirmDelete by remember { mutableStateOf(false) }
    val running = state.automation?.state == "running"
    LaunchedEffect(Unit) { vm.load() }
    LaunchedEffect(running) {
        if (running) repeat(RUNNING_POLL_LIMIT) {
            delay(RUNNING_POLL_MS)
            vm.load()
        }
    }
    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }
    val c = DashTheme.colors
    val now = services.nowInstant()
    val a = state.automation
    Scaffold(
        containerColor = c.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DashTopBar(a?.name ?: "Automation", onBack = onBack, actions = {
                if (a != null) IconButton(onClick = onEdit, modifier = Modifier.testTag("automation_edit")) {
                    Icon(Icons.Rounded.Edit, contentDescription = "Edit automation", tint = c.ink)
                }
            })
        },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("automation_detail"),
                contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, bottom = Spacing.xxl),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                when {
                    state.loading && a == null -> item { LoadingState("Loading…") }
                    a == null -> item { ErrorState("Couldn't load this automation", state.error ?: "Try again.", onRetry = vm::load) }
                    else -> {
                        item { SummaryCard(a, now, state.busy, onRun = vm::runNow, onPause = vm::pause, onResume = vm::resume, onDelete = { confirmDelete = true }) }
                        item {
                            Text(
                                "Results",
                                style = MaterialTheme.typography.titleMedium,
                                color = c.ink,
                                modifier = Modifier.padding(top = Spacing.sm).semantics { heading() },
                            )
                        }
                        if (state.runs.isEmpty()) {
                            item {
                                Text(
                                    "Nothing yet. Results appear here after each run; use Run now to try it.",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = c.inkSecondary,
                                    modifier = Modifier.testTag("automation_no_runs"),
                                )
                            }
                        }
                        items(state.runs, key = { it.id }) { run -> RunRow(run, now, onClick = { onOpenRun(run.id) }) }
                    }
                }
            }
        }
    }
    if (confirmDelete && a != null) {
        ConfirmDialog(
            title = "Delete ${a.name}?",
            text = "The automation and all of its results are removed. This can't be undone.",
            confirmLabel = "Delete",
            destructive = true,
            onConfirm = {
                confirmDelete = false
                vm.delete(onBack)
            },
            onDismiss = { confirmDelete = false },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SummaryCard(
    a: AutomationDto,
    now: Instant,
    busy: Boolean,
    onRun: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = DashTheme.colors
    val mode = AssistantMode.fromWire(a.mode)?.label ?: "General"
    QuietCard(Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            StatusBadge(AutomationLabels.state(a.state), Modifier.testTag("automation_detail_state"))
            Text(mode, style = MaterialTheme.typography.labelMedium, color = c.inkTertiary)
        }
        Spacer(Modifier.height(Spacing.md))
        Text("${AutomationLabels.schedule(a.schedule)} · ${a.timeZone}", style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary)
        Spacer(Modifier.height(Spacing.xs))
        Text(
            "Next run: " + (a.nextRunAt?.let { AutomationLabels.formatWhen(it, now) } ?: if (a.status == "paused") "paused" else "none"),
            style = MaterialTheme.typography.bodySmall,
            color = c.ink,
            modifier = Modifier.testTag("automation_next_run"),
        )
        Text(
            "Last run: " + (a.lastRun?.let { AutomationLabels.formatWhen(it.createdAt, now) } ?: "not yet"),
            style = MaterialTheme.typography.bodySmall,
            color = c.ink,
            modifier = Modifier.testTag("automation_last_run"),
        )
        Spacer(Modifier.height(Spacing.md))
        Text(a.prompt, style = MaterialTheme.typography.bodyLarge, color = c.inkSecondary, maxLines = 6, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(Spacing.lg))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            PrimaryButton(
                if (a.state == "running") "Running…" else "Run now",
                onRun,
                icon = Icons.Rounded.PlayArrow,
                enabled = a.state != "running",
                loading = busy,
                modifier = Modifier.testTag("automation_run_now"),
            )
            when (a.status) {
                "active" -> SecondaryButton("Pause", onPause, icon = Icons.Rounded.Pause, enabled = !busy, modifier = Modifier.testTag("automation_pause"))
                "paused" -> SecondaryButton("Resume", onResume, icon = Icons.Rounded.PlayArrow, enabled = !busy, modifier = Modifier.testTag("automation_resume"))
            }
            SecondaryButton("Delete", onDelete, destructive = true, enabled = !busy, modifier = Modifier.testTag("automation_delete"))
        }
    }
}

@Composable
private fun RunRow(run: AutomationRunSummaryDto, now: Instant, onClick: () -> Unit) {
    val c = DashTheme.colors
    val finished = run.status == "ready" || run.status == "failed"
    QuietCard(Modifier.fillMaxWidth().testTag("automation_run"), onClick = if (run.status == "ready") onClick else null) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "${AutomationLabels.formatWhen(run.createdAt, now)} · ${AutomationLabels.trigger(run.trigger)}",
                style = MaterialTheme.typography.labelMedium,
                color = c.inkTertiary,
                modifier = Modifier.weight(1f),
            )
            StatusBadge(AutomationLabels.runStatus(run.status))
        }
        val line = when {
            run.status == "failed" -> run.error ?: "DASH AI couldn't complete this run."
            !finished -> "DASH AI is working on this. You can leave; the result will be saved here."
            else -> run.preview.ifBlank { "Open to view the result." }
        }
        Spacer(Modifier.height(Spacing.xs))
        Text(line, style = MaterialTheme.typography.bodyMedium, color = if (run.status == "failed") c.error else c.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (run.editedAt != null) Text("Edited", style = MaterialTheme.typography.labelSmall, color = c.inkTertiary)
    }
}

// ---- Editor -------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AutomationEditorScreen(services: AppServices, automationId: String?, onBack: () -> Unit, onSaved: (String) -> Unit) {
    val vm = dashViewModel { AutomationEditorViewModel(services, automationId) }
    val state by vm.state.collectAsStateWithLifecycle()
    var pickingZone by remember { mutableStateOf(false) }
    val c = DashTheme.colors
    val d = state.draft
    Scaffold(
        containerColor = c.background,
        topBar = { DashTopBar(if (automationId == null) "New automation" else "Edit automation", onBack = onBack) },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            if (state.loading) {
                LoadingState("Loading…")
                return@ContentWidth
            }
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter)
                    .navigationBarsPadding()
                    .testTag("automation_editor"),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                DashTextField(d.name, { v -> vm.edit { it.copy(name = v.take(AutomationDraft.MAX_NAME)) } }, "Name", Modifier.testTag("automation_name"))
                DashTextField(
                    d.prompt,
                    { v -> vm.edit { it.copy(prompt = v.take(AutomationDraft.MAX_PROMPT)) } },
                    "What should DASH AI do?",
                    Modifier.heightIn(min = 140.dp).testTag("automation_prompt"),
                    singleLine = false,
                    supporting = "Write it as you would in chat. DASH AI won't be able to ask you questions when it runs.",
                )
                FieldLabel("Mode")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    AssistantMode.entries.forEach { m ->
                        Pill(m.label, selected = d.mode == m, tag = "automation_mode_${m.wire}") { vm.edit { it.copy(mode = m) } }
                    }
                }
                FieldLabel("Repeat")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    RepeatKind.entries.forEach { r ->
                        Pill(r.label, selected = d.repeat == r, tag = "automation_repeat_${r.wire}") { vm.edit { it.copy(repeat = r) } }
                    }
                }
                when (d.repeat) {
                    RepeatKind.WEEKLY -> FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        // Monday first, as people read a week.
                        listOf(1, 2, 3, 4, 5, 6, 0).forEach { day ->
                            Pill(AutomationLabels.dayShort(day), selected = day in d.days, tag = "automation_day_$day") {
                                vm.edit { it.copy(days = if (day in it.days) it.days - day else it.days + day) }
                            }
                        }
                    }
                    RepeatKind.MONTHLY -> DashTextField(
                        d.dayOfMonth.toString(),
                        { v -> v.filter(Char::isDigit).take(2).toIntOrNull()?.let { n -> vm.edit { it.copy(dayOfMonth = n) } } },
                        "Day of the month",
                        Modifier.testTag("automation_day_of_month"),
                        supporting = "Days 29 to 31 run on the last day of shorter months.",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    )
                    RepeatKind.ONCE -> DashTextField(
                        d.date,
                        { v -> vm.edit { it.copy(date = v.take(10)) } },
                        "Date (YYYY-MM-DD)",
                        Modifier.testTag("automation_date"),
                    )
                    RepeatKind.DAILY -> Unit
                }
                DashTextField(
                    d.time,
                    { v -> vm.edit { it.copy(time = v.take(5)) } },
                    "Time (24-hour, HH:MM)",
                    Modifier.testTag("automation_time"),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                FieldLabel("Time zone")
                SecondaryButton(d.timeZone, { pickingZone = true }, modifier = Modifier.fillMaxWidth().testTag("automation_zone"))
                Text(
                    "The time is kept in this zone, including daylight-saving changes.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkSecondary,
                )
                state.error?.let { Notice(it, tone = StatusTone.ERROR, modifier = Modifier.testTag("automation_error")) }
                PrimaryButton(
                    if (automationId == null) "Create automation" else "Save changes",
                    { vm.save(onSaved) },
                    loading = state.saving,
                    modifier = Modifier.fillMaxWidth().testTag("automation_save"),
                )
                Spacer(Modifier.height(Spacing.lg))
            }
        }
    }
    if (pickingZone) {
        ZonePicker(current = d.timeZone, onPick = { zone ->
            vm.edit { it.copy(timeZone = zone) }
            pickingZone = false
        }, onDismiss = { pickingZone = false })
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = DashTheme.colors.inkSecondary, modifier = Modifier.padding(top = Spacing.xs))
}

@Composable
private fun Pill(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    val c = DashTheme.colors
    Surface(
        onClick = onClick,
        shape = Radii.pill,
        color = if (selected) c.accentContainer else c.surface,
        border = BorderStroke(1.dp, if (selected) c.accent else c.outline),
        modifier = Modifier.heightIn(min = 40.dp).semantics { this.selected = selected }.testTag(tag),
    ) {
        Box(Modifier.padding(horizontal = Spacing.lg, vertical = Spacing.sm), contentAlignment = Alignment.Center) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) c.ink else c.inkSecondary)
        }
    }
}

@Composable
private fun ZonePicker(current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val c = DashTheme.colors
    var query by remember { mutableStateOf("") }
    val all = remember(current) { AutomationDraft.zoneOptions(current) }
    val shown = remember(query, all) {
        val q = query.trim().replace(' ', '_')
        (if (q.isEmpty()) all else all.filter { it.contains(q, ignoreCase = true) }).take(80)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        title = { Text("Time zone", color = c.ink) },
        text = {
            Column {
                DashTextField(query, { query = it }, "Search, for example Lagos", Modifier.testTag("zone_search"))
                Spacer(Modifier.height(Spacing.sm))
                LazyColumn(Modifier.heightIn(max = 320.dp)) {
                    items(shown, key = { it }) { zone ->
                        Text(
                            zone.replace('_', ' '),
                            style = MaterialTheme.typography.bodyLarge,
                            color = if (zone == current) c.accentInk else c.ink,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(Radii.sm)
                                .clickable(role = Role.Button) { onPick(zone) }
                                .padding(vertical = Spacing.md, horizontal = Spacing.sm)
                                .testTag("zone_option"),
                        )
                    }
                }
            }
        },
        confirmButton = { TextAction("Cancel", onDismiss) },
    )
}

// ---- Result -------------------------------------------------------------------------------------

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AutomationRunScreen(
    services: AppServices,
    automationId: String,
    runId: String,
    onBack: () -> Unit,
    onRegenerated: () -> Unit,
) {
    val vm = dashViewModel { AutomationRunViewModel(services, automationId, runId) }
    val state by vm.state.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    val clipboard = LocalClipboardManager.current
    val context = LocalContext.current
    val run = state.run
    val downloader = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        val content = vm.state.value.run?.content
        if (uri != null && content != null) {
            val ok = runCatching {
                context.contentResolver.openOutputStream(uri)?.use { it.write(content.toByteArray(Charsets.UTF_8)) } != null
            }.getOrDefault(false)
            vm.notice(if (ok) "Saved." else "Couldn't save the file.")
        }
    }
    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }
    val c = DashTheme.colors
    Scaffold(
        containerColor = c.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { DashTopBar(state.name.ifEmpty { "Result" }, onBack = onBack) },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.gutter)
                    .navigationBarsPadding()
                    .testTag("automation_result"),
                verticalArrangement = Arrangement.spacedBy(Spacing.md),
            ) {
                when {
                    state.loading -> LoadingState("Loading result…")
                    run == null -> ErrorState("Couldn't load this result", state.error ?: "Try again.", onRetry = vm::load)
                    else -> {
                        val meta = listOfNotNull(
                            AutomationLabels.formatWhen(run.createdAt, services.nowInstant()),
                            if (run.demo) "Demonstration by DASH AI (simulated)" else null,
                            if (run.editedAt != null) "Edited" else null,
                        ).joinToString(" · ")
                        Text(meta, style = MaterialTheme.typography.bodySmall, color = c.inkSecondary)
                        if (run.status != "ready") {
                            Notice(
                                if (run.status == "failed") run.error ?: "DASH AI couldn't complete this run." else "DASH AI is still working on this.",
                                tone = if (run.status == "failed") StatusTone.ERROR else StatusTone.NEUTRAL,
                            )
                        }
                        val editing = state.editing
                        if (editing != null) {
                            DashTextField(
                                editing,
                                vm::changeEdit,
                                "Result",
                                Modifier.heightIn(min = 240.dp).testTag("automation_result_editor"),
                                singleLine = false,
                            )
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                                PrimaryButton("Save", vm::saveEdit, loading = state.busy, modifier = Modifier.testTag("automation_result_save"))
                                SecondaryButton("Cancel", vm::cancelEdit, enabled = !state.busy)
                            }
                        } else if (run.status == "ready") {
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                                SecondaryButton("Edit", vm::startEditing, icon = Icons.Rounded.Edit, modifier = Modifier.testTag("result_edit"))
                                SecondaryButton(
                                    "Regenerate",
                                    { vm.regenerate(onRegenerated) },
                                    icon = Icons.Rounded.Refresh,
                                    enabled = !state.busy,
                                    modifier = Modifier.testTag("result_regenerate"),
                                )
                                SecondaryButton("Copy", {
                                    clipboard.setText(AnnotatedString(run.content))
                                    vm.notice("Copied.")
                                }, icon = Icons.Rounded.ContentCopy, modifier = Modifier.testTag("result_copy"))
                                SecondaryButton(
                                    "Download",
                                    { downloader.launch(AutomationLabels.downloadName(state.name, run.createdAt)) },
                                    icon = Icons.Rounded.Download,
                                    modifier = Modifier.testTag("result_download"),
                                )
                                SecondaryButton(
                                    "Share",
                                    { shareText(context, run.content) },
                                    icon = Icons.Rounded.Share,
                                    modifier = Modifier.testTag("result_share"),
                                )
                            }
                            QuietCard(Modifier.fillMaxWidth().semantics { contentDescription = "Result" }) {
                                MarkdownView(run.content, onCopied = { vm.notice("Copied.") })
                            }
                        }
                        Spacer(Modifier.height(Spacing.lg))
                    }
                }
            }
        }
    }
}

/** A small count on navigation entries (unread Automates results). */
@Composable
fun CountBadge(count: Int, modifier: Modifier = Modifier) {
    if (count <= 0) return
    val c = DashTheme.colors
    Box(
        modifier
            .heightIn(min = 20.dp)
            .clip(CircleShape)
            .background(c.accent)
            .padding(horizontal = 6.dp)
            .semantics { contentDescription = "$count new" },
        contentAlignment = Alignment.Center,
    ) {
        Text(if (count > 99) "99+" else count.toString(), style = MaterialTheme.typography.labelSmall, color = c.onAccent)
    }
}
