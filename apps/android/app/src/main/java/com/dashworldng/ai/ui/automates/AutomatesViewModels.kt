package com.dashworldng.ai.ui.automates

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.automations.AutomationsApi
import com.dashworldng.ai.core.presentation.AutomationDraft
import com.dashworldng.ai.core.remote.AppNotificationDto
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationRunDto
import com.dashworldng.ai.core.remote.AutomationRunSummaryDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.di.AppServices
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant

private const val INVALID_SERVER = "The server address is not valid. Check it in Settings."

/** Automates run on the server for an account: Demo Mode and signed-out users have none. */
internal fun AppServices.automatesSignedIn(): Boolean {
    val s = settings.settings.value
    return !s.demoMode && s.account?.isDemo == false
}

/** Runs [block], turning API failures into a user-safe message. */
private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: ApiException) {
    Result.failure(e)
}

internal val Throwable.userMessage: String get() = (this as? ApiException)?.error?.message ?: "Something went wrong. Try again."

// ---- List ---------------------------------------------------------------------------------------

data class AutomatesListState(
    val signedIn: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    val automations: List<AutomationDto> = emptyList(),
    val notices: List<AppNotificationDto> = emptyList(),
)

class AutomatesListViewModel(private val services: AppServices) : ViewModel() {
    private val _state = MutableStateFlow(AutomatesListState(signedIn = services.automatesSignedIn(), loading = services.automatesSignedIn()))
    val state: StateFlow<AutomatesListState> = _state.asStateFlow()

    /** Called whenever the screen is shown (and again while something is running). */
    fun load(quiet: Boolean = false) {
        if (!_state.value.signedIn) return
        val api = services.automations() ?: return _state.update { it.copy(error = INVALID_SERVER) }
        if (!quiet) _state.update { it.copy(loading = it.automations.isEmpty(), error = null) }
        viewModelScope.launch {
            attempt { api.list() to services.notices.refresh(api) }
                .onSuccess { (automations, notices) ->
                    _state.update {
                        it.copy(loading = false, error = null, automations = automations, notices = notices.notifications.filter { n -> n.readAt == null })
                    }
                }
                .onFailure { e -> _state.update { it.copy(loading = false, error = if (quiet && it.automations.isNotEmpty()) it.error else e.userMessage) } }
        }
    }

    fun dismissNotices() {
        val api = services.automations() ?: return
        _state.update { it.copy(notices = emptyList()) }
        services.notices.clear()
        viewModelScope.launch { attempt { api.markRead() } }
    }
}

// ---- Editor -------------------------------------------------------------------------------------

data class AutomationEditorState(
    val loading: Boolean = false,
    val draft: AutomationDraft = AutomationDraft(),
    val original: AutomationDto? = null,
    val saving: Boolean = false,
    val error: String? = null,
)

class AutomationEditorViewModel(private val services: AppServices, private val id: String?) : ViewModel() {
    private val _state = MutableStateFlow(AutomationEditorState(draft = AutomationDraft.new(now()), loading = id != null))
    val state: StateFlow<AutomationEditorState> = _state.asStateFlow()

    private fun now(): Instant = Instant.ofEpochMilli(services.clock.now())

    init {
        if (id != null) load(id)
    }

    private fun load(id: String) {
        val api = services.automations() ?: return _state.update { it.copy(loading = false, error = INVALID_SERVER) }
        viewModelScope.launch {
            attempt { api.detail(id).automation }
                .onSuccess { a -> _state.update { it.copy(loading = false, original = a, draft = AutomationDraft.from(a, now())) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.userMessage) } }
        }
    }

    fun edit(change: (AutomationDraft) -> AutomationDraft) = _state.update { it.copy(draft = change(it.draft), error = null) }

    fun save(onSaved: (String) -> Unit) {
        val s = _state.value
        if (s.saving) return
        s.draft.problem(now())?.let { problem -> return _state.update { it.copy(error = problem) } }
        val api = services.automations() ?: return _state.update { it.copy(error = INVALID_SERVER) }
        _state.update { it.copy(saving = true, error = null) }
        viewModelScope.launch {
            attempt {
                val original = s.original
                if (original == null) api.create(s.draft.toCreate()) else api.update(original.id, s.draft.toUpdate(original))
            }
                .onSuccess { saved ->
                    _state.update { it.copy(saving = false) }
                    onSaved(saved.id)
                }
                .onFailure { e -> _state.update { it.copy(saving = false, error = e.userMessage) } }
        }
    }
}

// ---- Detail -------------------------------------------------------------------------------------

data class AutomationDetailState(
    val loading: Boolean = true,
    val error: String? = null,
    val automation: AutomationDto? = null,
    val runs: List<AutomationRunSummaryDto> = emptyList(),
    val busy: Boolean = false,
    val notice: String? = null,
)

class AutomationDetailViewModel(private val services: AppServices, private val id: String) : ViewModel() {
    private val _state = MutableStateFlow(AutomationDetailState())
    val state: StateFlow<AutomationDetailState> = _state.asStateFlow()

    /** Called whenever the screen is shown (and again while a run is in progress). */
    fun load() {
        val api = services.automations() ?: return _state.update { it.copy(loading = false, error = INVALID_SERVER) }
        viewModelScope.launch {
            attempt { api.detail(id) }
                .onSuccess { d -> _state.update { it.copy(loading = false, error = null, automation = d.automation, runs = d.runs) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = if (it.automation == null) e.userMessage else it.error, notice = if (it.automation != null) e.userMessage else null) } }
        }
    }

    private fun act(success: String?, block: suspend (AutomationsApi) -> Unit, then: () -> Unit = ::load) {
        val api = services.automations() ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            attempt { block(api) }
                .onSuccess {
                    _state.update { it.copy(busy = false, notice = success) }
                    then()
                }
                .onFailure { e -> _state.update { it.copy(busy = false, notice = e.userMessage) } }
        }
    }

    fun runNow() = act("Running now. The result will appear here.", { it.runNow(id) })

    fun pause() = act("Paused. It won't run until you resume it.", { it.pause(id) })

    fun resume() = act("Resumed.", { it.resume(id) })

    fun delete(onDeleted: () -> Unit) = act(null, { it.delete(id) }, then = onDeleted)

    fun clearNotice() = _state.update { it.copy(notice = null) }
}

// ---- Result -------------------------------------------------------------------------------------

data class AutomationRunState(
    val loading: Boolean = true,
    val error: String? = null,
    val name: String = "",
    val run: AutomationRunDto? = null,
    val editing: String? = null,
    val busy: Boolean = false,
    val notice: String? = null,
)

class AutomationRunViewModel(private val services: AppServices, private val id: String, private val runId: String) : ViewModel() {
    private val _state = MutableStateFlow(AutomationRunState())
    val state: StateFlow<AutomationRunState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        val api = services.automations() ?: return _state.update { it.copy(loading = false, error = INVALID_SERVER) }
        viewModelScope.launch {
            attempt { api.detail(id).automation.name to api.run(id, runId) }
                .onSuccess { (name, run) -> _state.update { it.copy(loading = false, error = null, name = name, run = run) } }
                .onFailure { e -> _state.update { it.copy(loading = false, error = e.userMessage) } }
            // Opening a result reads its notice.
            attempt {
                val notices = api.notifications()
                val ids = notices.notifications.filter { it.runId == runId && it.readAt == null }.map { it.id }
                if (ids.isNotEmpty()) api.markRead(ids)
                services.notices.set(notices.unread - ids.size)
            }
        }
    }

    fun startEditing() = _state.update { it.copy(editing = it.run?.content) }

    fun changeEdit(text: String) = _state.update { it.copy(editing = text) }

    fun cancelEdit() = _state.update { it.copy(editing = null) }

    fun saveEdit() {
        val text = _state.value.editing ?: return
        if (text.isBlank()) return _state.update { it.copy(notice = "The result can't be empty.") }
        val api = services.automations() ?: return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            attempt { api.editRun(id, runId, text) }
                .onSuccess { run -> _state.update { it.copy(busy = false, run = run, editing = null, notice = "Saved your changes.") } }
                .onFailure { e -> _state.update { it.copy(busy = false, notice = e.userMessage) } }
        }
    }

    /** Starts a fresh run of the automation; the caller opens the automation to watch it. */
    fun regenerate(onStarted: () -> Unit) {
        val api = services.automations() ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true) }
        viewModelScope.launch {
            attempt { api.regenerate(id, runId) }
                .onSuccess {
                    _state.update { it.copy(busy = false) }
                    onStarted()
                }
                .onFailure { e -> _state.update { it.copy(busy = false, notice = e.userMessage) } }
        }
    }

    fun notice(text: String) = _state.update { it.copy(notice = text) }

    fun clearNotice() = _state.update { it.copy(notice = null) }
}
