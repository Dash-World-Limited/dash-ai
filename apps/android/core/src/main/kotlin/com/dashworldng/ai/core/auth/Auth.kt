package com.dashworldng.ai.core.auth

import com.dashworldng.ai.core.Limits
import com.dashworldng.ai.core.model.UserProfile
import com.dashworldng.ai.core.remote.AuthResponseDto
import com.dashworldng.ai.core.remote.DashApiClient
import com.dashworldng.ai.core.remote.LoginRequestDto
import com.dashworldng.ai.core.remote.ProvidersResponseDto
import com.dashworldng.ai.core.remote.RegisterRequestDto

data class AuthSession(val token: String, val expiresAt: String, val user: UserProfile)

/** Client-side checks that mirror the API's validation, so mistakes are caught before a request. */
object AuthValidation {
    private val email = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$")

    fun emailError(value: String): String? = when {
        value.isBlank() -> "Enter your email address."
        !email.matches(value.trim()) -> "Enter a valid email address."
        else -> null
    }

    fun passwordError(value: String, creating: Boolean): String? = when {
        value.isEmpty() -> "Enter your password."
        creating && value.length < Limits.MIN_PASSWORD_CHARS -> "Use at least ${Limits.MIN_PASSWORD_CHARS} characters."
        value.length > Limits.MAX_PASSWORD_CHARS -> "Passwords can be up to ${Limits.MAX_PASSWORD_CHARS} characters."
        else -> null
    }

    fun nameError(value: String): String? = when {
        value.isBlank() -> "Enter your name."
        value.trim().length > Limits.MAX_DISPLAY_NAME_CHARS -> "Names can be up to ${Limits.MAX_DISPLAY_NAME_CHARS} characters."
        else -> null
    }
}

/** Account operations against the Dash AI API. */
class AuthService(private val client: () -> DashApiClient) {
    suspend fun register(email: String, password: String, displayName: String): AuthSession =
        client().call { register(RegisterRequestDto(email.trim(), password, displayName.trim())) }.toSession()

    suspend fun login(email: String, password: String): AuthSession =
        client().call { login(LoginRequestDto(email.trim(), password)) }.toSession()

    suspend fun logout() = client().callNoContent { logout() }

    suspend fun deleteAccount() = client().callNoContent { deleteAccount() }

    suspend fun providers(): ProvidersResponseDto = client().call { providers() }

    private fun AuthResponseDto.toSession() = AuthSession(
        token = token,
        expiresAt = expiresAt,
        user = UserProfile(id = user.id, email = user.email, displayName = user.displayName, isDemo = false),
    )
}
