package io.github.rfairburn.pireviewgate.core.client.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ClientForegroundBindingTest {
    private class Hooks : ClientLifecycleCallbacks {
        val calls = mutableListOf<String>()
        var fail = false
        var failWindowProofs = false
        override fun invalidateTerminalInput() {
            calls += "input"
            if (fail) error("UI callback failed")
        }
        override fun invalidateWindowProofs() {
            calls += "proofs"
            if (failWindowProofs) error("window proof retirement failed")
        }
        override fun cancelPendingUserIntent() { calls += "cancel" }
    }

    private class Fixture {
        val network = mutableListOf<Boolean>()
        val inputAtNetworkChange = mutableListOf<Boolean>()
        val hooks = Hooks()
        val policy: ClientForegroundBinding = ClientForegroundBinding { foreground ->
            inputAtNetworkChange += policyInput()
            network += foreground
        }
        private fun policyInput() = policy.terminalInputEligible
        val id = policy.bind(hooks)
        fun visible() {
            policy.deviceVisibility(ClientDeviceVisibility(true, true))
            policy.onStart(id)
            policy.onResume(id)
            policy.onWindowFocusChanged(id, true)
            assertTrue(policy.terminalInputEligible)
        }
    }

    @Test
    fun `background invalidates atomic input before registry foreground and cancels all UI context`() {
        val f = Fixture()
        f.visible()
        f.policy.onStop(f.id, changingConfigurations = false)
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.inputAtNetworkChange.last())
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
        f.policy.onStart(f.id)
        assertEquals(listOf(true, false, true), f.network)
        assertFalse(f.policy.terminalInputEligible) // No inherited focus/resume/receipt.
    }

    @Test
    fun `screen off or lock wins synchronously even during configuration handoff`() {
        val f = Fixture()
        f.visible()
        f.policy.onStop(f.id, changingConfigurations = true)
        assertEquals(listOf(true), f.network)
        assertFalse(f.policy.terminalInputEligible)
        f.policy.unbind(f.id, changingConfigurations = true)
        f.policy.deviceVisibility(ClientDeviceVisibility(false, false))
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.inputAtNetworkChange.last())
        f.policy.deviceVisibility(ClientDeviceVisibility(true, true))
        assertEquals(listOf(true, false), f.network) // Unlock alone does not revive handoff.
    }

    @Test
    fun `configuration recreation preserves network but never old input or proofs`() {
        val f = Fixture()
        f.visible()
        f.policy.onPause(f.id)
        f.policy.onStop(f.id, changingConfigurations = true)
        f.policy.unbind(f.id, changingConfigurations = true)
        assertFalse(f.policy.terminalInputEligible)
        assertTrue("proofs" in f.hooks.calls)
        assertTrue("cancel" in f.hooks.calls)
        val newId = f.policy.bind(Hooks())
        f.policy.onStart(newId)
        assertFalse(f.policy.terminalInputEligible)
        f.policy.onResume(newId)
        assertFalse(f.policy.terminalInputEligible)
        f.policy.onWindowFocusChanged(newId, true)
        assertTrue(f.policy.terminalInputEligible)
        assertEquals(listOf(true), f.network)
    }

    @Test
    fun `permission dialog pause and root focus loss veto terminal not visible network or dialog proofs`() {
        val f = Fixture()
        f.visible()
        f.policy.onWindowFocusChanged(f.id, false)
        f.policy.onPause(f.id)
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true), f.network)
        assertEquals(listOf("input", "input"), f.hooks.calls)
        f.policy.onResume(f.id)
        assertFalse(f.policy.terminalInputEligible)
        f.policy.onWindowFocusChanged(f.id, true)
        assertTrue(f.policy.terminalInputEligible) // Still NOT a committed-frame receipt.
    }

    @Test
    fun `started focused resumed but locked never foregrounds registry`() {
        val f = Fixture()
        f.policy.deviceVisibility(ClientDeviceVisibility(true, false))
        f.policy.onStart(f.id)
        f.policy.onResume(f.id)
        f.policy.onWindowFocusChanged(f.id, true)
        assertFalse(f.policy.terminalInputEligible)
        assertTrue(f.network.isEmpty())
        f.policy.deviceVisibility(ClientDeviceVisibility(true, true))
        assertEquals(listOf(true), f.network)
        assertFalse(f.policy.terminalInputEligible) // Locked callbacks cannot be reused on unlock.
        f.policy.onResume(f.id)
        f.policy.onWindowFocusChanged(f.id, true)
        assertTrue(f.policy.terminalInputEligible)
    }

    @Test
    fun `callback failure cannot prevent network teardown other cleanup or atomic veto`() {
        val f = Fixture()
        f.visible()
        f.hooks.fail = true
        assertFailsWith<IllegalStateException> { f.policy.onStop(f.id, false) }
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.inputAtNetworkChange.last())
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
    }

    @Test
    fun `configuration stop with failed window proof retirement tears down and cannot resume handoff`() {
        val f = Fixture()
        f.visible()
        f.hooks.failWindowProofs = true
        val error = assertFailsWith<IllegalStateException> {
            f.policy.onStop(f.id, changingConfigurations = true)
        }
        assertEquals("window proof retirement failed", error.message)
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.inputAtNetworkChange.last())
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
        f.policy.deviceVisibility(ClientDeviceVisibility(true, true))
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.policy.terminalInputEligible)
    }

    @Test
    fun `configuration unbind with failed window proof retirement tears down and cannot resume handoff`() {
        val f = Fixture()
        f.visible()
        f.policy.onStop(f.id, changingConfigurations = true)
        assertEquals(listOf(true), f.network)
        f.hooks.calls.clear()
        f.hooks.failWindowProofs = true
        val error = assertFailsWith<IllegalStateException> {
            f.policy.unbind(f.id, changingConfigurations = true)
        }
        assertEquals("window proof retirement failed", error.message)
        assertFalse(f.policy.isCurrent(f.id))
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.inputAtNetworkChange.last())
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
        f.policy.deviceVisibility(ClientDeviceVisibility(true, true))
        assertEquals(listOf(true, false), f.network)
        assertFalse(f.policy.terminalInputEligible)
    }

    @Test
    fun `lock while active vetoes input before network and retires proofs despite callback error`() {
        val f = Fixture()
        f.visible()
        f.hooks.fail = true
        assertFailsWith<IllegalStateException> {
            f.policy.deviceVisibility(ClientDeviceVisibility(true, false))
        }
        assertFalse(f.policy.terminalInputEligible)
        assertFalse(f.inputAtNetworkChange.last())
        assertEquals(listOf(true, false), f.network)
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
    }

    @Test
    fun `old binding cannot pause stop unbind resume or focus a newer binding`() {
        val f = Fixture()
        f.visible()
        val newHooks = Hooks()
        val newId = f.policy.bind(newHooks)
        f.policy.onStart(newId)
        f.policy.onResume(newId)
        f.policy.onWindowFocusChanged(newId, true)
        f.policy.onPause(f.id)
        f.policy.onStop(f.id, false)
        f.policy.unbind(f.id, false)
        assertTrue(f.policy.terminalInputEligible)
        f.policy.onPause(newId)
        f.policy.onResume(f.id)
        f.policy.onWindowFocusChanged(f.id, true)
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true), f.network)
        assertEquals(listOf("input"), newHooks.calls)
    }

    @Test
    fun `disposal clears callbacks and closes registry even when cleanup fails`() {
        val f = Fixture()
        f.visible()
        f.hooks.fail = true
        assertFailsWith<IllegalStateException> { f.policy.close() }
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf(true, false), f.network)
        f.policy.close()
        f.policy.onResume(f.id)
        f.policy.onWindowFocusChanged(f.id, true)
        assertFalse(f.policy.terminalInputEligible)
        assertEquals(listOf("input", "proofs", "cancel"), f.hooks.calls)
    }
}
