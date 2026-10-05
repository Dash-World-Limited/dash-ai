package com.dashworldng.ai.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.provider.OpenableColumns
import com.dashworldng.ai.core.documents.UploadSource
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AndroidConnectivityMonitor(context: Context) : ConnectivityMonitor {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private val state = MutableStateFlow(currentlyOnline())
    override val isOnline: StateFlow<Boolean> = state.asStateFlow()

    init {
        manager?.registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    state.value = true
                }

                override fun onLost(network: Network) {
                    state.value = currentlyOnline()
                }

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    state.value = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                }
            },
        )
    }

    private fun currentlyOnline(): Boolean {
        val m = manager ?: return true
        val network = m.activeNetwork ?: return false
        return m.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }
}

/** Reads a picked document's metadata. The bytes are opened only when an upload actually happens. */
object DocumentReader {
    fun read(context: Context, uri: Uri): UploadSource {
        val resolver = context.contentResolver
        var name = "document"
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = cursor.getString(nameIndex) ?: name
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        return UploadSource(
            name = name,
            mimeType = resolver.getType(uri),
            sizeBytes = size,
            open = { resolver.openInputStream(uri) ?: error("Could not open the selected file") },
        )
    }
}
