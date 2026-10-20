package com.dashworldng.ai.core.presentation

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ServerAddressTest {
    @Test
    fun `a signed-in session is never sent to a different server`() {
        assertEquals(ServerAddress.SIGN_OUT_FIRST, ServerAddress.changeRefusal(true, "https://api.dash.example/", "https://evil.example/"))
    }

    @Test
    fun `signed out, unchanged, or a first address is allowed`() {
        assertNull(ServerAddress.changeRefusal(false, "https://api.dash.example/", "https://other.example/"))
        assertNull(ServerAddress.changeRefusal(true, "https://api.dash.example/", "https://api.dash.example/"))
        assertNull(ServerAddress.changeRefusal(true, "", "https://api.dash.example/"))
    }
}
