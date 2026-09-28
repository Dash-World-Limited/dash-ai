package com.dashworldng.ai.core.demo

import com.dashworldng.ai.core.chat.ChatRequest
import com.dashworldng.ai.core.model.AssistantMode
import com.dashworldng.ai.core.model.ProviderId

/** Builds the clearly-labelled simulated answers used by Demo Mode. */
object DemoResponses {
    fun label(provider: ProviderId): String =
        "**Demo response · simulated ${provider.displayName} style.** This is not a real answer from ${provider.company}. " +
            "Nothing was sent to any AI provider — Demo Mode runs entirely on this device."

    fun compose(request: ChatRequest, provider: ProviderId): String {
        val topic = request.content.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.let {
            if (it.length > 80) it.take(79).trimEnd() + "…" else it
        } ?: "your request"
        val voice = if (provider == ProviderId.OPENAI) {
            "Here is how an answer will be laid out once a live provider is connected."
        } else {
            "Below is a sketch of the kind of structured answer you can expect with a live provider."
        }
        val body = when {
            request.attachments.isNotEmpty() -> documents(request)
            request.mode == AssistantMode.RESEARCH -> research()
            request.mode == AssistantMode.BUSINESS -> business()
            request.mode == AssistantMode.WRITING -> writing()
            request.mode == AssistantMode.DOCUMENTS -> documents(request)
            else -> general()
        }
        val code = if (Regex("(?i)\\b(code|kotlin|python|javascript|function|sql)\\b").containsMatchIn(request.content)) {
            "\n\n### Example code block\n\n```kotlin\nfun greet(name: String): String =\n    \"Hello, \$name — this snippet is a demo.\"\n```"
        } else {
            ""
        }
        return buildString {
            append(label(provider))
            append("\n\n")
            append("You asked about: *").append(topic.replace("*", "")).append("*. ").append(voice)
            append("\n\n")
            append(body)
            append(code)
            append("\n\n---\n\nTo get real answers, turn off Demo Mode in Settings and sign in to a Dash AI server with OpenAI or Claude configured.")
        }
    }

    private fun general() = """
        ### What a live answer includes

        - A direct answer to your question, written for the mode you picked
        - Clear structure: short paragraphs, **key points** in bold, and lists where they help
        - Follow-up suggestions you can tap to continue

        Demo Mode lets you try navigation, streaming, stopping, regenerating, model switching and Compare without using any API credits.
    """.trimIndent()

    private fun business() = """
        ## Plan outline (illustrative)

        1. **Objective** — the outcome and how it will be measured
        2. **Customer** — who buys, why, and what they pay today
        3. **Offer and pricing** — options with their trade-offs
        4. **Risks** — what could go wrong and early warning signs

        | Phase | Focus | Timing |
        | --- | --- | ---: |
        | 1 | Validate demand | Weeks 1–4 |
        | 2 | Pilot and price test | Weeks 5–8 |
        | 3 | Launch and measure | Weeks 9–12 |

        _Figures and timings above are placeholders, not analysis._
    """.trimIndent()

    private fun writing() = """
        ### Draft (placeholder text)

        > Thank you for your time today. I'm writing to follow up on our conversation and to share the next steps we agreed.

        A live answer would match your tone, audience and length, then offer optional edits:

        - Make it shorter
        - Make it more formal
        - Add a clear call to action
    """.trimIndent()

    private fun research() = """
        **Live web research is not connected.** No search provider is configured, so even live answers use the model's built-in knowledge, which may be out of date.

        ### Research outline (illustrative)

        1. Key concepts and definitions
        2. Main viewpoints and where they disagree
        3. What to verify with current sources
    """.trimIndent()

    private fun documents(request: ChatRequest): String {
        if (request.attachments.isEmpty()) {
            return "Attach a PDF, DOCX, TXT or image with the paperclip, then ask about it. In Demo Mode files are checked on this device only and are never read or uploaded."
        }
        val names = request.attachments.joinToString(", ") { "“${it.name}”" }
        return """
            **Demo Mode cannot read documents.** This simulated reply does not reflect the contents of $names — the file was checked on this device but not opened, uploaded or analysed.

            With a live Dash AI server, text is extracted from TXT, DOCX and text-based PDFs and sent only to the provider you choose. Image and scanned-PDF analysis is not available yet.
        """.trimIndent()
    }

    /** Splits text into small word groups to simulate token streaming. */
    fun chunks(text: String): List<String> {
        val words = Regex("\\S+\\s*|\\s+").findAll(text).map { it.value }.toList()
        return words.chunked(2) { it.joinToString("") }
    }
}
