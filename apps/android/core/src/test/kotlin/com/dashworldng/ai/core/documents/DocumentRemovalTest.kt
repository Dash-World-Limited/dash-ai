package com.dashworldng.ai.core.documents

import com.dashworldng.ai.core.model.DocumentItem
import com.dashworldng.ai.core.model.DocumentKind
import com.dashworldng.ai.core.model.DocumentStatus
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class DocumentRemovalTest {
    private val stored = DocumentItem(
        id = "local-1", remoteId = "remote-1", name = "notes.txt", kind = DocumentKind.TXT, mimeType = "text/plain",
        sizeBytes = 10, status = DocumentStatus.READY, statusDetail = "", createdAt = 0, isDemo = false,
    )

    private class Server(private val failure: ApiError? = null) : DocumentGateway {
        override val isDemo = false
        val deleted = mutableListOf<String?>()
        override suspend fun upload(source: UploadSource, onProgress: (Float) -> Unit): DocumentItem = error("unused")
        override suspend fun delete(document: DocumentItem) {
            failure?.let { throw ApiException(it) }
            deleted += document.remoteId
        }
    }

    private fun remove(doc: DocumentItem, server: Server, demoMode: Boolean = false): Pair<DocumentRemoval, List<String>> = runBlocking {
        val local = mutableListOf<String>()
        DocumentRemoval.remove(doc, demoMode, { server }, { local += it }) to local
    }

    @Test
    fun `a stored document leaves the device only after the server removed it`() {
        val server = Server()
        val (outcome, local) = remove(stored, server)
        assertEquals(DocumentRemoval.Removed, outcome)
        assertEquals(listOf<String?>("remote-1"), server.deleted)
        assertEquals(listOf("local-1"), local)
    }

    @Test
    fun `offline or a server error keeps the document listed and says so (never a fake success)`() {
        val (outcome, local) = remove(stored, Server(ApiError.network()))
        val failed = assertIs<DocumentRemoval.Failed>(outcome)
        assertTrue(failed.message.startsWith("“notes.txt” couldn't be removed from the DASH AI server."))
        assertEquals(emptyList(), local)
    }

    @Test
    fun `a document the server no longer has is removed here too`() {
        val (outcome, local) = remove(stored, Server(ApiError("not_found", "Document not found.", false)))
        assertEquals(DocumentRemoval.Removed, outcome)
        assertEquals(listOf("local-1"), local)
    }

    @Test
    fun `Demo Mode cannot pretend to remove a document the server stores`() {
        val server = Server()
        val (outcome, local) = remove(stored, server, demoMode = true)
        assertIs<DocumentRemoval.Failed>(outcome)
        assertEquals(emptyList(), server.deleted)
        assertEquals(emptyList(), local)
    }

    @Test
    fun `demo and never-uploaded documents only live on the device`() {
        val server = Server()
        val (outcome, local) = remove(stored.copy(isDemo = true), server)
        assertEquals(DocumentRemoval.Removed, outcome)
        assertEquals(emptyList(), server.deleted)
        assertEquals(listOf("local-1"), local)
    }
}
