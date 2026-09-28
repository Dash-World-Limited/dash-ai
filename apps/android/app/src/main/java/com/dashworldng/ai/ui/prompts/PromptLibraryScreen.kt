package com.dashworldng.ai.ui.prompts

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.ArrowDropDown
import androidx.compose.material.icons.rounded.Bookmarks
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.prompts.PromptCategory
import com.dashworldng.ai.core.prompts.PromptFilter
import com.dashworldng.ai.core.prompts.PromptItem
import com.dashworldng.ai.core.prompts.PromptLibrary
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.di.ComposerPrefill
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class PromptEditorState(
    val id: String? = null,
    val title: String = "",
    val body: String = "",
    val category: PromptCategory = PromptCategory.PRODUCTIVITY,
    val error: String? = null,
)

data class PromptLibraryUiState(
    val prompts: List<PromptItem> = emptyList(),
    val favorites: Set<String> = emptySet(),
    val filter: PromptFilter = PromptFilter.All,
    val query: String = "",
    val editor: PromptEditorState? = null,
)

class PromptLibraryViewModel(private val services: AppServices) : ViewModel() {
    private val filter = MutableStateFlow<PromptFilter>(PromptFilter.All)
    private val query = MutableStateFlow("")
    private val editor = MutableStateFlow<PromptEditorState?>(null)

    val state: StateFlow<PromptLibraryUiState> = combine(
        services.prompts.observeCustomPrompts(),
        services.prompts.observeFavoriteIds(),
        filter,
        query,
        editor,
    ) { custom, favorites, f, q, e ->
        PromptLibraryUiState(PromptLibrary.filter(PromptLibrary.starters + custom, favorites, f, q), favorites, f, q, e)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, PromptLibraryUiState())

    fun setFilter(value: PromptFilter) {
        filter.value = value
    }

    fun setQuery(value: String) {
        query.value = value
    }

    fun toggleFavorite(prompt: PromptItem) {
        viewModelScope.launch { services.prompts.setFavorite(prompt.id, prompt.id !in state.value.favorites) }
    }

    /** Puts the prompt in the chat composer and switches to the matching mode. */
    fun use(prompt: PromptItem) = services.prefill.post(ComposerPrefill(text = prompt.body, mode = prompt.category.mode))

    fun startNew() {
        editor.value = PromptEditorState()
    }

    fun startEdit(prompt: PromptItem) {
        editor.value = PromptEditorState(prompt.id, prompt.title, prompt.body, prompt.category)
    }

    fun updateEditor(change: (PromptEditorState) -> PromptEditorState) = editor.update { it?.let(change)?.copy(error = null) }

    fun closeEditor() {
        editor.value = null
    }

    fun save() {
        val e = editor.value ?: return
        val error = PromptLibrary.validate(e.title, e.body)
        if (error != null) {
            editor.value = e.copy(error = error)
            return
        }
        viewModelScope.launch {
            services.prompts.upsertCustomPrompt(
                PromptItem(
                    id = e.id ?: "custom-${UUID.randomUUID()}",
                    title = e.title.trim(),
                    body = e.body.trim(),
                    category = e.category,
                    isCustom = true,
                    updatedAt = services.clock.now(),
                ),
            )
            editor.value = null
        }
    }

    fun delete(prompt: PromptItem) {
        viewModelScope.launch { services.prompts.deleteCustomPrompt(prompt.id) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptLibraryScreen(services: AppServices, onBack: () -> Unit, onUsePrompt: () -> Unit) {
    val vm = dashViewModel { PromptLibraryViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    var deleting by remember { mutableStateOf<PromptItem?>(null) }

    Scaffold(
        containerColor = DashColors.Black,
        topBar = {
            TopAppBar(
                title = { Text("Prompt library") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DashColors.Black),
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = vm::startNew,
                icon = { Icon(Icons.Rounded.Add, contentDescription = null) },
                text = { Text("New prompt") },
                containerColor = DashColors.Gold,
                contentColor = DashColors.Black,
                modifier = Modifier.testTag("new_prompt"),
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).testTag("prompt_library")) {
            OutlinedTextField(
                value = state.query,
                onValueChange = vm::setQuery,
                placeholder = { Text("Search prompts") },
                leadingIcon = { Icon(Icons.Rounded.Search, contentDescription = null) },
                singleLine = true,
                shape = RoundedCornerShape(14.dp),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("prompt_search"),
            )
            val filters = listOf(PromptFilter.All, PromptFilter.Favorites, PromptFilter.Mine) + PromptCategory.entries.map { PromptFilter.Category(it) }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                filters.forEach { f ->
                    FilterChip(
                        selected = state.filter == f,
                        onClick = { vm.setFilter(f) },
                        label = { Text(filterLabel(f)) },
                        colors = FilterChipDefaults.filterChipColors(
                            selectedContainerColor = DashColors.GoldContainer,
                            selectedLabelColor = DashColors.GoldLight,
                        ),
                    )
                }
            }
            if (state.prompts.isEmpty()) {
                EmptyState(
                    title = if (state.filter == PromptFilter.Favorites) "No favourites yet" else "No prompts found",
                    body = if (state.filter == PromptFilter.Favorites) "Tap the star on a prompt to save it here." else "Try another search or create your own prompt.",
                    icon = Icons.Rounded.Bookmarks,
                )
            }
            LazyColumn(
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(state.prompts, key = { it.id }) { prompt ->
                    PromptCard(
                        prompt = prompt,
                        favorite = prompt.id in state.favorites,
                        onUse = {
                            vm.use(prompt)
                            onUsePrompt()
                        },
                        onFavorite = { vm.toggleFavorite(prompt) },
                        onEdit = { vm.startEdit(prompt) },
                        onDelete = { deleting = prompt },
                    )
                }
            }
        }
    }

    state.editor?.let { editor ->
        PromptEditorDialog(editor, onChange = vm::updateEditor, onSave = vm::save, onDismiss = vm::closeEditor)
    }
    deleting?.let { prompt ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete prompt?") },
            text = { Text("“${prompt.title}” will be deleted.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(prompt)
                    deleting = null
                }) { Text("Delete", color = DashColors.Error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }
}

private fun filterLabel(filter: PromptFilter): String = when (filter) {
    PromptFilter.All -> "All"
    PromptFilter.Favorites -> "Favourites"
    PromptFilter.Mine -> "My prompts"
    is PromptFilter.Category -> filter.category.label
}

@Composable
private fun PromptCard(
    prompt: PromptItem,
    favorite: Boolean,
    onUse: () -> Unit,
    onFavorite: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = DashColors.Surface,
        border = BorderStroke(1.dp, DashColors.OutlineSoft),
        modifier = Modifier.testTag("prompt_card"),
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 14.dp, top = 10.dp, end = 4.dp, bottom = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(prompt.title, style = MaterialTheme.typography.titleSmall, color = DashColors.White)
                    Text(
                        if (prompt.isCustom) "${prompt.category.label} · My prompt" else prompt.category.label,
                        style = MaterialTheme.typography.labelSmall,
                        color = DashColors.Gold,
                    )
                }
                IconButton(onClick = onFavorite) {
                    Icon(
                        if (favorite) Icons.Rounded.Star else Icons.Rounded.StarBorder,
                        contentDescription = if (favorite) "Remove from favourites" else "Add to favourites",
                        tint = if (favorite) DashColors.Gold else DashColors.Grey,
                    )
                }
            }
            Text(
                prompt.body,
                style = MaterialTheme.typography.bodySmall,
                color = DashColors.Grey,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(end = 10.dp, top = 4.dp),
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onUse, modifier = Modifier.testTag("use_prompt")) { Text("Use prompt", color = DashColors.Gold) }
                Spacer(Modifier.weight(1f))
                if (prompt.isCustom) {
                    IconButton(onClick = onEdit) { Icon(Icons.Rounded.Edit, contentDescription = "Edit prompt", tint = DashColors.Grey) }
                    IconButton(onClick = onDelete) { Icon(Icons.Rounded.Delete, contentDescription = "Delete prompt", tint = DashColors.Grey) }
                }
            }
        }
    }
}

@Composable
private fun PromptEditorDialog(
    editor: PromptEditorState,
    onChange: ((PromptEditorState) -> PromptEditorState) -> Unit,
    onSave: () -> Unit,
    onDismiss: () -> Unit,
) {
    var categoryMenu by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (editor.id == null) "New prompt" else "Edit prompt") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = editor.title,
                    onValueChange = { v -> onChange { it.copy(title = v) } },
                    label = { Text("Title") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("prompt_title_input"),
                )
                Box {
                    OutlinedButton(onClick = { categoryMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(editor.category.label, modifier = Modifier.weight(1f))
                        Icon(Icons.Rounded.ArrowDropDown, contentDescription = "Choose category")
                    }
                    DropdownMenu(expanded = categoryMenu, onDismissRequest = { categoryMenu = false }) {
                        PromptCategory.entries.forEach { category ->
                            DropdownMenuItem(text = { Text(category.label) }, onClick = {
                                onChange { it.copy(category = category) }
                                categoryMenu = false
                            })
                        }
                    }
                }
                OutlinedTextField(
                    value = editor.body,
                    onValueChange = { v -> onChange { it.copy(body = v) } },
                    label = { Text("Prompt") },
                    minLines = 4,
                    maxLines = 8,
                    modifier = Modifier.fillMaxWidth().testTag("prompt_body_input"),
                )
                editor.error?.let { Text(it, color = DashColors.Error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = { TextButton(onClick = onSave, modifier = Modifier.testTag("save_prompt")) { Text("Save", color = DashColors.Gold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = DashColors.SurfaceHigh,
    )
}
