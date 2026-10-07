package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.remote.AutomationDto
import com.dashworldng.ai.core.remote.AutomationScheduleDto
import com.dashworldng.ai.core.remote.CreateAutomationRequestDto
import com.dashworldng.ai.core.remote.UpdateAutomationRequestDto
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Same wording as the web app (apps/web/src/logic/automations.ts). */
object AutomationLabels {
    private val dayNames = listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
    private val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    private val shortDays = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")

    /** "Weekdays at 08:00", "Monthly on day 31 at 07:00 (or the last day)", "Once on 1 Dec 2026 at 09:00". */
    fun schedule(s: AutomationScheduleDto): String = when (s.kind) {
        "once" -> {
            val date = runCatching { LocalDate.parse(s.date.orEmpty()) }.getOrNull()
            if (date == null) "Once at ${s.time}" else "Once on ${date.dayOfMonth} ${months[date.monthValue - 1]} ${date.year} at ${s.time}"
        }
        "daily" -> "Every day at ${s.time}"
        "weekly" -> {
            val days = s.days.orEmpty().distinct().sorted()
            when {
                days.size == 7 -> "Every day at ${s.time}"
                days == listOf(1, 2, 3, 4, 5) -> "Weekdays at ${s.time}"
                days == listOf(0, 6) -> "Weekends at ${s.time}"
                else -> {
                    val names = days.map { "${dayNames.getOrElse(it) { "Day" }}s" }
                    val list = if (names.size == 1) names.single() else names.dropLast(1).joinToString(", ") + " and " + names.last()
                    "$list at ${s.time}"
                }
            }
        }
        "monthly" -> "Monthly on day ${s.day} at ${s.time}${if ((s.day ?: 0) > 28) " (or the last day)" else ""}"
        else -> "On a schedule"
    }

    fun dayShort(day: Int): String = shortDays[day]

    /** Ready / Running / Failed and the rest. */
    fun state(state: String): StatusLabel = when (state) {
        "running" -> StatusLabel("Running", StatusTone.PROGRESS)
        "ready" -> StatusLabel("Ready", StatusTone.SUCCESS)
        "failed" -> StatusLabel("Failed", StatusTone.ERROR)
        "paused" -> StatusLabel("Paused", StatusTone.NEUTRAL)
        "completed" -> StatusLabel("Completed", StatusTone.NEUTRAL)
        else -> StatusLabel("Scheduled", StatusTone.NEUTRAL)
    }

    /** A run's own status (queued and running both read as Running). */
    fun runStatus(status: String): StatusLabel = when (status) {
        "queued", "running" -> state("running")
        "ready" -> state("ready")
        else -> state("failed")
    }

    fun trigger(trigger: String): String = when (trigger) {
        "manual" -> "Run now"
        "regenerate" -> "Regenerated"
        else -> "Scheduled"
    }

    /** "Today at 08:00", "Tomorrow at 08:00", "Mon 12 Oct at 08:00", in the viewer's zone. */
    fun formatWhen(iso: String, now: Instant, zone: ZoneId = ZoneId.systemDefault()): String {
        val at = runCatching { Instant.parse(iso) }.getOrNull() ?: return iso
        val local = at.atZone(zone)
        val today = now.atZone(zone).toLocalDate()
        val time = local.format(DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT))
        return when (local.toLocalDate()) {
            today -> "Today at $time"
            today.plusDays(1) -> "Tomorrow at $time"
            today.minusDays(1) -> "Yesterday at $time"
            else -> "${local.format(DateTimeFormatter.ofPattern("EEE d MMM", Locale.UK))} at $time"
        }
    }

    /** "Morning brief" → "morning-brief-2026-10-07.md". */
    fun downloadName(name: String, createdAt: String): String {
        val slug = name.lowercase(Locale.ROOT).replace(Regex("[^a-z0-9]+"), "-").trim('-').take(60).trim('-').ifEmpty { "dash-ai-result" }
        return "$slug-${createdAt.take(10)}.md"
    }
}

enum class RepeatKind(val wire: String, val label: String) {
    ONCE("once", "Once"),
    DAILY("daily", "Daily"),
    WEEKLY("weekly", "Weekly"),
    MONTHLY("monthly", "Monthly"),
}

/** The automation editor's fields, validated the same way as the server. */
data class AutomationDraft(
    val name: String = "",
    val prompt: String = "",
    val mode: AssistantMode = AssistantMode.GENERAL,
    val repeat: RepeatKind = RepeatKind.WEEKLY,
    val time: String = "08:00",
    val date: String = "",
    val days: Set<Int> = setOf(1, 2, 3, 4, 5),
    val dayOfMonth: Int = 1,
    val timeZone: String = ZoneId.systemDefault().id,
) {
    fun schedule(): AutomationScheduleDto = when (repeat) {
        RepeatKind.ONCE -> AutomationScheduleDto("once", time, date = date)
        RepeatKind.DAILY -> AutomationScheduleDto("daily", time)
        RepeatKind.WEEKLY -> AutomationScheduleDto("weekly", time, days = days.sorted())
        RepeatKind.MONTHLY -> AutomationScheduleDto("monthly", time, day = dayOfMonth)
    }

    /** The first problem to fix, or null when the draft can be saved. */
    fun problem(now: Instant): String? {
        if (name.isBlank()) return "Give the automation a name."
        if (name.trim().length > MAX_NAME) return "Keep the name to $MAX_NAME characters."
        if (prompt.isBlank()) return "Say what DASH AI should do."
        if (prompt.trim().length > MAX_PROMPT) return "Keep the task to $MAX_PROMPT characters."
        val t = parseTime(time) ?: return "Enter the time as HH:MM, for example 08:00."
        val zone = runCatching { ZoneId.of(timeZone) }.getOrNull() ?: return "Choose a valid time zone."
        when (repeat) {
            RepeatKind.WEEKLY -> if (days.isEmpty()) return "Choose at least one day."
            RepeatKind.MONTHLY -> if (dayOfMonth !in 1..31) return "Choose a day from 1 to 31."
            RepeatKind.ONCE -> {
                val d = runCatching { LocalDate.parse(date) }.getOrNull() ?: return "Enter the date as YYYY-MM-DD."
                if (!LocalDateTime.of(d, t).atZone(zone).toInstant().isAfter(now)) return "That date and time has already passed."
            }
            RepeatKind.DAILY -> Unit
        }
        return null
    }

    fun toCreate(): CreateAutomationRequestDto = CreateAutomationRequestDto(name.trim(), prompt.trim(), mode.wire, schedule(), timeZone)

    /** Only what changed; an unchanged schedule is not sent, so the next run stays as it is. */
    fun toUpdate(original: AutomationDto): UpdateAutomationRequestDto {
        val schedule = schedule()
        return UpdateAutomationRequestDto(
            name = name.trim().takeIf { it != original.name },
            prompt = prompt.trim().takeIf { it != original.prompt },
            mode = mode.wire.takeIf { it != original.mode },
            schedule = schedule.takeIf { it != original.schedule },
            timeZone = timeZone.takeIf { it != original.timeZone },
        )
    }

    companion object {
        const val MAX_NAME = 80
        const val MAX_PROMPT = 8_000

        fun parseTime(value: String): LocalTime? =
            if (Regex("^([01]\\d|2[0-3]):[0-5]\\d$").matches(value)) runCatching { LocalTime.parse(value) }.getOrNull() else null

        /** A new automation: weekdays at 08:00 in the device's zone, with a one-time date one hour ahead. */
        fun new(now: Instant, zone: ZoneId = ZoneId.systemDefault()): AutomationDraft {
            val later = now.plusSeconds(3600).atZone(zone)
            return AutomationDraft(timeZone = zone.id, date = later.toLocalDate().toString())
        }

        fun from(a: AutomationDto, now: Instant): AutomationDraft {
            val base = new(now, runCatching { ZoneId.of(a.timeZone) }.getOrElse { ZoneId.of("UTC") })
            val s = a.schedule
            return base.copy(
                name = a.name,
                prompt = a.prompt,
                mode = AssistantMode.fromWire(a.mode) ?: AssistantMode.GENERAL,
                repeat = RepeatKind.entries.firstOrNull { it.wire == s.kind } ?: RepeatKind.DAILY,
                time = s.time,
                date = s.date ?: base.date,
                days = s.days?.toSet() ?: base.days,
                dayOfMonth = s.day ?: base.dayOfMonth,
                timeZone = a.timeZone,
            )
        }

        /** The device's zone first, then UTC, then every other zone alphabetically. */
        fun zoneOptions(current: String): List<String> =
            (listOf(current, "UTC") + ZoneId.getAvailableZoneIds().filter { '/' in it && !it.startsWith("Etc/") && !it.startsWith("SystemV/") }.sorted()).distinct()
    }
}
