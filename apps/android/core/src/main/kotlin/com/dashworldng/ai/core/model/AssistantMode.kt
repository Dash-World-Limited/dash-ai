package com.dashworldng.ai.core.model

/**
 * Assistant modes. Each mode changes the server-side instructions (see apps/api
 * providers/instructions.ts) and the suggested prompts shown in the app.
 */
enum class AssistantMode(
    val wire: String,
    val label: String,
    val tagline: String,
    val composerHint: String,
    val suggestions: List<String>,
    /** Shown whenever the mode has a capability limit the user should know about. */
    val limitation: String? = null,
) {
    GENERAL(
        wire = "general",
        label = "General",
        tagline = "Everyday questions, ideas and conversation.",
        composerHint = "Ask Dash AI anything…",
        suggestions = listOf(
            "Explain a complex topic to me in simple terms",
            "Help me plan my week around three priorities",
            "Give me five creative ideas for a weekend project",
            "What questions should I ask before making a big purchase?",
        ),
    ),
    BUSINESS(
        wire = "business",
        label = "Business",
        tagline = "Plans, strategy, pricing and operations.",
        composerHint = "Describe the business goal or decision…",
        suggestions = listOf(
            "Draft a one-page business plan for a premium coffee kiosk",
            "Create a SWOT analysis for launching a delivery service",
            "Suggest a pricing strategy for a new subscription product",
            "Outline a 90-day go-to-market plan with milestones",
        ),
    ),
    WRITING(
        wire = "writing",
        label = "Writing",
        tagline = "Professional drafts, edits and tone.",
        composerHint = "What should we write or improve?",
        suggestions = listOf(
            "Write a warm, professional email introducing our company",
            "Rewrite this paragraph to sound confident and concise",
            "Draft a LinkedIn post announcing a product launch",
            "Turn my notes into a polished executive summary",
        ),
    ),
    DOCUMENTS(
        wire = "documents",
        label = "Documents",
        tagline = "Summaries and answers from your files.",
        composerHint = "Attach a document, then ask about it…",
        suggestions = listOf(
            "Summarise the attached document in five bullet points",
            "List the key dates, amounts and obligations in this file",
            "What are the main risks mentioned in this document?",
            "Draft a reply based on the attached letter",
        ),
        limitation = "Text is extracted from TXT, DOCX and text-based PDFs. Image and scanned-PDF analysis is not available yet.",
    ),
    RESEARCH(
        wire = "research",
        label = "Research",
        tagline = "Structured research from built-in model knowledge.",
        composerHint = "What would you like to research?",
        suggestions = listOf(
            "Give me a structured overview of the electric vehicle market",
            "Compare three approaches to remote team management",
            "What are the main arguments for and against a four-day week?",
            "Create a research plan for entering a new market",
        ),
        limitation = "Live web research is not connected. Answers come from the model's built-in knowledge and may be out of date.",
    );

    companion object {
        fun fromWire(value: String): AssistantMode? = entries.firstOrNull { it.wire == value }
    }
}
