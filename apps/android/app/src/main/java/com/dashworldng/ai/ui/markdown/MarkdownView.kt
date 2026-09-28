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
import com.dashworldng.ai.ui.theme.DashColors

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
            color = if (block.level <= 2) DashColors.GoldLight else DashColors.White,
        )
        is MdBlock.Paragraph -> Text(inline(block.spans), style = textStyle, color = DashColors.White)
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
                    Text(marker, style = textStyle, color = DashColors.Gold, modifier = Modifier.width(24.dp))
                    Text(inline(item.spans), style = textStyle, color = DashColors.White)
                }
            }
        }
        is MdBlock.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
            Box(Modifier.width(3.dp).fillMaxHeight().background(DashColors.Gold, RoundedCornerShape(2.dp)))
            Spacer(Modifier.width(12.dp))
            Text(inline(block.spans), style = textStyle.copy(fontStyle = FontStyle.Italic), color = DashColors.Grey)
        }
        is MdBlock.Table -> TableView(block, textStyle)
        MdBlock.Rule -> HorizontalDivider(color = DashColors.Outline)
    }
}

@Composable
private fun CodeBlockView(block: MdBlock.CodeBlock, onCopied: (String) -> Unit) {
    val clipboard = LocalClipboardManager.current
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = DashColors.CodeBackground,
        border = BorderStroke(1.dp, DashColors.Outline),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Row(
                Modifier.fillMaxWidth().background(DashColors.SurfaceHigh).padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = block.language ?: "code",
                    style = MaterialTheme.typography.labelMedium,
                    color = DashColors.Gold,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = {
                    clipboard.setText(AnnotatedString(block.code))
                    onCopied("Code copied")
                }) {
                    Icon(Icons.Rounded.ContentCopy, contentDescription = "Copy code", tint = DashColors.Grey, modifier = Modifier.size(18.dp))
                }
            }
            Text(
                text = block.code,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                color = DashColors.White,
                softWrap = false,
                modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
            )
        }
    }
}

@Composable
private fun TableView(table: MdBlock.Table, textStyle: TextStyle) {
    Box(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState()),
    ) {
        Column(Modifier.border(1.dp, DashColors.Outline, RoundedCornerShape(10.dp))) {
            TableRow(table.header, table.alignments, textStyle, header = true)
            table.rows.forEach { row ->
                HorizontalDivider(color = DashColors.OutlineSoft)
                TableRow(row, table.alignments, textStyle, header = false)
            }
        }
    }
}

@Composable
private fun TableRow(cells: List<List<MdSpan>>, alignments: List<MdAlign>, textStyle: TextStyle, header: Boolean) {
    Row(
        Modifier
            .height(IntrinsicSize.Min)
            .background(if (header) DashColors.SurfaceHigh else DashColors.Black),
    ) {
        cells.forEachIndexed { index, cell ->
            Text(
                text = inline(cell),
                style = textStyle.copy(fontWeight = if (header) FontWeight.SemiBold else textStyle.fontWeight),
                color = if (header) DashColors.GoldLight else DashColors.White,
                textAlign = when (alignments.getOrNull(index)) {
                    MdAlign.CENTER -> TextAlign.Center
                    MdAlign.END -> TextAlign.End
                    else -> TextAlign.Start
                },
                modifier = Modifier
                    .widthIn(min = 96.dp, max = 240.dp)
                    .fillMaxHeight()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
}

private fun inline(spans: List<MdSpan>): AnnotatedString = buildAnnotatedString {
    spans.forEach { span ->
        val style = SpanStyle(
            fontWeight = if (span.bold) FontWeight.Bold else null,
            fontStyle = if (span.italic) FontStyle.Italic else null,
            fontFamily = if (span.code) FontFamily.Monospace else null,
            background = if (span.code) DashColors.SurfaceHighest else androidx.compose.ui.graphics.Color.Unspecified,
            textDecoration = if (span.strike) TextDecoration.LineThrough else null,
            color = if (span.code) DashColors.GoldLight else androidx.compose.ui.graphics.Color.Unspecified,
        )
        val link = span.link
        if (link != null) {
            withLink(
                LinkAnnotation.Url(
                    url = link,
                    styles = TextLinkStyles(style = SpanStyle(color = DashColors.Gold, textDecoration = TextDecoration.Underline)),
                ),
            ) {
                withStyle(style) { append(span.text) }
            }
        } else {
            withStyle(style) { append(span.text) }
        }
    }
}
