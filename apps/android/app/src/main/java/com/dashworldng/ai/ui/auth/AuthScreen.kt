package com.dashworldng.ai.ui.auth

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusDirection
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.dashworldng.ai.core.auth.AuthValidation
import com.dashworldng.ai.core.presentation.AuthFailure
import com.dashworldng.ai.core.presentation.AuthFailureKind
import com.dashworldng.ai.core.presentation.AuthFailures
import com.dashworldng.ai.core.presentation.StatusTone
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.stream.ApiError
import com.dashworldng.ai.core.stream.ApiException
import com.dashworldng.ai.data.settings.AccountInfo
import com.dashworldng.ai.di.AppServices
import com.dashworldng.ai.ui.components.BrandMark
import com.dashworldng.ai.ui.components.BrandWordmark
import com.dashworldng.ai.ui.components.ContentWidth
import com.dashworldng.ai.ui.components.DashTextField
import com.dashworldng.ai.ui.components.Notice
import com.dashworldng.ai.ui.components.PrimaryButton
import com.dashworldng.ai.ui.components.SecondaryButton
import com.dashworldng.ai.ui.components.TextAction
import com.dashworldng.ai.ui.dashViewModel
import com.dashworldng.ai.ui.settings.ServerDialog
import com.dashworldng.ai.ui.theme.DashTheme
import com.dashworldng.ai.ui.theme.Radii
import com.dashworldng.ai.ui.theme.Sizing
import com.dashworldng.ai.ui.theme.Spacing
import kotlinx.coroutines.CancellationException
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
    val failure: AuthFailure? = null,
)

/**
 * Email and password are the only sign-in methods the DASH AI server supports, so they are the only
 * ones offered. Demo Mode needs no account and never touches the server.
 */
class AuthViewModel(private val services: AppServices) : ViewModel() {
    private val _state = MutableStateFlow(AuthUiState())
    val state: StateFlow<AuthUiState> = _state.asStateFlow()
    val settings = services.settings.settings
    val online = services.connectivity.isOnline

    fun setCreating(creating: Boolean) = _state.update { it.copy(creating = creating, failure = null, nameError = null, passwordError = null) }
    fun setName(v: String) = _state.update { it.copy(name = v, nameError = null) }
    fun setEmail(v: String) = _state.update { it.copy(email = v, emailError = null) }
    fun setPassword(v: String) = _state.update { it.copy(password = v, passwordError = null) }
    fun dismissFailure() = _state.update { it.copy(failure = null) }

    fun setServer(url: String) {
        viewModelScope.launch { services.settings.update { it.copy(serverUrl = url) } }
    }

    fun submit(onSuccess: () -> Unit) {
        val s = _state.value
        if (s.busy) return
        val nameError = if (s.creating) AuthValidation.nameError(s.name) else null
        val emailError = AuthValidation.emailError(s.email)
        val passwordError = AuthValidation.passwordError(s.password, s.creating)
        if (nameError != null || emailError != null || passwordError != null) {
            _state.update { it.copy(nameError = nameError, emailError = emailError, passwordError = passwordError) }
            return
        }
        if (!online.value) {
            _state.update { it.copy(failure = AuthFailures.from(ApiError.network(), online = false)) }
            return
        }
        val auth = services.authService()
        if (auth == null) {
            _state.update { it.copy(failure = AuthFailure(AuthFailureKind.SERVER, "The server address is not valid. Change it below.", canRetry = false)) }
            return
        }
        _state.update { it.copy(busy = true, failure = null) }
        viewModelScope.launch {
            try {
                val session = if (s.creating) auth.register(s.email, s.password, s.name) else auth.login(s.email, s.password)
                // Before anything of the new account is stored: remove another account's data left on this device.
                services.accountGuard.onSignedIn(session.user.id)
                services.tokens.set(session.token)
                services.syncTracker.reset()
                services.settings.update {
                    it.copy(
                        demoMode = false,
                        account = AccountInfo(session.user.id, session.user.email, session.user.displayName, isDemo = false),
                    )
                }
                _state.update { AuthUiState() }
                onSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                // The password is cleared after a failure that was about the credentials.
                val failure = AuthFailures.from(e.error, online.value)
                _state.update {
                    it.copy(
                        busy = false,
                        failure = failure,
                        password = if (failure.kind == AuthFailureKind.INVALID_CREDENTIALS) "" else it.password,
                    )
                }
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, failure = AuthFailures.from(ApiError.unexpected, online.value)) }
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
    val online by vm.online.collectAsStateWithLifecycle()
    var editingServer by rememberSaveable { mutableStateOf(false) }

    AuthContent(
        state = state,
        online = online,
        serverUrl = settings.serverUrl,
        onCreating = vm::setCreating,
        onName = vm::setName,
        onEmail = vm::setEmail,
        onPassword = vm::setPassword,
        onSubmit = { vm.submit(onSignedIn) },
        onDismissFailure = vm::dismissFailure,
        onDemo = { vm.continueInDemo(onSignedIn) },
        onChangeServer = { editingServer = true },
    )
    if (editingServer) {
        ServerDialog(initial = settings.serverUrl, onDismiss = { editingServer = false }, onSave = {
            vm.setServer(it)
            editingServer = false
        })
    }
}

@Composable
fun AuthContent(
    state: AuthUiState,
    online: Boolean,
    serverUrl: String,
    onCreating: (Boolean) -> Unit,
    onName: (String) -> Unit,
    onEmail: (String) -> Unit,
    onPassword: (String) -> Unit,
    onSubmit: () -> Unit,
    onDismissFailure: () -> Unit,
    onDemo: () -> Unit,
    onChangeServer: () -> Unit,
) {
    val c = DashTheme.colors
    val focus = LocalFocusManager.current
    var showPassword by rememberSaveable { mutableStateOf(false) }

    Box(Modifier.fillMaxSize().background(c.background)) {
        ContentWidth(Modifier.fillMaxSize(), maxWidth = Sizing.maxFormWidth) {
            Column(
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .imePadding()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.xl, vertical = Spacing.xl)
                    .testTag("auth_screen"),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    BrandMark(size = 26.dp)
                    Spacer(Modifier.width(Spacing.sm))
                    BrandWordmark(fontSize = 14.sp)
                }
                Spacer(Modifier.height(Spacing.xxl))
                Text(
                    if (state.creating) "Create your account" else "Welcome back",
                    style = MaterialTheme.typography.headlineLarge,
                    color = c.ink,
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(Spacing.sm))
                Text(
                    if (state.creating) "Your conversations sync across your devices." else "Sign in to continue where you left off.",
                    style = MaterialTheme.typography.bodyLarge,
                    color = c.inkSecondary,
                )
                Spacer(Modifier.height(Spacing.xl))
                ModeSwitch(creating = state.creating, enabled = !state.busy, onChange = onCreating)
                Spacer(Modifier.height(Spacing.xl))

                if (!online) {
                    Notice(
                        "You're offline. Signing in needs a connection; Demo Mode works offline.",
                        tone = StatusTone.WARNING,
                        modifier = Modifier.padding(bottom = Spacing.lg).testTag("auth_offline"),
                    )
                }

                Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    AnimatedVisibility(state.creating) {
                        DashTextField(
                            value = state.name,
                            onValueChange = onName,
                            label = "Your name",
                            error = state.nameError,
                            enabled = !state.busy,
                            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
                            keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                            modifier = Modifier.testTag("auth_name"),
                        )
                    }
                    DashTextField(
                        value = state.email,
                        onValueChange = onEmail,
                        label = "Email",
                        error = state.emailError,
                        enabled = !state.busy,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, imeAction = ImeAction.Next),
                        keyboardActions = KeyboardActions(onNext = { focus.moveFocus(FocusDirection.Down) }),
                        modifier = Modifier.testTag("auth_email"),
                    )
                    DashTextField(
                        value = state.password,
                        onValueChange = onPassword,
                        label = "Password",
                        error = state.passwordError,
                        supporting = if (state.creating) "At least ${com.dashworldng.ai.core.Limits.MIN_PASSWORD_CHARS} characters." else null,
                        enabled = !state.busy,
                        visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false, imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = {
                            focus.clearFocus()
                            onSubmit()
                        }),
                        trailing = {
                            IconButton(onClick = { showPassword = !showPassword }) {
                                Icon(
                                    if (showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                                    contentDescription = if (showPassword) "Hide password" else "Show password",
                                    tint = c.inkSecondary,
                                )
                            }
                        },
                        modifier = Modifier.testTag("auth_password"),
                    )
                }

                state.failure?.let { failure ->
                    Spacer(Modifier.height(Spacing.md))
                    Notice(
                        failure.message,
                        tone = if (failure.kind == AuthFailureKind.OFFLINE || failure.kind == AuthFailureKind.RATE_LIMITED) StatusTone.WARNING else StatusTone.ERROR,
                        actionLabel = when {
                            failure.kind == AuthFailureKind.ACCOUNT_EXISTS -> "Sign in"
                            failure.canRetry -> "Retry"
                            else -> null
                        },
                        onAction = when {
                            failure.kind == AuthFailureKind.ACCOUNT_EXISTS -> { { onCreating(false) } }
                            failure.canRetry -> onSubmit
                            else -> null
                        },
                        onDismiss = onDismissFailure,
                        modifier = Modifier.testTag("auth_error"),
                    )
                }

                Spacer(Modifier.height(Spacing.xl))
                PrimaryButton(
                    if (state.creating) "Create account" else "Sign in",
                    onClick = {
                        focus.clearFocus()
                        onSubmit()
                    },
                    loading = state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("auth_submit"),
                )

                Spacer(Modifier.height(Spacing.xxl))
                Text("Just looking?", style = MaterialTheme.typography.titleSmall, color = c.ink)
                Spacer(Modifier.height(Spacing.xs))
                Text(
                    "Demo Mode shows how DASH AI works with simulated answers. Nothing leaves this device and no account is needed.",
                    style = MaterialTheme.typography.bodySmall,
                    color = c.inkSecondary,
                )
                Spacer(Modifier.height(Spacing.md))
                SecondaryButton(
                    "Continue in Demo Mode",
                    onClick = onDemo,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().testTag("continue_demo"),
                )

                Spacer(Modifier.weight(1f).height(Spacing.xl))
                Row(
                    Modifier.fillMaxWidth().padding(top = Spacing.xl),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.Center,
                ) {
                    Text(
                        "Server: ${DashApiClient.normalizeBaseUrl(serverUrl)?.host ?: "not set"}",
                        style = MaterialTheme.typography.bodySmall,
                        color = c.inkTertiary,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.testTag("server_url"),
                    )
                    TextAction("Change", onChangeServer, enabled = !state.busy)
                }
            }
        }
    }
}

/** Sign in / Create account, as a two-option segmented control. */
@Composable
private fun ModeSwitch(creating: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    val c = DashTheme.colors
    Row(
        Modifier.fillMaxWidth().clip(Radii.pill).background(c.surfaceMuted).padding(Spacing.xs),
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        listOf(false to "Sign in", true to "Create account").forEach { (value, label) ->
            val selected = creating == value
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 44.dp)
                    .clip(Radii.pill)
                    .background(if (selected) c.surface else c.surfaceMuted)
                    .clickable(enabled = enabled, role = Role.Tab) { onChange(value) }
                    .semantics { this.selected = selected }
                    .testTag(if (value) "tab_create" else "tab_sign_in"),
                contentAlignment = Alignment.Center,
            ) {
                Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) c.ink else c.inkSecondary)
            }
        }
    }
}
