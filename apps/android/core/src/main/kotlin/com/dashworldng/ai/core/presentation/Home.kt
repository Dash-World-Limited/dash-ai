package com.dashworldng.ai.core.presentation

import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.Conversation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** Time-aware greeting using the account's own display name (first word only). Never a hard-coded name. */
object Greeting {
    fun forHour(hour: Int, displayName: String?): String {
        val part = when (hour) {
            in 5..11 -> "Good morning"
            in 12..16 -> "Good afternoon"
            in 17..21 -> "Good evening"
            else -> "Hello"
        }
        val first = firstName(displayName)
        return if (first == null) part else "$part, $first"
    }

    /** The first word of a display name, or null for blank names and the placeholder ones the app uses. */
    fun firstName(displayName: String?): String? {
        val clean = displayName?.trim().orEmpty()
        if (clean.isEmpty() || clean in PLACEHOLDER_NAMES) return null
        return clean.split(Regex("\\s+")).first().take(MAX_NAME_CHARS)
    }

    /** One or two letters for an avatar, from the display name or the email; null when neither helps. */
    fun initials(displayName: String?, email: String?): String? {
        val name = firstName(displayName)?.let { displayName!!.trim() }
        val source = name ?: email?.substringBefore('@')?.takeIf { it.isNotBlank() } ?: return null
        val words = source.split(Regex("[\\s._-]+")).filter { it.isNotEmpty() && it.first().isLetterOrDigit() }
        val letters = if (words.size >= 2) "${words[0].first()}${words[1].first()}" else words.firstOrNull()?.take(1) ?: return null
        return letters.uppercase()
    }

    private const val MAX_NAME_CHARS = 24
    private val PLACEHOLDER_NAMES = setOf("Demo user", "Dash AI user")
}

/** A starting point offered on Home. Each one opens a new chat in a real assistant mode. */
enum class QuickAction(val label: String, val mode: AssistantMode, val prompt: String, val opensTools: Boolean = false, val asksForFile: Boolean = false) {
    WRITE("Write", AssistantMode.WRITING, ""),
    ANALYSE_FILE("Analyse a file", AssistantMode.DOCUMENTS, "", asksForFile = true),
    BRAINSTORM("Brainstorm", AssistantMode.GENERAL, "Help me brainstorm ideas for "),
    CODE("Code", AssistantMode.GENERAL, "Help me with this code: "),
    RESEARCH("Research", AssistantMode.RESEARCH, ""),
    MORE_TOOLS("More tools", AssistantMode.GENERAL, "", opensTools = true),
}

/** Sections of the chat history list. */
enum class HistorySection(val label: String) { TODAY("Today"), YESTERDAY("Yesterday"), PREVIOUS_7_DAYS("Previous 7 days"), OLDER("Older") }

data class HistoryGroup(val section: HistorySection, val conversations: List<Conversation>)

object HistoryGrouping {
    /**
     * Groups conversations (already sorted newest first) by the calendar day of their last activity
     * in [zone]. Empty sections are left out; order inside a section is preserved.
     */
    fun group(conversations: List<Conversation>, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<HistoryGroup> {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val buckets = conversations.groupBy { sectionFor(it.updatedAt, today, zone) }
        return HistorySection.entries.mapNotNull { section -> buckets[section]?.let { HistoryGroup(section, it) } }
    }

    fun sectionFor(timestamp: Long, today: LocalDate, zone: ZoneId): HistorySection {
        val day = Instant.ofEpochMilli(timestamp).atZone(zone).toLocalDate()
        val days = ChronoUnit.DAYS.between(day, today)
        return when {
            days <= 0 -> HistorySection.TODAY
            days == 1L -> HistorySection.YESTERDAY
            days < 8 -> HistorySection.PREVIOUS_7_DAYS
            else -> HistorySection.OLDER
        }
    }
}

/** Where the app goes after the splash screen. */
enum class StartDestination { ONBOARDING, AUTH, HOME }

object StartRoute {
    /**
     * First launch → onboarding; then sign in (or Demo Mode). A signed-in account or an active Demo
     * Mode profile goes straight Home, so returning users never see onboarding again.
     */
    fun resolve(onboardingComplete: Boolean, hasAccount: Boolean): StartDestination = when {
        !onboardingComplete -> StartDestination.ONBOARDING
        !hasAccount -> StartDestination.AUTH
        else -> StartDestination.HOME
    }
}
