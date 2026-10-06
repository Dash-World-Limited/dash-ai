package com.dashworldng.ai.data.share

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.data.DocumentReader
import com.dashworldng.ai.di.IncomingShare

/**
 * Turns "Share → DASH AI" from another app into an [IncomingShare]. Files are read lazily (only when
 * uploaded) and checked by the same file rules as the picker.
 *
 * Only `content://` items from other apps are accepted. A `file://` path, or a URI that points into
 * DASH AI's own storage, is refused: otherwise any app could make DASH AI upload its private files.
 */
object ShareIntents {
    fun parse(context: Context, intent: Intent?): IncomingShare? {
        if (intent == null) return null
        val action = intent.action
        if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()?.take(Limits.MAX_MESSAGE_CHARS)?.takeIf { it.isNotEmpty() }
        val uris = streams(intent, action)
        val accepted = uris.filter { isSafe(context, it) }.take(Limits.MAX_ATTACHMENTS_PER_MESSAGE)
        val files = accepted.mapNotNull { uri -> runCatching { DocumentReader.read(context, uri) }.getOrNull() }
        val refused = uris.size - files.size
        if (text == null && files.isEmpty() && refused == 0) return null
        return IncomingShare(text = text, files = files, refused = refused)
    }

    fun isSafe(context: Context, uri: Uri): Boolean {
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
        val authority = uri.authority ?: return false
        val own = context.packageName
        return authority != own && !authority.startsWith("$own.")
    }

    @Suppress("DEPRECATION")
    private fun streams(intent: Intent, action: String): List<Uri> = when (action) {
        Intent.ACTION_SEND -> listOfNotNull(
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM),
        )
        else -> (
            if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)
            ).orEmpty().filterNotNull()
    }
}
