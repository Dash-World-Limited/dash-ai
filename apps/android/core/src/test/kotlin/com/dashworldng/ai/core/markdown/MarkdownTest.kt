package com.dashworldng.ai.core.markdown

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MarkdownTest {
    @Test
    fun `headings, paragraphs and rules`() {
        val blocks = Markdown.parse("# Title\n\nFirst line\nsecond line\n\n---\n\n### Small ###")
        assertEquals(1, assertIs<MdBlock.Heading>(blocks[0]).level)
        assertEquals("First line\nsecond line", assertIs<MdBlock.Paragraph>(blocks[1]).spans.joinToString("") { it.text })
        assertIs<MdBlock.Rule>(blocks[2])
        val small = assertIs<MdBlock.Heading>(blocks[3])
        assertEquals(3, small.level)
        assertEquals("Small", small.spans.single().text)
    }

    @Test
    fun `code blocks keep language labels and raw text`() {
        val blocks = Markdown.parse("Intro\n```kotlin\nval x = \"**not bold**\"\n\nprintln(x)\n```\nAfter")
        val code = assertIs<MdBlock.CodeBlock>(blocks[1])
        assertEquals("kotlin", code.language)
        assertEquals("val x = \"**not bold**\"\n\nprintln(x)", code.code)
        assertTrue(code.closed)
        assertEquals("After", assertIs<MdBlock.Paragraph>(blocks[2]).spans.single().text)
    }

    @Test
    fun `unterminated code fences render while streaming`() {
        val code = assertIs<MdBlock.CodeBlock>(Markdown.parse("```python\nprint('hi')").single())
        assertEquals("python", code.language)
        assertFalse(code.closed)
        assertNull(assertIs<MdBlock.CodeBlock>(Markdown.parse("```\nplain").single()).language)
    }

    @Test
    fun `lists including ordered, nested and task items`() {
        val list = assertIs<MdBlock.ListBlock>(Markdown.parse("1. First\n2. Second\n   continued\n  - nested\n- [x] done\n- [ ] todo").single())
        assertEquals(listOf(true, true, false, false, false), list.items.map { it.ordered })
        assertEquals(listOf(1, 2), list.items.take(2).map { it.number })
        assertEquals("Second continued", list.items[1].spans.joinToString("") { it.text })
        assertEquals(1, list.items[2].level)
        assertEquals(listOf(null, null, null, true, false), list.items.map { it.checked })
    }

    @Test
    fun `tables with alignment and ragged rows`() {
        val table = assertIs<MdBlock.Table>(Markdown.parse("| Phase | Cost |\n| :--- | ---: |\n| One | **\$10** |\n| Two |").single())
        assertEquals(listOf("Phase", "Cost"), table.header.map { it.single().text })
        assertEquals(listOf(MdAlign.START, MdAlign.END), table.alignments)
        assertEquals(2, table.rows.size)
        assertTrue(table.rows[0][1].single().bold)
        assertTrue(table.rows[1][1].isEmpty())
    }

    @Test
    fun `quotes`() {
        val quote = assertIs<MdBlock.Quote>(Markdown.parse("> Line one\n> line two").single())
        assertEquals("Line one\nline two", quote.spans.joinToString("") { it.text })
    }

    @Test
    fun `inline styles`() {
        val spans = Markdown.parseInline("Plain **bold** *italic* `code` ~~gone~~ [link](https://dash.world) snake_case_name")
        assertTrue(spans.first { it.text == "bold" }.bold)
        assertTrue(spans.first { it.text == "italic" }.italic)
        assertTrue(spans.first { it.text == "code" }.code)
        assertTrue(spans.first { it.text == "gone" }.strike)
        assertEquals("https://dash.world", spans.first { it.text == "link" }.link)
        assertTrue(spans.joinToString("") { it.text }.endsWith("snake_case_name"))
    }

    @Test
    fun `unmatched markers stay literal and unsafe links are not clickable`() {
        assertEquals("2 * 3 = 6 and **open", Markdown.parseInline("2 * 3 = 6 and **open").joinToString("") { it.text })
        assertNull(Markdown.parseInline("[x](javascript:alert(1))").first().link)
        val auto = Markdown.parseInline("See https://example.com/path.")
        assertEquals("https://example.com/path", auto.first { it.link != null }.text)
        assertEquals("a*b", Markdown.parseInline("a\\*b").joinToString("") { it.text })
    }
}
