package com.dashworldng.ai.ui.auth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Science
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.auth.AuthValidation
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.Banner
import com.dashworldng.ai.ui.components.BannerTone
import com.dashworldng.ai.ui.components.DashWordmark
import com.dashworldng.ai.ui.components.GoldButton
import com.dashworldng.ai.ui.components.QuietButton
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.settings.ServerDialog
import com.dashworldng.ai.ui.theme.DashColors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class AuthUiState(
    val creating: Boolean = false,
    val name: String = "",
    val email: String = "",
    val password: String = "",
    val nameError: String? = null,
    val emailError: String? = null,
    val passwordError: String? = null,
    val busy: Boolean = false,
    val error: String? = null,
)

class AuthViewModel(private val services: AppServices) : ViewModel() {
    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()
    val settings = services.settings.settings

    fun setCreating(creating: Boolean) = _state.update { it.copy(creating = creating, error = null) }
    fun setName(v: String) = _state.update { it.copy(name = v, nameError = null) }
    fun setEmail(v: String) = _state.update { it.copy(email = v, emailError = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, passwordError = null) }

    fun setServer(url: String) {
        viewModelScope.launch { services.settings.update { it.copy(serverUrl = url) } }
    }

    fun submit(onSuccess: () -> Unit) {
        val s = _state.value
        val nameError = if (s.creating) AuthValidation.nameError(s.name) else null
        val emailError = AuthValidation.emailError(s.email)
        val passwordError = AuthValidation.passwordError(s.password, s.creating)
        if (nameError != null || emailError != null || passwordError != null) {
            _state.update { it.copy(nameError = nameError, emailError = emailError, passwordError = passwordError) }
            return
        }
        val auth = services.authService()
        if (auth == null) {
            _state.update { it.copy(error = "The server address is not valid. Change it below.") }
            return
        }
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try {
                val session = if (s.creating) auth.register(s.email, s.password, s.name) else auth.login(s.email, s.password)
                services.tokens.set(session.token)
                services.settings.update {
                    it.copy(
                        demoMode = false,
                        account = AccountInfo(session.user.id, session.user.email, session.user.displayName, isDemo = false),
                    )
                }
                _state.update { AuthUiState() }
                onSuccess()
            } catch (e: ApiException) {
                _state.update { it.copy(busy = false, error = e.error.message) }
            }
        }
    }

    fun continueInDemo(onDone: () -> Unit) {
        viewModelScope.launch {
            services.settings.update {
                it.copy(demoMode = true, account = AccountInfo("demo-local", null, "Demo user", isDemo = true))
            }
            onDone()
        }
    }
}

@Composable
fun AuthScreen(services: AppServices, onSignedIn: () -> Unit) {
    val vm = dashViewModel { AuthViewModel(services) }
    val state by vm.state.collectAsStateWithLifecycle()
    val settings by vm.settings.collectAsStateWithLifecycle()
    var showPassword by remember { mutableStateOf(false) }
    var editingServer by remember { mutableStateOf(false) }
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedBorderColor = DashColors.GoldDeep,
        unfocusedBorderColor = DashColors.Outline,
        cursorColor = DashColors.Gold,
        focusedLabelColor = DashColors.Gold,
    )

    Column(
        Modifier
            .fillMaxSize()
            .background(DashColors.Black)
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 24.dp)
            .testTag("auth_screen"),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(12.dp))
        DashWordmark(size = 28.dp)
        Text("Think. Create. Execute.", style = MaterialTheme.typography.bodyMedium, color = DashColors.Grey)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ModeTab("Sign in", selected = !state.creating, tag = "tab_sign_in") { vm.setCreating(false) }
            ModeTab("Create account", selected = state.creating, tag = "tab_create") { vm.setCreating(true) }
        }
        if (state.creating) {
            OutlinedTextField(
                value = state.name,
                onValueChange = vm::setName,
                label = { Text("Name") },
                isError = state.nameError != null,
                supportingText = supporting(state.nameError),
                singleLine = true,
                colors = fieldColors,
                modifier = Modifier.fillMaxWidth().testTag("auth_name"),
            )
        }
        OutlinedTextField(
            value = state.email,
            onValueChange = vm::setEmail,
            label = { Text("Email") },
            isError = state.emailError != null,
            supportingText = supporting(state.emailError),
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth().testTag("auth_email"),
        )
        OutlinedTextField(
            value = state.password,
            onValueChange = vm::setPassword,
            label = { Text("Password") },
            isError = state.passwordError != null,
            supportingText = supporting(state.passwordError ?: if (state.creating) "At least 8 characters" else null),
            singleLine = true,
            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            trailingIcon = {
                IconButton(onClick = { showPassword = !showPassword }) {
                    Icon(
                        if (showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                        contentDescription = if (showPassword) "Hide password" else "Show password",
                    )
                }
            },
            colors = fieldColors,
            modifier = Modifier.fillMaxWidth().testTag("auth_password"),
        )
        state.error?.let { Banner(it, tone = BannerTone.ERROR, modifier = Modifier.testTag("auth_error")) }
        GoldButton(
            text = if (state.creating) "Create account" else "Sign in",
            onClick = { vm.submit(onSignedIn) },
            enabled = !state.busy,
            modifier = Modifier.fillMaxWidth().testTag("auth_submit"),
        )
        if (state.busy) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = DashColors.Gold)
                Spacer(Modifier.size(10.dp))
                Text("Contacting the Dash AI server…", style = MaterialTheme.typography.bodySmall, color = DashColors.Grey)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Server: ${settings.serverUrl.ifBlank { "not set" }}",
                style = MaterialTheme.typography.bodySmall,
                color = DashColors.GreyDim,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { editingServer = true }) { Text("Change", color = DashColors.Gold) }
        }
        HorizontalDivider(color = DashColors.OutlineSoft)
        QuietButton("Continue in Demo Mode", onClick = { vm.continueInDemo(onSignedIn) }, modifier = Modifier.fillMaxWidth().testTag("continue_demo"))
        Banner(
            "Demo Mode needs no account and sends nothing to any server. Answers are simulated and clearly labelled.",
            icon = Icons.Rounded.Science,
        )
    }

    if (editingServer) {
        ServerDialog(
            initial = settings.serverUrl,
            onDismiss = { editingServer = false },
            onSave = {
                vm.setServer(it)
                editingServer = false
            },
        )
    }
}

private fun supporting(text: String?): (@Composable () -> Unit)? {
    if (text == null) return null
    return { Text(text) }
}

@Composable
private fun ModeTab(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        modifier = Modifier
            .testTag(tag)
            .background(if (selected) DashColors.GoldContainer else DashColors.Black, RoundedCornerShape(12.dp)),
    ) {
        Text(label, color = if (selected) DashColors.GoldLight else DashColors.Grey, style = MaterialTheme.typography.labelLarge)
    }
}
