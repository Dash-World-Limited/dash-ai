package com.dashworldng.ai.ui.documents

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Description
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.FolderOpen
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.PictureAsPdf
import androidx.compose.material.icons.rounded.UploadFile
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.documents.FileRules
import com.dashworldng.ai.core.documents.UploadSource
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.di.ComposerPrefill
import com.dashworldng.ai.ui.chat.ChatUiState
import com.dashworldng.ai.ui.chat.PendingAttachment
import com.dashworldng.ai.ui.components.Banner
import com.dashworldng.ai.ui.components.BannerTone
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.EmptyState
import com.dashworldng.ai.ui.components.GoldButton
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.util.UUID

data class DocumentsUiState(
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
        DocumentsUiState(docs, pending, settings.demoMode, message)
    }.stateIn(viewModelScope, SharingStarted.Eagerly, DocumentsUiState())

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
                notice.value = if (doc.status == DocumentStatus.UNSUPPORTED) doc.statusDetail else "“${doc.name}” is ready"
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
            if (!doc.isDemo && !services.settings.settings.value.demoMode) {
                runCatching { services.documentGateway().delete(doc) }
            }
            services.documents.delete(doc.id)
            notice.value = "Document removed"
        }
    }

    fun summarise(doc: DocumentItem) = services.prefill.post(
        ComposerPrefill(
            text = "Summarise this document: the key points, important dates or figures, and any actions required.",
            mode = AssistantMode.DOCUMENTS,
            documents = listOf(doc),
            sendNow = true,
            newChat = true,
        ),
    )

    fun ask(doc: DocumentItem) = services.prefill.post(
        ComposerPrefill(text = "", mode = AssistantMode.DOCUMENTS, documents = listOf(doc), newChat = true),
    )

    fun clearNotice() {
        notice.value = null
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DocumentsScreen(services: AppServices, onBack: () -> Unit, onOpenChat: () -> Unit) {
    val vm = dashViewModel { DocumentsViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val snackbar = remember { SnackbarHostState() }
    var deleting by remember { mutableStateOf<DocumentItem?>(null) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) runCatching { DocumentReader.read(context, uri) }.onSuccess(vm::upload)
    }

    LaunchedEffect(state.notice) {
        state.notice?.let {
            snackbar.showSnackbar(it)
            vm.clearNotice()
        }
    }

    Scaffold(
        containerColor = DashColors.Black,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("Documents") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DashColors.Black),
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding).testTag("documents_screen"),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Banner(
                        if (state.demoMode) {
                            "Demo Mode: files are checked on this device only. Their contents are never uploaded, read or analysed."
                        } else {
                            "Text is extracted on the Dash AI server from TXT, DOCX and text-based PDFs, and sent only to the provider you choose. Image and scanned-PDF analysis is not available yet."
                        },
                        icon = Icons.Rounded.Info,
                        tone = if (state.demoMode) BannerTone.WARNING else BannerTone.INFO,
                    )
                    Text(
                        "PDF, DOCX, TXT, PNG, JPG or WEBP · up to ${FileRules.formatSize(FileRules.MAX_UPLOAD_BYTES)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = DashColors.Grey,
                    )
                    GoldButton(
                        "Choose a file",
                        onClick = { picker.launch(FileRules.pickerMimeTypes) },
                        icon = Icons.Rounded.UploadFile,
                        modifier = Modifier.fillMaxWidth().testTag("choose_file"),
                    )
                }
            }
            items(state.uploads, key = { it.localId }) { upload -> UploadRow(upload, onDismiss = { vm.dismissUpload(upload.localId) }) }
            if (state.documents.isEmpty() && state.uploads.isEmpty()) {
                item { EmptyState("No documents yet", "Upload a file to summarise it or ask questions about it.", icon = Icons.Rounded.FolderOpen) }
            }
            items(state.documents, key = { it.id }) { doc ->
                val usable = ChatUiState.usableNow(doc, state.demoMode)
                DocumentCard(
                    doc = doc,
                    usable = usable,
                    onSummarise = {
                        vm.summarise(doc)
                        onOpenChat()
                    },
                    onAsk = {
                        vm.ask(doc)
                        onOpenChat()
                    },
                    onRemove = { deleting = doc },
                )
            }
        }
    }

    deleting?.let { doc ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Remove document?") },
            text = { Text("“${doc.name}” will be removed from this device${if (doc.isDemo) "" else " and from your Dash AI server"}.") },
            confirmButton = {
                TextButton(onClick = {
                    vm.delete(doc)
                    deleting = null
                }) { Text("Remove", color = DashColors.Error) }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }
}

@Composable
private fun UploadRow(upload: PendingAttachment, onDismiss: () -> Unit) {
    Surface(shape = RoundedCornerShape(14.dp), color = DashColors.Surface, border = BorderStroke(1.dp, DashColors.OutlineSoft)) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(upload.name, style = MaterialTheme.typography.titleSmall, color = DashColors.White, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (upload.error != null) TextButton(onClick = onDismiss) { Text("Dismiss", color = DashColors.Gold) }
            }
            if (upload.error != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.ErrorOutline, contentDescription = null, tint = DashColors.Error)
                    Spacer(Modifier.width(8.dp))
                    Text(upload.error, style = MaterialTheme.typography.bodySmall, color = DashColors.Error)
                }
            } else {
                LinearProgressIndicator(
                    progress = { upload.progress },
                    modifier = Modifier.fillMaxWidth().testTag("upload_progress"),
                    color = DashColors.Gold,
                    trackColor = DashColors.SurfaceHighest,
                )
                Text("Uploading ${(upload.progress * 100).toInt()}%", style = MaterialTheme.typography.labelSmall, color = DashColors.Grey)
            }
        }
    }
}

@Composable
private fun DocumentCard(doc: DocumentItem, usable: Boolean, onSummarise: () -> Unit, onAsk: () -> Unit, onRemove: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = DashColors.Surface,
        border = BorderStroke(1.dp, DashColors.OutlineSoft),
        modifier = Modifier.testTag("document_card"),
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    when (doc.kind) {
                        DocumentKind.PDF -> Icons.Rounded.PictureAsPdf
                        DocumentKind.IMAGE -> Icons.Rounded.Image
                        else -> Icons.Rounded.Description
                    },
                    contentDescription = doc.kind.label,
                    tint = DashColors.Gold,
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(doc.name, style = MaterialTheme.typography.titleSmall, color = DashColors.White, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("${doc.kind.label} · ${FileRules.formatSize(doc.sizeBytes)}", style = MaterialTheme.typography.labelSmall, color = DashColors.Grey)
                }
                if (doc.isDemo) DemoBadge()
            }
            Text(
                doc.statusDetail,
                style = MaterialTheme.typography.bodySmall,
                color = if (doc.status == DocumentStatus.UNSUPPORTED || doc.status == DocumentStatus.FAILED) DashColors.GoldLight else DashColors.Grey,
            )
            if (!usable && doc.isDemo) {
                Text("Uploaded in Demo Mode. Turn Demo Mode off and upload it again to analyse it.", style = MaterialTheme.typography.bodySmall, color = DashColors.GreyDim)
            }
            Row {
                TextButton(onClick = onSummarise, enabled = usable) { Text("Summarise") }
                TextButton(onClick = onAsk, enabled = usable) { Text("Ask a question") }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = onRemove) { Text("Remove", color = DashColors.Error) }
            }
        }
    }
}
