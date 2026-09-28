package com.dashworldng.ai.core.markdown

/** A run of text with inline styling. */
data class MdSpan(
    val text: String,
    val bold: Boolean = false,
    val italic: Boolean = false,
    val code: Boolean = false,
    val strike: Boolean = false,
    val link: String? = null,
)

enum class MdAlign { START, CENTER, END }

data class MdListItem(
    val level: Int,
    val ordered: Boolean,
    val number: Int,
    val spans: List<MdSpan>,
    /** Task-list state: true/false for "- [x]"/"- [ ]", null for ordinary items. */
    val checked: Boolean? = null,
)

sealed interface MdBlock {
    data class Heading(val level: Int, val spans: List<MdSpan>) : MdBlock

    data class Paragraph(val spans: List<MdSpan>) : MdBlock

    /** [closed] is false while an answer is still streaming the block. */
    data class CodeBlock(val language: String?, val code: String, val closed: Boolean) : MdBlock

    data class ListBlock(val items: List<MdListItem>) : MdBlock

    data class Quote(val spans: List<MdSpan>) : MdBlock

    data class Table(val header: List<List<MdSpan>>, val alignments: List<MdAlign>, val rows: List<List<List<MdSpan>>>) : MdBlock

    data object Rule : MdBlock
}

/**
 * A small, dependency-free Markdown parser covering what assistants produce: headings, paragraphs,
 * fenced code with language labels, ordered/unordered/task lists, block quotes, GitHub tables,
 * horizontal rules and inline bold/italic/strike/code/links. It tolerates incomplete Markdown so
 * partially streamed answers render sensibly.
 */
object Markdown {
    private val heading = Regex("^(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val rule = Regex("^([-*_])(\\s*\\1){2,}\\s*$")
    private val listItem = Regex("^(\\s*)([-*+]|\\d{1,9}[.)])\\s+(.*)$")
    private val task = Regex("^\\[([ xX])]\\s+(.*)$")
    private val tableSeparator = Regex("^\\s*\\|?\\s*:?-+:?\\s*(\\|\\s*:?-+:?\\s*)*\\|?\\s*$")

    fun parse(markdown: String): List<MdBlock> {
        val lines = markdown.replace("\r\n", "\n").replace('\r', '\n').split("\n")
        val blocks = mutableListOf<MdBlock>()
        val paragraph = mutableListOf<String>()
        fun flushParagraph() {
            if (paragraph.isNotEmpty()) {
                blocks += MdBlock.Paragraph(parseInline(paragraph.joinToString("\n") { it.trim() }))
                paragraph.clear()
            }
        }

        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            when {
                trimmed.startsWith("```") || trimmed.startsWith("~~~") -> {
                    flushParagraph()
                    val fence = trimmed.take(3)
                    val language = trimmed.drop(3).trim().split(' ').firstOrNull()?.takeIf { it.isNotEmpty() }
                    val code = mutableListOf<String>()
                    var closed = false
                    i++
                    while (i < lines.size) {
                        if (lines[i].trim().startsWith(fence)) {
                            closed = true
                            break
                        }
                        code += lines[i]
                        i++
                    }
                    blocks += MdBlock.CodeBlock(language, code.joinToString("\n"), closed)
                }
                trimmed.isEmpty() -> flushParagraph()
                heading.matches(trimmed) -> {
                    flushParagraph()
                    val m = heading.find(trimmed)!!
                    blocks += MdBlock.Heading(m.groupValues[1].length, parseInline(m.groupValues[2]))
                }
                rule.matches(trimmed) -> {
                    flushParagraph()
                    blocks += MdBlock.Rule
                }
                trimmed.startsWith(">") -> {
                    flushParagraph()
                    val quote = mutableListOf<String>()
                    while (i < lines.size && lines[i].trim().startsWith(">")) {
                        quote += lines[i].trim().removePrefix(">").trim()
                        i++
                    }
                    blocks += MdBlock.Quote(parseInline(quote.joinToString("\n")))
                    continue
                }
                isTableStart(lines, i) -> {
                    flushParagraph()
                    val header = splitRow(lines[i])
                    val alignments = splitRow(lines[i + 1]).map { cell ->
                        val c = cell.trim()
                        when {
                            c.startsWith(":") && c.endsWith(":") -> MdAlign.CENTER
                            c.endsWith(":") -> MdAlign.END
                            else -> MdAlign.START
                        }
                    }
                    i += 2
                    val rows = mutableListOf<List<List<MdSpan>>>()
                    while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
                        val cells = splitRow(lines[i])
                        rows += List(header.size) { index -> parseInline(cells.getOrElse(index) { "" }) }
                        i++
                    }
                    blocks += MdBlock.Table(header.map(::parseInline), List(header.size) { alignments.getOrElse(it) { MdAlign.START } }, rows)
                    continue
                }
                listItem.matches(line) -> {
                    flushParagraph()
                    val items = mutableListOf<MdListItem>()
                    while (i < lines.size) {
                        val current = lines[i]
                        val match = listItem.find(current)
                        if (match != null) {
                            val indent = match.groupValues[1].replace("\t", "    ").length
                            val marker = match.groupValues[2]
                            val ordered = marker.first().isDigit()
                            var content = match.groupValues[3]
                            var checked: Boolean? = null
                            task.find(content)?.let {
                                checked = it.groupValues[1].lowercase() == "x"
                                content = it.groupValues[2]
                            }
                            items += MdListItem(
                                level = (indent / 2).coerceAtMost(3),
                                ordered = ordered,
                                number = if (ordered) marker.dropLast(1).toIntOrNull() ?: 1 else 0,
                                spans = parseInline(content),
                                checked = checked,
                            )
                            i++
                        } else if (current.isNotBlank() && current.startsWith("  ") && items.isNotEmpty()) {
                            // Continuation line of the previous item.
                            val last = items.removeAt(items.lastIndex)
                            items += last.copy(spans = last.spans + MdSpan(" ") + parseInline(current.trim()))
                            i++
                        } else {
                            break
                        }
                    }
                    blocks += MdBlock.ListBlock(items)
                    continue
                }
                else -> paragraph += line
            }
            i++
        }
        flushParagraph()
        return blocks
    }

    private fun isTableStart(lines: List<String>, index: Int): Boolean =
        index + 1 < lines.size && lines[index].contains('|') && lines[index + 1].contains('|') &&
            tableSeparator.matches(lines[index + 1]) && lines[index + 1].contains('-')

    private fun splitRow(line: String): List<String> {
        var s = line.trim()
        if (s.startsWith("|")) s = s.drop(1)
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.dropLast(1)
        val cells = mutableListOf<String>()
        val cell = StringBuilder()
        var j = 0
        while (j < s.length) {
            val c = s[j]
            if (c == '\\' && j + 1 < s.length && s[j + 1] == '|') {
                cell.append('|')
                j += 2
                continue
            }
            if (c == '|') {
                cells += cell.toString().trim()
                cell.setLength(0)
            } else {
                cell.append(c)
            }
            j++
        }
        cells += cell.toString().trim()
        return cells
    }

    private const val ESCAPABLE = "\\`*_{}[]()#+-.!|~>"

    /** Parses inline Markdown. Markers without a matching closer are shown literally. */
    fun parseInline(text: String): List<MdSpan> {
        val out = mutableListOf<MdSpan>()
        val buffer = StringBuilder()
        var bold = false
        var italic = false
        var strike = false
        var italicMarker = '*'
        fun flush() {
            if (buffer.isNotEmpty()) {
                out += MdSpan(buffer.toString(), bold = bold, italic = italic, strike = strike)
                buffer.setLength(0)
            }
        }

        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '\\' && i + 1 < text.length && text[i + 1] in ESCAPABLE -> {
                    buffer.append(text[i + 1])
                    i += 2
                }
                c == '`' -> {
                    val end = text.indexOf('`', i + 1)
                    if (end > i + 1) {
                        flush()
                        out += MdSpan(text.substring(i + 1, end), bold = bold, italic = italic, code = true, strike = strike)
                        i = end + 1
                    } else {
                        buffer.append(c)
                        i++
                    }
                }
                text.startsWith("**", i) || text.startsWith("__", i) -> {
                    val marker = text.substring(i, i + 2)
                    when {
                        bold -> {
                            flush()
                            bold = false
                        }
                        canOpen(text, i + 2) && hasCloser(text, i + 2, marker) -> {
                            flush()
                            bold = true
                        }
                        else -> buffer.append(marker)
                    }
                    i += 2
                }
                text.startsWith("~~", i) -> {
                    when {
                        strike -> {
                            flush()
                            strike = false
                        }
                        canOpen(text, i + 2) && hasCloser(text, i + 2, "~~") -> {
                            flush()
                            strike = true
                        }
                        else -> buffer.append("~~")
                    }
                    i += 2
                }
                c == '*' || c == '_' -> {
                    val wordInside = c == '_' && i > 0 && text[i - 1].isLetterOrDigit() && i + 1 < text.length && text[i + 1].isLetterOrDigit()
                    when {
                        wordInside -> buffer.append(c)
                        italic && c == italicMarker -> {
                            flush()
                            italic = false
                        }
                        !italic && canOpen(text, i + 1) && hasCloser(text, i + 1, c.toString()) -> {
                            flush()
                            italic = true
                            italicMarker = c
                        }
                        else -> buffer.append(c)
                    }
                    i++
                }
                c == '[' -> {
                    val close = text.indexOf("](", i + 1)
                    val end = if (close != -1) text.indexOf(')', close + 2) else -1
                    if (close != -1 && end != -1 && !text.substring(i + 1, close).contains('\n')) {
                        flush()
                        val label = text.substring(i + 1, close)
                        val url = text.substring(close + 2, end).trim()
                        out += MdSpan(label.ifEmpty { url }, bold = bold, italic = italic, strike = strike, link = safeLink(url))
                        i = end + 1
                    } else {
                        buffer.append(c)
                        i++
                    }
                }
                (text.startsWith("https://", i) || text.startsWith("http://", i)) && (i == 0 || !text[i - 1].isLetterOrDigit()) -> {
                    var end = i
                    while (end < text.length && !text[end].isWhitespace() && text[end] != '<') end++
                    while (end > i && text[end - 1] in ".,;:!?)\"'") end--
                    flush()
                    val url = text.substring(i, end)
                    out += MdSpan(url, bold = bold, italic = italic, strike = strike, link = url)
                    i = end
                }
                else -> {
                    buffer.append(c)
                    i++
                }
            }
        }
        flush()
        return merge(out)
    }

    /** Only http(s) and mailto links are clickable. */
    private fun safeLink(url: String): String? {
        val lower = url.lowercase()
        return if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:")) url else null
    }

    private fun canOpen(text: String, afterMarker: Int): Boolean =
        afterMarker < text.length && !text[afterMarker].isWhitespace()

    private fun hasCloser(text: String, from: Int, marker: String): Boolean {
        var index = text.indexOf(marker, from)
        while (index != -1) {
            if (index > from && !text[index - 1].isWhitespace()) return true
            index = text.indexOf(marker, index + 1)
        }
        return false
    }

    private fun merge(spans: List<MdSpan>): List<MdSpan> {
        val merged = mutableListOf<MdSpan>()
        for (span in spans) {
            val last = merged.lastOrNull()
            if (last != null && last.link == null && span.link == null && !last.code && !span.code &&
                last.bold == span.bold && last.italic == span.italic && last.strike == span.strike
            ) {
                merged[merged.lastIndex] = last.copy(text = last.text + span.text)
            } else {
                merged += span
            }
        }
        return merged
    }

    /** Plain text for copying/sharing: Markdown source is kept as-is (it reads well as text). */
    fun plainText(markdown: String): String = markdown.trim()
}
