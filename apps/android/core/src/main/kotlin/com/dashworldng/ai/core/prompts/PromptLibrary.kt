package com.dashworldng.ai.core.prompts

import com.dashworldng.ai.core.model.AssistantMode
import java.util.Locale

enum class PromptCategory(val label: String, val mode: AssistantMode) {
    BUSINESS("Business", AssistantMode.BUSINESS),
    WRITING("Writing", AssistantMode.WRITING),
    MARKETING("Marketing", AssistantMode.WRITING),
    PLANNING("Planning", AssistantMode.BUSINESS),
    DOCUMENTS("Documents", AssistantMode.DOCUMENTS),
    RESEARCH("Research", AssistantMode.RESEARCH),
    PRODUCTIVITY("Personal productivity", AssistantMode.GENERAL),
}

data class PromptItem(
    val id: String,
    val title: String,
    val body: String,
    val category: PromptCategory,
    val isCustom: Boolean = false,
    val updatedAt: Long = 0L,
)

/** Filters shown as chips above the prompt list. */
sealed interface PromptFilter {
    data object All : PromptFilter

    data object Favorites : PromptFilter

    data object Mine : PromptFilter

    data class Category(val category: PromptCategory) : PromptFilter
}

object PromptLibrary {
    private fun p(id: String, category: PromptCategory, title: String, body: String) =
        PromptItem("starter-$id", title, body, category)

    /** Starter prompts shipped with the app. Square brackets mark the parts to fill in. */
    val starters: List<PromptItem> = listOf(
        p("biz-plan", PromptCategory.BUSINESS, "One-page business plan",
            "Draft a one-page business plan for [business idea] in [city/market]. Include the customer, offer, pricing, channels, costs, risks and the first three milestones."),
        p("biz-swot", PromptCategory.BUSINESS, "SWOT analysis",
            "Create a SWOT analysis for [company or product]. Be specific, and end with the two most important actions."),
        p("biz-pricing", PromptCategory.BUSINESS, "Pricing strategy",
            "Suggest three pricing models for [product/service] aimed at [customer]. Compare them in a table with pros, cons and when to use each."),
        p("biz-competitor", PromptCategory.BUSINESS, "Competitor snapshot",
            "Help me structure a competitor comparison for [market]. Give me the criteria to compare and a table template I can fill in."),
        p("biz-meeting", PromptCategory.BUSINESS, "Board update outline",
            "Outline a concise board update covering results, key metrics, risks, decisions needed and next quarter's priorities for [company]."),

        p("wr-email", PromptCategory.WRITING, "Professional email",
            "Write a clear, warm and professional email to [recipient] about [topic]. Keep it under 150 words and end with a specific next step."),
        p("wr-rewrite", PromptCategory.WRITING, "Rewrite with confidence",
            "Rewrite the following text so it sounds confident, concise and friendly, without changing its meaning:\n\n[paste text]"),
        p("wr-summary", PromptCategory.WRITING, "Executive summary",
            "Turn these notes into a polished executive summary with a headline, three key points and a recommendation:\n\n[paste notes]"),
        p("wr-proofread", PromptCategory.WRITING, "Proofread and explain",
            "Proofread the text below. Show the corrected version, then list the most important changes and why:\n\n[paste text]"),

        p("mk-launch", PromptCategory.MARKETING, "Launch announcement",
            "Write a launch announcement for [product] for [channel: LinkedIn/Instagram/email]. Give three variations with different hooks."),
        p("mk-audience", PromptCategory.MARKETING, "Customer persona",
            "Create two customer personas for [product] in [market], including goals, frustrations, buying triggers and the message that would resonate."),
        p("mk-campaign", PromptCategory.MARKETING, "Campaign ideas",
            "Suggest five low-budget marketing campaign ideas for [business] to reach [audience] in the next 30 days, with expected effort and impact."),
        p("mk-slogans", PromptCategory.MARKETING, "Taglines",
            "Write ten short, premium-sounding taglines for [brand]. The brand values are [values]."),

        p("pl-90day", PromptCategory.PLANNING, "90-day plan",
            "Create a 90-day plan to achieve [goal]. Break it into monthly themes, weekly actions and measurable milestones."),
        p("pl-project", PromptCategory.PLANNING, "Project plan",
            "Build a project plan for [project] with phases, tasks, owners, dependencies and risks, formatted as a table."),
        p("pl-event", PromptCategory.PLANNING, "Event checklist",
            "Make a detailed checklist for organising [event] for [number] people on [date], grouped by timeline."),
        p("pl-decision", PromptCategory.PLANNING, "Decision matrix",
            "Help me decide between [option A] and [option B]. Build a weighted decision matrix and explain the result."),

        p("doc-summary", PromptCategory.DOCUMENTS, "Summarise a document",
            "Summarise the attached document in five bullet points, then list any deadlines, amounts or obligations it mentions."),
        p("doc-questions", PromptCategory.DOCUMENTS, "Key questions",
            "Read the attached document and list the ten most important questions someone should ask about it, with the answers where the document gives them."),
        p("doc-reply", PromptCategory.DOCUMENTS, "Draft a reply",
            "Based on the attached letter, draft a polite, firm reply that addresses each point it raises."),
        p("doc-compare", PromptCategory.DOCUMENTS, "Contract check",
            "Review the attached contract text and highlight clauses about payment, termination, liability and renewal. This is not legal advice."),

        p("rs-overview", PromptCategory.RESEARCH, "Topic overview",
            "Give me a structured overview of [topic]: key concepts, main players, current debates and what I should read next. Note anything that may be out of date."),
        p("rs-compare", PromptCategory.RESEARCH, "Compare approaches",
            "Compare [approach A], [approach B] and [approach C] for [goal] in a table covering cost, effort, risks and best use cases."),
        p("rs-plan", PromptCategory.RESEARCH, "Research plan",
            "Create a research plan to understand [question], including hypotheses, sources to check and how to verify the findings."),
        p("rs-explain", PromptCategory.RESEARCH, "Explain like I'm new",
            "Explain [complex topic] as if I'm new to it, then give an advanced summary for when I'm ready."),

        p("pp-week", PromptCategory.PRODUCTIVITY, "Plan my week",
            "Help me plan my week. My priorities are [priorities], my fixed commitments are [commitments]. Suggest a realistic daily schedule."),
        p("pp-habits", PromptCategory.PRODUCTIVITY, "Build a habit",
            "Design a simple 30-day plan to build the habit of [habit], with a tiny daily action and a way to track progress."),
        p("pp-inbox", PromptCategory.PRODUCTIVITY, "Inbox zero",
            "Give me a 20-minute daily routine to keep my email inbox under control, with rules for what to reply, delegate, schedule or archive."),
        p("pp-learn", PromptCategory.PRODUCTIVITY, "Learning plan",
            "Create a four-week learning plan for [skill] with 30 minutes a day, free resources and a small project to finish."),
    )

    fun filter(
        prompts: List<PromptItem>,
        favorites: Set<String>,
        filter: PromptFilter,
        query: String,
    ): List<PromptItem> {
        val q = query.trim().lowercase(Locale.ROOT)
        return prompts
            .asSequence()
            .filter { p ->
                when (filter) {
                    PromptFilter.All -> true
                    PromptFilter.Favorites -> p.id in favorites
                    PromptFilter.Mine -> p.isCustom
                    is PromptFilter.Category -> p.category == filter.category
                }
            }
            .filter { p ->
                q.isEmpty() || p.title.lowercase(Locale.ROOT).contains(q) || p.body.lowercase(Locale.ROOT).contains(q) ||
                    p.category.label.lowercase(Locale.ROOT).contains(q)
            }
            .sortedWith(compareByDescending<PromptItem> { it.id in favorites }.thenBy { it.category.ordinal }.thenBy { it.title })
            .toList()
    }

    /** Validates a user-created prompt. Returns an error message, or null when valid. */
    fun validate(title: String, body: String): String? = when {
        title.isBlank() -> "Give the prompt a title."
        title.trim().length > 80 -> "Titles can be up to 80 characters."
        body.isBlank() -> "Write the prompt text."
        body.trim().length > 4_000 -> "Prompts can be up to 4,000 characters."
        else -> null
    }
}
