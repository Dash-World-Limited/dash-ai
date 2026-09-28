package com.dashworldng.ai.data.local

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "conversations")
data class ConversationEntity(
    @PrimaryKey val id: String,
    val title: String,
    val mode: String,
    val createdAt: Long,
    val updatedAt: Long,
    val titleIsCustom: Boolean,
    val isDemo: Boolean,
)

@Entity(tableName = "messages", indices = [Index("conversationId")])
data class MessageEntity(
    @PrimaryKey val id: String,
    val conversationId: String,
    val role: String,
    val content: String,
    val createdAt: Long,
    val status: String,
    val provider: String?,
    val model: String?,
    val isDemo: Boolean,
    val modelChoice: String?,
    val compareGroupId: String?,
    val replyToId: String?,
    val attachmentsJson: String,
    val errorMessage: String?,
    val errorRetryable: Boolean,
    val finishReason: String?,
    val routingReason: String?,
)

@Entity(tableName = "custom_prompts")
data class CustomPromptEntity(
    @PrimaryKey val id: String,
    val title: String,
    val body: String,
    val category: String,
    val updatedAt: Long,
)

@Entity(tableName = "favorite_prompts")
data class FavoritePromptEntity(@PrimaryKey val promptId: String)

@Entity(tableName = "documents")
data class DocumentEntity(
    @PrimaryKey val id: String,
    val remoteId: String?,
    val name: String,
    val kind: String,
    val mimeType: String,
    val sizeBytes: Long,
    val status: String,
    val statusDetail: String,
    val extractedChars: Int,
    val pageCount: Int?,
    val createdAt: Long,
    val isDemo: Boolean,
)

@Dao
interface ConversationDao {
    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    fun observeAll(): Flow<List<ConversationEntity>>

    @Query(
        "SELECT * FROM conversations WHERE title LIKE '%' || :query || '%' ESCAPE '\\' " +
            "OR id IN (SELECT conversationId FROM messages WHERE content LIKE '%' || :query || '%' ESCAPE '\\') " +
            "ORDER BY updatedAt DESC",
    )
    fun search(query: String): Flow<List<ConversationEntity>>

    @Query("SELECT * FROM conversations WHERE id = :id")
    suspend fun get(id: String): ConversationEntity?

    @Query("SELECT * FROM conversations ORDER BY updatedAt DESC")
    suspend fun all(): List<ConversationEntity>

    @Upsert
    suspend fun upsert(entity: ConversationEntity)

    @Query("UPDATE conversations SET title = :title, titleIsCustom = 1 WHERE id = :id")
    suspend fun rename(id: String, title: String)

    @Query("DELETE FROM conversations WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM conversations")
    suspend fun deleteAll()
}

@Dao
interface MessageDao {
    @Query("SELECT * FROM messages WHERE conversationId = :conversationId ORDER BY createdAt ASC")
    suspend fun forConversation(conversationId: String): List<MessageEntity>

    @Upsert
    suspend fun upsert(entity: MessageEntity)

    @Query("DELETE FROM messages WHERE id IN (:ids)")
    suspend fun delete(ids: List<String>)

    @Query("DELETE FROM messages WHERE conversationId = :conversationId")
    suspend fun deleteForConversation(conversationId: String)

    @Query("DELETE FROM messages")
    suspend fun deleteAll()
}

@Dao
interface PromptDao {
    @Query("SELECT * FROM custom_prompts ORDER BY title COLLATE NOCASE")
    fun observeCustom(): Flow<List<CustomPromptEntity>>

    @Query("SELECT * FROM favorite_prompts")
    fun observeFavorites(): Flow<List<FavoritePromptEntity>>

    @Upsert
    suspend fun upsertCustom(entity: CustomPromptEntity)

    @Query("DELETE FROM custom_prompts WHERE id = :id")
    suspend fun deleteCustom(id: String)

    @Upsert
    suspend fun addFavorite(entity: FavoritePromptEntity)

    @Query("DELETE FROM favorite_prompts WHERE promptId = :id")
    suspend fun removeFavorite(id: String)

    @Query("DELETE FROM custom_prompts")
    suspend fun deleteAllCustom()

    @Query("DELETE FROM favorite_prompts")
    suspend fun deleteAllFavorites()
}

@Dao
interface DocumentDao {
    @Query("SELECT * FROM documents ORDER BY createdAt DESC")
    fun observeAll(): Flow<List<DocumentEntity>>

    @Query("SELECT * FROM documents WHERE id = :id")
    suspend fun get(id: String): DocumentEntity?

    @Upsert
    suspend fun upsert(entity: DocumentEntity)

    @Query("DELETE FROM documents WHERE id = :id")
    suspend fun delete(id: String)

    @Query("DELETE FROM documents")
    suspend fun deleteAll()
}

@Database(
    entities = [
        ConversationEntity::class,
        MessageEntity::class,
        CustomPromptEntity::class,
        FavoritePromptEntity::class,
        DocumentEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class DashDatabase : RoomDatabase() {
    abstract fun conversations(): ConversationDao
    abstract fun messages(): MessageDao
    abstract fun prompts(): PromptDao
    abstract fun documents(): DocumentDao

    companion object {
        fun create(context: Context): DashDatabase =
            Room.databaseBuilder(context, DashDatabase::class.java, "dash-ai.db").build()

        fun inMemory(context: Context): DashDatabase =
            Room.inMemoryDatabaseBuilder(context, DashDatabase::class.java).allowMainThreadQueries().build()
    }
}
