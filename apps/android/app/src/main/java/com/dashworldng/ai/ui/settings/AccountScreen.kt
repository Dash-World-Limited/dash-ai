package com.dashworldng.ai.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.remote.UsageSummaryDto
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AppSettings
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.DemoBadge
import com.dashworldng.ai.ui.components.GoldButton
import com.dashworldng.ai.ui.components.QuietButton
import com.dashworldng.ai.ui.components.SectionTitle
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AccountExtras(val usage: UsageSummaryDto? = null, val busy: Boolean = false, val error: String? = null)

class AccountViewModel(private val services: AppServices) : ViewModel() {
    val settings: StateFlow<AppSettings> = services.settings.settings
    private val _extras = MutableStateFlow(AccountExtras())
    val extras: StateFlow<AccountExtras> = _extras.asStateFlow()

    init {
        val account = settings.value.account
        if (account != null && !account.isDemo && !settings.value.demoMode) loadUsage()
    }

    private fun loadUsage() {
        val client = services.apiClient() ?: return
        viewModelScope.launch {
            try {
                val usage = client.call { usage() }
                _extras.update { it.copy(usage = usage) }
            } catch (e: ApiException) {
                _extras.update { it.copy(error = e.error.message) }
            }
        }
    }

    /**
     * Signs out and removes this account's conversations, documents, prompts and sync state from the
     * device, online or offline (see LocalAccountGuard). The server session is revoked when reachable.
     */
    fun signOut(onDone: () -> Unit) {
        viewModelScope.launch {
            val account = settings.value.account
            val signedIn = account != null && !account.isDemo
            services.accountGuard.signOut(revokeServerSession = { if (signedIn) services.authService()?.logout() })
            services.settings.update { it.copy(account = null, demoMode = true) }
            onDone()
        }
    }

    /** Deletes the server account and all of its data, then clears this device. */
    fun deleteAccount(onDone: () -> Unit) {
        val auth = services.authService() ?: return
        _extras.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                auth.deleteAccount()
                // The server already ended every session; this removes the account's local data too.
                services.accountGuard.signOut(revokeServerSession = {})
                services.settings.update { it.copy(account = null, demoMode = true) }
                onDone()
            } catch (e: ApiException) {
                _extras.update { it.copy(busy = false, error = e.error.message) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(services: AppServices, onBack: () -> Unit, onSignedOut: () -> Unit) {
    val vm = dashViewModel { AccountViewModel(services) }
    val settings by vm.settings.collectAsStateWithLifecycle()
    val extras by vm.extras.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf(false) }
    val account = settings.account

    Scaffold(
        containerColor = DashColors.Black,
        topBar = {
            TopAppBar(
                title = { Text("Account") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, contentDescription = "Back") } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = DashColors.Black),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp).testTag("account_screen"),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SettingCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(52.dp).background(DashColors.GoldContainer, CircleShape), contentAlignment = Alignment.Center) {
                        Text(
                            (account?.displayName ?: "?").take(1).uppercase(),
                            style = MaterialTheme.typography.titleLarge,
                            color = DashColors.GoldLight,
                        )
                    }
                    Spacer(Modifier.width(14.dp))
                    Column(Modifier.weight(1f)) {
                        Text(account?.displayName ?: "Not signed in", style = MaterialTheme.typography.titleMedium, color = DashColors.White)
                        Text(
                            when {
                                account == null -> "Sign in to use a live Dash AI server."
                                account.isDemo -> "Local demo profile · nothing is stored on a server"
                                else -> account.email ?: ""
                            },
                            style = MaterialTheme.typography.bodySmall,
                            color = DashColors.Grey,
                        )
                    }
                    if (account?.isDemo == true) DemoBadge()
                }
            }

            if (account != null && !account.isDemo) {
                SectionTitle("Usage")
                SettingCard {
                    val usage = extras.usage
                    if (usage == null || usage.totals.isEmpty()) {
                        Text(extras.error ?: "No usage recorded yet.", style = MaterialTheme.typography.bodySmall, color = DashColors.Grey)
                    } else {
                        usage.totals.forEach { t ->
                            Text(
                                "${if (t.provider == "openai") "OpenAI" else "Claude"} · ${t.requests} responses · ${t.inputTokens + t.outputTokens} tokens",
                                style = MaterialTheme.typography.bodyMedium,
                                color = DashColors.White,
                            )
                        }
                    }
                }
            }

            extras.error?.let { Text(it, color = DashColors.Error, style = MaterialTheme.typography.bodySmall) }
            GoldButton(
                if (account == null || account.isDemo) "Sign in or create an account" else "Sign out",
                onClick = { vm.signOut(onSignedOut) },
                modifier = Modifier.fillMaxWidth().testTag("sign_out"),
            )
            if (account != null && !account.isDemo) {
                QuietButton("Delete account", onClick = { confirmDelete = true }, enabled = !extras.busy, modifier = Modifier.fillMaxWidth())
                Text(
                    "Deleting your account removes it and all server-side conversations, documents and usage records, then clears this device.",
                    style = MaterialTheme.typography.bodySmall,
                    color = DashColors.GreyDim,
                )
            }
        }
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Delete your account?") },
            text = { Text("This permanently deletes your Dash AI account and its data on the server, and clears this device. This can't be undone.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    vm.deleteAccount(onSignedOut)
                }) { Text("Delete account", color = DashColors.Error) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
            containerColor = DashColors.SurfaceHigh,
        )
    }
}
