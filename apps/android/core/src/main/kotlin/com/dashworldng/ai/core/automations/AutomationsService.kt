package com.dashworldng.ai.core.automations

import com.dashworldng.ai.core.remote.AutomationDetailDto
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationRunDto
import com.dashworldng.ai.core.remote.CreateAutomationRequestDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.MarkNotificationsReadRequestDto
import com.dashworldng.ai.core.remote.NotificationListDto
import com.dashworldng.ai.core.remote.UpdateAutomationRequestDto
import com.dashworldng.ai.core.remote.UpdateAutomationRunRequestDto

/**
 * DASH Automates on the server (/v1/automations, /v1/notifications). Automations run on the server,
 * so nothing here depends on the phone being awake; the app only shows and edits them.
 */
interface AutomationsApi {
    suspend fun list(): List<AutomationDto>
    suspend fun create(body: CreateAutomationRequestDto): AutomationDto
    suspend fun detail(id: String): AutomationDetailDto
    suspend fun update(id: String, body: UpdateAutomationRequestDto): AutomationDto
    suspend fun delete(id: String)
    suspend fun pause(id: String): AutomationDto
    suspend fun resume(id: String): AutomationDto
    suspend fun runNow(id: String): AutomationRunDto
    suspend fun run(id: String, runId: String): AutomationRunDto
    suspend fun editRun(id: String, runId: String, content: String): AutomationRunDto
    suspend fun regenerate(id: String, runId: String): AutomationRunDto
    suspend fun notifications(): NotificationListDto

    /** Marks [ids] read, or every notification when null. */
    suspend fun markRead(ids: List<String>? = null)
}

class RemoteAutomations(private val client: () -> DashApiClient) : AutomationsApi {
    override suspend fun list(): List<AutomationDto> = client().call { automations() }.automations
    override suspend fun create(body: CreateAutomationRequestDto): AutomationDto = client().call { createAutomation(body) }
    override suspend fun detail(id: String): AutomationDetailDto = client().call { automation(id) }
    override suspend fun update(id: String, body: UpdateAutomationRequestDto): AutomationDto = client().call { updateAutomation(id, body) }
    override suspend fun delete(id: String) = client().callNoContent { deleteAutomation(id) }
    override suspend fun pause(id: String): AutomationDto = client().call { pauseAutomation(id) }
    override suspend fun resume(id: String): AutomationDto = client().call { resumeAutomation(id) }
    override suspend fun runNow(id: String): AutomationRunDto = client().call { runAutomation(id) }.run
    override suspend fun run(id: String, runId: String): AutomationRunDto = client().call { automationRun(id, runId) }.run
    override suspend fun editRun(id: String, runId: String, content: String): AutomationRunDto =
        client().call { editAutomationRun(id, runId, UpdateAutomationRunRequestDto(content)) }.run
    override suspend fun regenerate(id: String, runId: String): AutomationRunDto = client().call { regenerateAutomationRun(id, runId) }.run
    override suspend fun notifications(): NotificationListDto = client().call { notifications() }
    override suspend fun markRead(ids: List<String>?) {
        client().call { markNotificationsRead(MarkNotificationsReadRequestDto(ids)) }
    }
}

/**
 * The unread count of Automates notices for this app session (shown on the menu and the Automates
 * entry). Results are produced on the server; this only mirrors /v1/notifications.
 */
class AutomationNotices {
    private val count = kotlinx.coroutines.flow.MutableStateFlow(0)
    val unread: kotlinx.coroutines.flow.StateFlow<Int> = count

    suspend fun refresh(api: AutomationsApi): com.dashworldng.ai.core.remote.NotificationListDto =
        api.notifications().also { count.value = it.unread }

    fun set(unread: Int) {
        count.value = unread.coerceAtLeast(0)
    }

    fun clear() = set(0)
}
