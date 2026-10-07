package com.dashworldng.ai.ui.markdown

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.layout.Layout
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import com.dashworldng.ai.core.markdown.Markdown
import com.dashworldng.ai.core.markdown.MdAlign
import com.dashworldng.ai.core.markdown.MdBlock
import com.dashworldng.ai.core.markdown.MdSpan
import com.dashworldng.ai.ui.theme.DashTheme

/** Renders assistant Markdown: headings, lists, tables, quotes, links and code blocks. */
@Composable
fun MarkdownView(
    markdown: String,
    modifier: Modifier = Modifier,
    textStyle: TextStyle = MaterialTheme.typography.bodyLarge,
    onCopied: (String) -> Unit = {},
) {
    val blocks = remember(markdown) { Markdown.parse(markdown) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        blocks.forEach { block -> MarkdownBlock(block, textStyle, onCopied) }
    }
}

@Composable
private fun MarkdownBlock(block: MdBlock, textStyle: TextStyle, onCopied: (String) -> Unit) {
    when (block) {
        is MdBlock.Heading -> Text(
            text = inline(block.spans),
            style = when (block.level) {
                1 -> MaterialTheme.typography.headlineSmall
                2 -> MaterialTheme.typography.titleLarge
                else -> MaterialTheme.typography.titleMedium
            },
            color = DashTheme.colors.ink,
        )
        is MdBlock.Paragraph -> Text(inline(block.spans), style = textStyle, color = DashTheme.colors.ink)
        is MdBlock.CodeBlock -> CodeBlockView(block, onCopied)
        is MdBlock.ListBlock -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            block.items.forEach { item ->
                Row(Modifier.padding(start = (item.level * 16).dp)) {
                    val marker = when {
                        item.checked == true -> "☑"
                        item.checked == false -> "☐"
                        item.ordered -> "${item.number}."
                        else -> "•"
                    }
                    Text(marker, style = textStyle, color = DashTheme.colors.accentInk, modifier = Modifier.width(24.dp))
                    Text(inline(item.spans), style = textStyle, color = DashTheme.colors.ink)
                }
            }
        }
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(DashTheme.colors.accentInk, RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(12.dp))
            Text(inline(block.spans), style = textStyle.copy(fontStyle = FontStyle.Italic), color = DashTheme.colors.inkSecondary)
        }
        is MdBlock.Table -> TableView(block, textStyle)
        MdBlock.Rule -> HorizontalDivider(color = DashTheme.colors.outlineStrong)
    }
}

@Composable
private fun CodeBlockView(block: MdBlock.CodeBlock, onCopied: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = DashTheme.colors.codeBackground,
        border = BorderStroke(1.dp, DashTheme.colors.outlineStrong),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().background(DashTheme.colors.surfaceMuted).padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = block.language ?: "code",
                    style = MaterialTheme.typography.labelMedium,
                    color = DashTheme.colors.accentInk,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = {
                    clipboard.setText(AnnotatedString(block.code))
                    onCopied("Code copied")
                }) {
                    Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy code", tint = DashTheme.colors.inkSecondary, modifier = Modifier.size(18.dp))
                }
            }
            Text(
                text = block.code,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = DashTheme.colors.ink,
                softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
            )
        }
    }
}

/**
 * A grid table: every column is as wide as its widest cell (within 96–240 dp), so cells line up;
 * wide tables scroll horizontally instead of squeezing the text.
 */
@Composable
private fun TableView(table: MdBlock.Table, textStyle: TextStyle) {
    val c = DashTheme.colors
    val columns = maxOf(table.header.size, table.rows.maxOfOrNull { it.size } ?: 0)
    val rows = listOf(table.header) + table.rows
    Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        Layout(
            modifier = Modifier.border(1.dp, c.outlineStrong, RoundedCornerShape(10.dp)).clip(RoundedCornerShape(10.dp)),
            content = {
                rows.forEachIndexed { r, cells ->
                    for (col in 0 until columns) {
                        val header = r == 0
                        Text(
                            text = inline(cells.getOrNull(col).orEmpty()),
                            style = textStyle.copy(fontWeight = if (header) FontWeight.SemiBold else textStyle.fontWeight),
                            color = c.ink,
                            textAlign = when (table.alignments.getOrNull(col)) {
                                MdAlign.CENTER -> TextAlign.Center
                                MdAlign.END -> TextAlign.End
                                else -> TextAlign.Start
                            },
                            modifier = Modifier
                                .background(if (header) c.surfaceMuted else c.surface)
                                .drawBehind { if (r > 0) drawLine(c.outline, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx()) }
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                        )
                    }
                }
            },
        ) { measurables, _ ->
            val min = 96.dp.roundToPx()
            val max = 240.dp.roundToPx()
            val widths = IntArray(columns) { col ->
                rows.indices.maxOf { r -> measurables[r * columns + col].maxIntrinsicWidth(Int.MAX_VALUE) }.coerceIn(min, max)
            }
            // Each cell is measured once, at its column's width and its row's tallest height.
            val heights = IntArray(rows.size) { r -> (0 until columns).maxOf { col -> measurables[r * columns + col].minIntrinsicHeight(widths[col]) } }
            val remeasured = measurables.mapIndexed { i, m -> m.measure(Constraints.fixed(widths[i % columns], heights[i / columns])) }
            layout(widths.sum(), heights.sum()) {
                var y = 0
                for (r in rows.indices) {
                    var x = 0
                    for (col in 0 until columns) {
                        remeasured[r * columns + col].place(x, y)
                        x += widths[col]
                    }
                    y += heights[r]
                }
            }
        }
    }
}

@Composable
private fun inline(spans: List<MdSpan>): AnnotatedString {
    val codeBackground = DashTheme.colors.surfaceSelected
    val accent = DashTheme.colors.accentInk
    return remember(spans, codeBackground, accent) { inlineText(spans, codeBackground, accent) }
}

private fun inlineText(spans: List<MdSpan>, codeBackground: androidx.compose.ui.graphics.Color, accent: androidx.compose.ui.graphics.Color): AnnotatedString = buildAnnotatedString {
    spans.forEach { span ->
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.Bold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) FontFamily.Monospace else null,
            background = if (span.code) codeBackground else androidx.compose.ui.graphics.Color.Unspecified,
            textDecoration = if (span.strike) TextDecoration.LineThrough else null,
            color = if (span.code) accent else androidx.compose.ui.graphics.Color.Unspecified,
        )
        val link = span.link
        if (link != null) {
            withLink(
                LinkAnnotation.Url(
                    url = link,
                    styles = TextLinkStyles(style = SpanStyle(color = accent, textDecoration = TextDecoration.Underline)),
                ),
            ) {
                withStyle(style) { append(span.text) }
            }
        } else {
            withStyle(style) { append(span.text) }
        }
    }
}
