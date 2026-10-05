@file:Suppress("unused", "UNUSED_PARAMETER")
package com.dashworldng.ai.data
import com.dashworldng.ai.core.documents.UploadSource
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
/** STUBS of Platform.kt (ConnectivityManager, ContentResolver). */
class AndroidConnectivityMonitor(context: android.content.Context) : ConnectivityMonitor { override val isOnline: StateFlow<Boolean> = MutableStateFlow(true) }
object DocumentReader { fun read(context: android.content.Context, uri: android.net.Uri): UploadSource = TODO() }
