@file:Suppress("unused", "UNUSED_PARAMETER")
package com.dashworldng.ai.data.local
import com.dashworldng.ai.core.data.*
/** STUBS for the Room layer (needs Room/KSP, Google Maven only). */
class DashDatabase { companion object { fun create(context: android.content.Context): DashDatabase = DashDatabase() } }
class RoomConversationRepository(db: DashDatabase) : ConversationRepository by InMemoryConversationRepository()
class RoomPromptRepository(db: DashDatabase) : PromptRepository by InMemoryPromptRepository()
class RoomDocumentRepository(db: DashDatabase) : DocumentRepository by InMemoryDocumentRepository()
