package com.dashworldng.ai.core.sync

import com.dashworldng.ai.core.remote.DashJson
import kotlinx.serialization.Serializable

/**
 * What the device remembers between syncs.
 *
 * @property userId the account this state belongs to; a different account starts from scratch.
 * @property cursor opaque server position of the last change fully applied ("0" = from the start).
 * @property pendingDeletes conversations the user deleted locally whose deletion has not reached
 *   the server yet. Until it does, the server copy must not be pulled back.
 * @property pendingRenames locally renamed conversations (id → title) not yet accepted by the server.
 * @property renameBases for each pending rename, the server title revision the device had seen when
 *   the user renamed (absent = the device had never pulled that conversation).
 * @property pendingUploads conversations created or extended on this device while signed in to
 *   [userId] whose user messages may not be on the server yet. Only these are ever uploaded, so a
 *   conversation from another account or from Demo Mode can never be pushed into this account.
 * @property titleRevs the last title revision pulled for each conversation.
 *
 * New fields have defaults, so state written by an older app version still decodes.
 */
@Serializable
data class SyncState(
    val userId: String? = null,
    val cursor: String = "0",
    val pendingDeletes: Set<String> = emptySet(),
    val pendingRenames: Map<String, String> = emptyMap(),
    val renameBases: Map<String, Long> = emptyMap(),
    val pendingUploads: Set<String> = emptySet(),
    val titleRevs: Map<String, Long> = emptyMap(),
) {
    /** Forgets every pending operation and known revision for one conversation. */
    fun forget(id: String) = copy(
        pendingDeletes = pendingDeletes - id,
        pendingRenames = pendingRenames - id,
        renameBases = renameBases - id,
        pendingUploads = pendingUploads - id,
        titleRevs = titleRevs - id,
    )

    val hasPendingWork: Boolean get() = pendingDeletes.isNotEmpty() || pendingRenames.isNotEmpty() || pendingUploads.isNotEmpty()

    companion object {
        fun encode(state: SyncState): String = DashJson.default.encodeToString(serializer(), state)

        /** Corrupt or missing data means "start over": a full pull is always safe and idempotent. */
        fun decode(text: String?): SyncState =
            text?.let { runCatching { DashJson.default.decodeFromString(serializer(), it) }.getOrNull() } ?: SyncState()
    }
}

/** Persists [SyncState]. SharedPreferences-backed on Android, in memory for tests. */
interface SyncStateStore {
    suspend fun load(): SyncState
    suspend fun save(state: SyncState)
}

class InMemorySyncStateStore(initial: SyncState = SyncState()) : SyncStateStore {
    @Volatile private var state = initial
    override suspend fun load(): SyncState = state
    override suspend fun save(state: SyncState) {
        this.state = state
    }
}
