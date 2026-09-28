package com.dashworldng.ai.core.chat

/**
 * Local, provider-free conversation titles. Same algorithm as apps/api/src/chat/titles.ts; both
 * are checked against packages/contracts/fixtures/titles.json.
 */
object TitleGenerator {
    const val DEFAULT_TITLE = "New chat"
    private const val MAX_TITLE = 48

    // JavaScript's \s is Unicode-aware; Java's is ASCII-only unless told otherwise, so spell it out.
    private const val WS = "\\s\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"

    private val codeFence = Regex("```[\\s\\S]*?(?:```|\\z)")
    private val link = Regex("\\[([^\\]]*)\\]\\([^)]*\\)")
    private val url = Regex("https?://[^$WS]+")
    private val symbols = Regex("[#*_`>~|]")
    private val whitespace = Regex("[$WS]+")
    private val listMarker = Regex("^(?:[-+]|[0-9]+[.)])[$WS]+")
    private val sentenceEnd = Regex("[.!?](?:[$WS]|\\z)")
    private val trailing = Regex("[$WS.,;:!?-]+\\z")

    fun generate(text: String): String {
        val withoutCode = codeFence.replace(text, "\n")
        var title = withoutCode.split("\n").map(::cleanLine).firstOrNull { it.isNotEmpty() } ?: return DEFAULT_TITLE

        val end = sentenceEnd.find(title)?.range?.first ?: -1
        if (end > 0) title = title.substring(0, end)
        title = stripTrailing(title.trim())

        if (title.length > MAX_TITLE) {
            val cut = title.lastIndexOf(' ', MAX_TITLE)
            val shortened = if (cut >= 20) title.substring(0, cut) else title.substring(0, MAX_TITLE)
            title = stripTrailing(shortened.trim()) + "…"
        }
        if (title.isEmpty() || title == "…") return DEFAULT_TITLE
        return title.substring(0, 1).uppercase() + title.substring(1)
    }

    private fun cleanLine(line: String): String {
        var s = link.replace(line, "$1")
        s = url.replace(s, " ")
        s = symbols.replace(s, " ")
        s = whitespace.replace(s, " ").trim()
        return listMarker.replace(s, "")
    }

    private fun stripTrailing(s: String): String = trailing.replace(s, "")
}
