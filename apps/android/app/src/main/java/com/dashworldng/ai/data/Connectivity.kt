package com.dashworldng.ai.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface ConnectivityMonitor {
    val isOnline: StateFlow<Boolean>
}

class FixedConnectivity(online: Boolean = true) : ConnectivityMonitor {
    val state = MutableStateFlow(online)
    override val isOnline: StateFlow<Boolean> = state.asStateFlow()
}
