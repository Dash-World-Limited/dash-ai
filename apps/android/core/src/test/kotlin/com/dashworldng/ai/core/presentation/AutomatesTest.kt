package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationScheduleDto
import com.dashworldng.ai.core.remote.DashJson
import com.dashworldng.ai.core.remote.UpdateAutomationRequestDto
import java.time.Instant
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AutomatesTest {
    private fun weekly(vararg days: Int, time: String = "09:00") = AutomationScheduleDto("weekly", time, days = days.toList())

    @Test
    fun scheduleWordingMatchesTheWebApp() {
        assertEquals("Every day at 08:00", AutomationLabels.schedule(AutomationScheduleDto("daily", "08:00")))
        assertEquals("Weekdays at 07:30", AutomationLabels.schedule(weekly(5, 1, 2, 3, 4, time = "07:30")))
        assertEquals("Weekends at 10:00", AutomationLabels.schedule(weekly(0, 6, time = "10:00")))
        assertEquals("Mondays at 09:00", AutomationLabels.schedule(weekly(1)))
        assertEquals("Mondays, Wednesdays and Fridays at 09:00", AutomationLabels.schedule(weekly(5, 1, 3)))
        assertEquals("Every day at 06:00", AutomationLabels.schedule(weekly(0, 1, 2, 3, 4, 5, 6, time = "06:00")))
        assertEquals("Monthly on day 1 at 07:00", AutomationLabels.schedule(AutomationScheduleDto("monthly", "07:00", day = 1)))
        assertEquals("Monthly on day 31 at 07:00 (or the last day)", AutomationLabels.schedule(AutomationScheduleDto("monthly", "07:00", day = 31)))
        assertEquals("Once on 1 Dec 2026 at 09:00", AutomationLabels.schedule(AutomationScheduleDto("once", "09:00", date = "2026-12-01")))
    }

    @Test
    fun statesReadReadyRunningFailed() {
        assertEquals(StatusLabel("Ready", StatusTone.SUCCESS), AutomationLabels.state("ready"))
        assertEquals(StatusLabel("Running", StatusTone.PROGRESS), AutomationLabels.state("running"))
        assertEquals(StatusLabel("Failed", StatusTone.ERROR), AutomationLabels.state("failed"))
        assertEquals("Running", AutomationLabels.runStatus("queued").text)
    }

    @Test
    fun timesAreRelativeToTodayInTheViewersZone() {
        val now = Instant.parse("2026-10-07T10:00:00Z")
        val lagos = ZoneId.of("Africa/Lagos")
        assertEquals("Today at 08:00", AutomationLabels.formatWhen("2026-10-07T07:00:00Z", now, lagos))
        assertEquals("Tomorrow at 08:00", AutomationLabels.formatWhen("2026-10-08T07:00:00Z", now, lagos))
        assertEquals("Yesterday at 08:00", AutomationLabels.formatWhen("2026-10-06T07:00:00Z", now, lagos))
        assertEquals("Mon 12 Oct at 08:00", AutomationLabels.formatWhen("2026-10-12T07:00:00Z", now, lagos))
    }

    @Test
    fun downloadNamesAreSafe() {
        assertEquals("morning-brief-q4-sales-2026-10-07.md", AutomationLabels.downloadName("Morning brief: Q4 / Sales!", "2026-10-07T07:00:00Z"))
        assertEquals("dash-ai-result-2026-10-07.md", AutomationLabels.downloadName("✨", "2026-10-07T07:00:00Z"))
    }

    @Test
    fun draftsAreValidatedLikeTheServer() {
        val now = Instant.parse("2026-10-07T10:00:00Z")
        val draft = AutomationDraft.new(now, ZoneId.of("Africa/Lagos")).copy(name = "Brief", prompt = "Plan my day")
        assertNull(draft.problem(now))
        assertEquals("Give the automation a name.", draft.copy(name = " ").problem(now))
        assertEquals("Enter the time as HH:MM, for example 08:00.", draft.copy(time = "8am").problem(now))
        assertEquals("Choose at least one day.", draft.copy(days = emptySet()).problem(now))
        assertEquals("That date and time has already passed.", draft.copy(repeat = RepeatKind.ONCE, date = "2026-10-07", time = "09:00").problem(now))
        assertNull(draft.copy(repeat = RepeatKind.ONCE, date = "2026-10-07", time = "12:00").problem(now))
        assertEquals("Choose a valid time zone.", draft.copy(timeZone = "Mars/Base").problem(now))
    }

    @Test
    fun schedulesSerializeOnlyTheirOwnFields() {
        val json = DashJson.default
        assertEquals("""{"kind":"daily","time":"08:00"}""", json.encodeToString(AutomationScheduleDto.serializer(), AutomationScheduleDto("daily", "08:00")))
        assertEquals(
            """{"kind":"weekly","time":"08:00","days":[1,3]}""",
            json.encodeToString(AutomationScheduleDto.serializer(), AutomationDraft(repeat = RepeatKind.WEEKLY, days = setOf(3, 1)).schedule()),
        )
    }

    @Test
    fun editsSendOnlyWhatChanged() {
        val now = Instant.parse("2026-10-07T10:00:00Z")
        val original = AutomationDto(
            id = "a1", name = "Brief", prompt = "Plan my day", mode = "general",
            schedule = AutomationScheduleDto("once", "09:00", date = "2026-10-07"), timeZone = "Africa/Lagos",
            status = "completed", state = "completed", nextRunAt = null, lastRun = null,
            createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z",
        )
        val draft = AutomationDraft.from(original, now)
        assertEquals(RepeatKind.ONCE, draft.repeat)
        assertEquals(AssistantMode.GENERAL, draft.mode)
        val update = draft.copy(name = "Morning brief").toUpdate(original)
        assertEquals(UpdateAutomationRequestDto(name = "Morning brief"), update)
        assertEquals("""{"name":"Morning brief"}""", DashJson.default.encodeToString(UpdateAutomationRequestDto.serializer(), update))
    }
}
