package com.dashworldng.ai

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.dashworldng.ai.core.model.ChatMessage
import com.dashworldng.ai.core.model.MessageRole
import com.dashworldng.ai.core.model.ToolCallStatus
import com.dashworldng.ai.core.model.ToolUse
import com.dashworldng.ai.data.local.DashDatabase
import com.dashworldng.ai.data.local.RoomConversationRepository
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * An app updated from schema version 1 keeps every conversation and message. The version 1 tables are
 * written exactly as Room created them, then the current app opens the file: Room runs the migrations
 * and checks the result against the current entities, so a missing or wrong migration fails here.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [34])
class RoomMigrationTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val name = "migration-test.db"

    @After
    fun cleanUp() {
        context.deleteDatabase(name)
    }

    @Test
    fun version1HistoryOpensInTheCurrentSchemaWithNoToolActivityInvented() = runBlocking<Unit> {
        context.deleteDatabase(name)
        SQLiteDatabase.openOrCreateDatabase(context.getDatabasePath(name).apply { parentFile?.mkdirs() }, null).use { db ->
            VERSION_1.forEach(db::execSQL)
            db.execSQL("INSERT INTO conversations VALUES ('c1', 'Kiosk plan', 'business', 1, 2, 0, 0)")
            db.execSQL(
                "INSERT INTO messages VALUES ('m1', 'c1', 'user', 'Plan it', 1, 'COMPLETE', NULL, NULL, 0, NULL, NULL, NULL, '[]', NULL, 0, NULL, NULL)",
            )
            db.execSQL(
                "INSERT INTO messages VALUES ('m2', 'c1', 'assistant', 'Here is a plan', 2, 'COMPLETE', 'openai', 'm', 0, 'openai', NULL, 'm1', '[]', NULL, 0, 'stop', NULL)",
            )
            db.version = 1
        }

        val database = DashDatabase.create(context, name)
        try {
            val repository = RoomConversationRepository(database)
            val messages = repository.getMessages("c1")
            assertEquals(listOf("Plan it", "Here is a plan"), messages.map { it.content })
            assertTrue(messages.all { it.tools.isEmpty() })

            // New answers keep the tools they used.
            val use = ToolUse("call_1", "dash-demo", "text_stats", ToolCallStatus.OK, 3)
            repository.upsertMessage(ChatMessage("m3", "c1", MessageRole.ASSISTANT, "Counted", 3, tools = listOf(use)))
            assertEquals(listOf(use), repository.getMessages("c1").single { it.id == "m3" }.tools)
        } finally {
            database.close()
        }
    }

    private companion object {
        /** The schema of version 1, as Room 2.6 generated it for the entities of that release. */
        val VERSION_1 = listOf(
            "CREATE TABLE IF NOT EXISTS `conversations` (`id` TEXT NOT NULL, `title` TEXT NOT NULL, `mode` TEXT NOT NULL, " +
                "`createdAt` INTEGER NOT NULL, `updatedAt` INTEGER NOT NULL, `titleIsCustom` INTEGER NOT NULL, `isDemo` INTEGER NOT NULL, " +
                "PRIMARY KEY(`id`))",
            "CREATE TABLE IF NOT EXISTS `messages` (`id` TEXT NOT NULL, `conversationId` TEXT NOT NULL, `role` TEXT NOT NULL, " +
                "`content` TEXT NOT NULL, `createdAt` INTEGER NOT NULL, `status` TEXT NOT NULL, `provider` TEXT, `model` TEXT, " +
                "`isDemo` INTEGER NOT NULL, `modelChoice` TEXT, `compareGroupId` TEXT, `replyToId` TEXT, `attachmentsJson` TEXT NOT NULL, " +
                "`errorMessage` TEXT, `errorRetryable` INTEGER NOT NULL, `finishReason` TEXT, `routingReason` TEXT, PRIMARY KEY(`id`))",
            "CREATE INDEX IF NOT EXISTS `index_messages_conversationId` ON `messages` (`conversationId`)",
            "CREATE TABLE IF NOT EXISTS `custom_prompts` (`id` TEXT NOT NULL, `title` TEXT NOT NULL, `body` TEXT NOT NULL, " +
                "`category` TEXT NOT NULL, `updatedAt` INTEGER NOT NULL, PRIMARY KEY(`id`))",
            "CREATE TABLE IF NOT EXISTS `favorite_prompts` (`promptId` TEXT NOT NULL, PRIMARY KEY(`promptId`))",
            "CREATE TABLE IF NOT EXISTS `documents` (`id` TEXT NOT NULL, `remoteId` TEXT, `name` TEXT NOT NULL, `kind` TEXT NOT NULL, " +
                "`mimeType` TEXT NOT NULL, `sizeBytes` INTEGER NOT NULL, `status` TEXT NOT NULL, `statusDetail` TEXT NOT NULL, " +
                "`extractedChars` INTEGER NOT NULL, `pageCount` INTEGER, `createdAt` INTEGER NOT NULL, `isDemo` INTEGER NOT NULL, " +
                "PRIMARY KEY(`id`))",
        )
    }
}
