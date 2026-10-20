package com.dashworldng.ai.ui.documents

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.automirrored.rounded.Article
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.PictureAsPdf
import androidx.compose.material.icons.rounded.QuestionAnswer
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.documents.DocumentRemoval
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.presentation.DocumentFilter
import com.dashworldng.ai.core.presentation.Documents
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.di.ComposerPrefill
import com.dashworldng.ai.ui.chat.PendingAttachment
import com.dashworldng.ai.ui.components.ConfirmDialog
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.DashTopBar
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.components.LoadingState
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.QuietCard
import com.dashworldng.ai.ui.components.SecondaryButton
import com.dashworldng.ai.ui.components.SectionHeader
import com.dashworldng.ai.ui.components.StatusBadge
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import java.util.UUID

data class DocumentsUiState(
    val loaded: Boolean = false,
    val documents: List<DocumentItem> = emptyList(),
    val uploads: List<PendingAttachment> = emptyList(),
    val demoMode: Boolean = true,
    val notice: String? = null,
)

class DocumentsViewModel(private val services: AppServices) : ViewModel() {
    private val uploads = MutableStateFlow<List<PendingAttachment>>(emptyList())
    private val notice = MutableStateFlow<String?>(null)

    val state: StateFlow<DocumentsUiState> = combine(
        services.documents.observeDocuments(),
        uploads,
        services.settings.settings,
        notice,
    ) { docs, pending, settings, message ->
        DocumentsUiState(true, docs, pending, settings.demoMode, message)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, DocumentsUiState())

    /** Uploads through the real gateway (the server in live mode; on-device checks only in Demo Mode). */
    fun upload(source: UploadSource) {
        val id = UUID.randomUUID().toString()
        uploads.update { it + PendingAttachment(id, source.name, source.sizeBytes) }
        viewModelScope.launch {
            try {
                val doc = services.documentGateway().upload(source) { p ->
                    uploads.update { list -> list.map { if (it.localId == id) it.copy(progress = p) else it } }
                }
                services.documents.upsert(doc)
                uploads.update { list -> list.filterNot { it.localId == id } }
                notice.value = when (doc.status) {
                    DocumentStatus.UNSUPPORTED -> "“${doc.name}” was added but can't be read: ${doc.statusDetail}"
                    DocumentStatus.FAILED -> "“${doc.name}” failed: ${doc.statusDetail}"
                    else -> "“${doc.name}” is ready"
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                uploads.update { list -> list.map { if (it.localId == id) it.copy(error = e.error.message) else it } }
            } catch (e: Exception) {
                uploads.update { list -> list.map { if (it.localId == id) it.copy(error = "The file could not be read.") else it } }
            }
        }
    }

    fun dismissUpload(id: String) = uploads.update { list -> list.filterNot { it.localId == id } }

    fun delete(doc: DocumentItem) {
        viewModelScope.launch {
            val outcome = DocumentRemoval.remove(
                document = doc,
                demoMode = services.settings.settings.value.demoMode,
                server = services::documentGateway,
                deleteLocal = services.documents::delete,
            )
            notice.value = when (outcome) {
                DocumentRemoval.Removed -> "Document removed"
                is DocumentRemoval.Failed -> outcome.message
            }
        }
    }

    /** Opens a new chat with the document attached and [text] in the composer; nothing is sent until the user does. */
    fun ask(doc: DocumentItem, text: String = "") = services.prefill.post(
        ComposerPrefill(text = text, mode = AssistantMode.DOCUMENTS, documents = listOf(doc), newChat = true),
    )

    fun clearNotice() {
        notice.value = null
    }
}

fun DocumentKind.icon(): ImageVector = when (this) {
    DocumentKind.PDF -> Icons.Rounded.PictureAsPdf
    DocumentKind.DOCX -> Icons.AutoMirrored.Rounded.Article
    DocumentKind.TXT -> Icons.Rounded.Description
    DocumentKind.IMAGE -> Icons.Rounded.Image
}

@Composable
fun DocumentsScreen(services: AppServices, onBack: () -> Unit, onOpenDocument: (String) -> Unit) {
    val vm = dashViewModel { DocumentsViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) runCatching { DocumentReader.read(context, uri) }.onSuccess(vm::upload)
    }
    DocumentsContent(
        state = state,
        onBack = onBack,
        onAdd = { picker.launch(com.dashworldng.ai.core.documents.FileRules.pickerMimeTypes) },
        onOpen = onOpenDocument,
        onDismissUpload = vm::dismissUpload,
        onNoticeShown = vm::clearNotice,
    )
}

@Composable
fun DocumentsContent(
    state: DocumentsUiState,
    onBack: () -> Unit,
    onAdd: () -> Unit,
    onOpen: (String) -> Unit,
    onDismissUpload: (String) -> Unit,
    onNoticeShown: () -> Unit,
) {
    val c = DashTheme.colors
    val snackbar = remember { SnackbarHostState() }
    var query by rememberSaveable { mutableStateOf("") }
    var filter by rememberSaveable { mutableStateOf(DocumentFilter.ALL) }
    val filters = remember(state.documents) { Documents.filtersFor(state.documents) }
    val effectiveFilter = if (filter in filters) filter else DocumentFilter.ALL
    val visible = remember(state.documents, effectiveFilter, query) { Documents.filter(state.documents, effectiveFilter, query) }

    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            onNoticeShown()
        }
    }

    Scaffold(
        containerColor = c.background,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            DashTopBar("Documents", onBack = onBack, actions = {
                IconButton(onClick = onAdd, modifier = Modifier.testTag("choose_file")) {
                    Icon(Icons.Rounded.Add, contentDescription = "Add document")
                }
            })
        },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            LazyColumn(
                Modifier.fillMaxSize().testTag("documents_screen"),
                contentPadding = PaddingValues(start = Spacing.gutter, end = Spacing.gutter, bottom = Spacing.xxl),
                verticalArrangement = Arrangement.spacedBy(Spacing.sm),
            ) {
                item {
                    Text(
                        if (state.demoMode) {
                            "Demo Mode checks files on this device only. Their contents are not uploaded or read."
                        } else {
                            "PDF (with text), Word and text files are read by the DASH AI server so you can ask about them."
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = c.inkSecondary,
                        modifier = Modifier.padding(bottom = Spacing.sm),
                    )
                }
                if (state.documents.isNotEmpty()) {
                    item {
                        DashTextField(
                            value = query,
                            onValueChange = { query = it },
                            label = "Search documents",
                            leading = { Icon(Icons.Rounded.Search, contentDescription = null, tint = c.inkTertiary) },
                            trailing = if (query.isNotEmpty()) {
                                { IconButton(onClick = { query = "" }) { Icon(Icons.Rounded.Close, contentDescription = "Clear search", tint = c.inkTertiary) } }
                            } else {
                                null
                            },
                            modifier = Modifier.testTag("document_search"),
                        )
                    }
                }
                if (filters.isNotEmpty()) {
                    item {
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            filters.forEach { f ->
                                FilterChip(
                                    selected = f == effectiveFilter,
                                    onClick = { filter = f },
                                    label = { Text(f.label) },
                                    modifier = Modifier.testTag("filter_${f.name.lowercase()}"),
                                    colors = FilterChipDefaults.filterChipColors(
                                        containerColor = c.surface,
                                        labelColor = c.inkSecondary,
                                        selectedContainerColor = c.accentContainer,
                                        selectedLabelColor = c.ink,
                                    ),
                                    border = FilterChipDefaults.filterChipBorder(
                                        enabled = true,
                                        selected = f == effectiveFilter,
                                        borderColor = c.outline,
                                        selectedBorderColor = c.accentInk,
                                    ),
                                )
                            }
                        }
                    }
                }
                items(state.uploads, key = { it.localId }) { upload -> UploadRow(upload, onDismiss = { onDismissUpload(upload.localId) }) }
                when {
                    !state.loaded -> item { LoadingState("Loading documents…") }
                    state.documents.isEmpty() && state.uploads.isEmpty() -> item {
                        EmptyState(
                            icon = Icons.Rounded.FolderOpen,
                            title = "No documents yet",
                            message = "Add a PDF, Word or text file, then ask DASH AI about it.",
                            action = { PrimaryButton("Add document", onAdd, icon = Icons.Rounded.Add) },
                            modifier = Modifier.testTag("documents_empty"),
                        )
                    }
                    visible.isEmpty() -> item {
                        Text("No documents match.", style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, modifier = Modifier.padding(vertical = Spacing.xl))
                    }
                    else -> items(visible, key = { it.id }) { doc -> DocumentRow(doc, onClick = { onOpen(doc.id) }) }
                }
            }
        }
    }
}

@Composable
private fun DocumentRow(doc: DocumentItem, onClick: () -> Unit) {
    val c = DashTheme.colors
    QuietCard(onClick = onClick, modifier = Modifier.fillMaxWidth().testTag("document_card"), contentPadding = PaddingValues(Spacing.md)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            KindIcon(doc.kind)
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Text(doc.name, style = MaterialTheme.typography.titleSmall, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${doc.kind.label} · ${Documents.formatSize(doc.sizeBytes)} · ${DateFormat.getDateInstance(DateFormat.MEDIUM).format(Date(doc.createdAt))}",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkTertiary,
                    maxLines = 1,
                )
            }
            Spacer(Modifier.width(Spacing.sm))
            StatusBadge(Documents.status(doc))
        }
    }
}

@Composable
private fun KindIcon(kind: DocumentKind, size: androidx.compose.ui.unit.Dp = 40.dp) {
    val c = DashTheme.colors
    Box(Modifier.size(size).clip(Radii.md).background(c.surfaceMuted), contentAlignment = Alignment.Center) {
        Icon(kind.icon(), contentDescription = kind.label, tint = c.accentInk, modifier = Modifier.size(Sizing.icon))
    }
}

@Composable
private fun UploadRow(upload: PendingAttachment, onDismiss: () -> Unit) {
    val c = DashTheme.colors
    QuietCard(modifier = Modifier.fillMaxWidth().testTag("upload_progress"), contentPadding = PaddingValues(Spacing.md)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (upload.error == null) {
                CircularProgressIndicator(progress = { upload.progress }, modifier = Modifier.size(28.dp), strokeWidth = 2.5.dp, color = c.accent, trackColor = c.surfaceMuted)
            } else {
                Icon(Icons.Rounded.Close, contentDescription = null, tint = c.error)
            }
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Text(upload.name, style = MaterialTheme.typography.titleSmall, color = c.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    upload.error ?: "Uploading ${(upload.progress * 100).toInt()}%",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (upload.error != null) c.error else c.inkSecondary,
                )
            }
            if (upload.error != null) TextAction("Dismiss", onDismiss)
        }
    }
}

// ---- Detail --------------------------------------------------------------------------------------

@Composable
fun DocumentDetailScreen(services: AppServices, documentId: String, onBack: () -> Unit, onAsk: () -> Unit) {
    val vm = dashViewModel { DocumentsViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val doc = state.documents.firstOrNull { it.id == documentId }
    DocumentDetailContent(
        loaded = state.loaded,
        doc = doc,
        demoMode = state.demoMode,
        onBack = onBack,
        onAsk = { text ->
            doc?.let { vm.ask(it, text) }
            onAsk()
        },
        onDelete = {
            doc?.let(vm::delete)
            onBack()
        },
    )
}

@Composable
fun DocumentDetailContent(
    loaded: Boolean,
    doc: DocumentItem?,
    demoMode: Boolean,
    onBack: () -> Unit,
    onAsk: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val c = DashTheme.colors
    var deleting by remember { mutableStateOf(false) }
    Scaffold(
        containerColor = c.background,
        topBar = {
            DashTopBar(doc?.name ?: "Document", onBack = onBack, actions = {
                if (doc != null) {
                    IconButton(onClick = { deleting = true }, modifier = Modifier.testTag("document_delete")) {
                        Icon(Icons.Rounded.Delete, contentDescription = "Remove document")
                    }
                }
            })
        },
    ) { padding ->
        ContentWidth(Modifier.fillMaxSize().padding(padding)) {
            when {
                !loaded -> LoadingState("Loading document…")
                doc == null -> EmptyState(Icons.Rounded.FolderOpen, "Document not found", "It may have been removed on this device.")
                else -> Column(
                    Modifier
                        .fillMaxSize()
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = Spacing.gutter)
                        .navigationBarsPadding()
                        .testTag("document_detail"),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = Spacing.md)) {
                        KindIcon(doc.kind, 52.dp)
                        Spacer(Modifier.width(Spacing.lg))
                        Column(Modifier.weight(1f)) {
                            Text(doc.name, style = MaterialTheme.typography.titleLarge, color = c.ink, modifier = Modifier.semantics { heading() })
                            Spacer(Modifier.height(Spacing.xs))
                            StatusBadge(Documents.status(doc))
                        }
                    }
                    Spacer(Modifier.height(Spacing.lg))
                    val usable = Documents.usableInChat(doc, demoMode)
                    Notice(
                        doc.statusDetail,
                        tone = when (doc.status) {
                            DocumentStatus.READY -> StatusTone.SUCCESS
                            DocumentStatus.UNSUPPORTED -> StatusTone.WARNING
                            DocumentStatus.FAILED -> StatusTone.ERROR
                            else -> StatusTone.NEUTRAL
                        },
                        modifier = Modifier.testTag("document_status_detail"),
                    )
                    SectionHeader("Details")
                    QuietCard(Modifier.fillMaxWidth()) {
                        MetaRow("Type", doc.kind.label)
                        MetaRow("Size", Documents.formatSize(doc.sizeBytes))
                        MetaRow("Added", DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(doc.createdAt)))
                        doc.pageCount?.let { MetaRow("Pages", it.toString()) }
                        if (doc.extractedChars > 0) MetaRow("Text extracted", "%,d characters".format(doc.extractedChars))
                        MetaRow("Stored", if (doc.isDemo) "On this device only" else "On the DASH AI server")
                    }
                    Spacer(Modifier.height(Spacing.xl))
                    PrimaryButton(
                        "Ask about this document",
                        onClick = { onAsk("") },
                        enabled = usable,
                        icon = Icons.Rounded.QuestionAnswer,
                        modifier = Modifier.fillMaxWidth().testTag("document_ask"),
                    )
                    if (!usable) {
                        Text(
                            if (demoMode && !doc.isDemo) "This document belongs to your account. Sign in to use it." else "DASH AI can't read this document, so it can't be used in a chat.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.inkTertiary,
                            modifier = Modifier.padding(top = Spacing.sm),
                        )
                    } else {
                        SectionHeader("Suggestions")
                        Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            Documents.SUGGESTIONS.forEach { suggestion ->
                                SecondaryButton(suggestion, onClick = { onAsk(suggestion) }, modifier = Modifier.fillMaxWidth().testTag("document_suggestion"))
                            }
                        }
                        Text(
                            "Suggestions open a chat with the text ready; nothing is sent until you tap send.",
                            style = MaterialTheme.typography.bodySmall,
                            color = c.inkTertiary,
                            modifier = Modifier.padding(top = Spacing.sm),
                        )
                    }
                    Spacer(Modifier.height(Spacing.xxl))
                }
            }
        }
    }
    if (deleting && doc != null) {
        ConfirmDialog(
            title = "Remove this document?",
            text = if (doc.isDemo) "“${doc.name}” will be removed from this device." else "“${doc.name}” will be removed from this device and from the DASH AI server.",
            confirmLabel = "Remove",
            destructive = true,
            onConfirm = {
                deleting = false
                onDelete()
            },
            onDismiss = { deleting = false },
        )
    }
}

@Composable
private fun MetaRow(label: String, value: String) {
    val c = DashTheme.colors
    Row(Modifier.fillMaxWidth().heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = c.inkSecondary, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, color = c.ink)
    }
}

