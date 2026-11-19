package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntimeConfig
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The create form's request-specific create-workspace projection (#493): capability
 * status, owner eligibility, and the settled display rule. Synthetic hosts only.
 */
class CreateWorkspaceSelectionTest {

    private val hostA = HostId.parse("workspace-host-a")
    private val hostB = HostId.parse("workspace-host-b")

    private fun host(
        id: HostId = hostA,
        capabilities: List<String>,
        connection: HostConnectionState = HostConnectionState.CONNECTED,
    ): HostUiState = HostUiState(
        host = ConfiguredHost(id, HostLabel.parse("Owner ${id.value}"), Endpoint("${id.value}.invalid", 8443)),
        connection = connection,
        roster = RosterSnapshot(RosterFreshness.CURRENT, "run-${id.value}", 1L, emptyList()),
        capabilities = HostCapabilities.fromAcknowledged(capabilities, 1),
    )

    private val supporting = listOf(RosterWire.CREATE_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY)
    private val legacy = listOf(RosterWire.CREATE_CAPABILITY)

    private fun form(owners: List<OwnerChoice>, selected: HostId?, createWorkspace: Boolean = false) =
        CreateSessionDialog(
            owners = owners,
            selectedHostId = selected,
            proof = MutableUiActionProof(UiActionTargetToken(UiProofScreen.SESSION_CREATE, hostA, generation = 1)),
            createWorkspace = createWorkspace,
        )

    @Test
    fun `this build offers the flag and it is never known before an acknowledgement`() {
        assertTrue(RosterWire.CREATE_WORKSPACE_CAPABILITY in ClientRuntimeConfig.DEFAULT_ROSTER_CAPABILITIES)
        assertTrue(RosterWire.dependenciesHold(ClientRuntimeConfig.DEFAULT_ROSTER_CAPABILITIES))
        assertEquals(CapabilityStatus.UNKNOWN, HostCapabilities.UNKNOWN.createWorkspace)
        assertFalse(HostCapabilities.UNKNOWN.supports(RosterWire.CREATE_WORKSPACE_CAPABILITY))
    }

    @Test
    fun `the flag is supported only beside an acknowledged create lane`() {
        assertEquals(CapabilityStatus.SUPPORTED, HostCapabilities.fromAcknowledged(supporting, 1).createWorkspace)
        assertEquals(
            CapabilityStatus.SUPPORTED,
            HostCapabilities.fromAcknowledged(
                listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY), 1,
            ).createWorkspace,
        )
        assertEquals(CapabilityStatus.UNSUPPORTED, HostCapabilities.fromAcknowledged(legacy, 1).createWorkspace)
        // Never projected as support without a lane to ride on.
        assertEquals(
            CapabilityStatus.UNSUPPORTED,
            HostCapabilities.fromAcknowledged(listOf(RosterWire.CREATE_WORKSPACE_CAPABILITY), 1).createWorkspace,
        )
        // The flag never changes native availability, and native availability never changes it.
        val both = HostCapabilities.fromAcknowledged(listOf(
            RosterWire.CREATE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY, RosterWire.CREATE_WORKSPACE_CAPABILITY,
        ), 1)
        assertEquals(CapabilityStatus.UNSUPPORTED, both.nativeAvailability)
        assertEquals(CapabilityStatus.SUPPORTED, both.createWorkspace)
    }

    @Test
    fun `owner eligibility requires a live connection and the acknowledged flag`() {
        assertTrue(OwnerChoice.of(host(capabilities = supporting)).createWorkspaceEligible)
        assertFalse(OwnerChoice.of(host(capabilities = legacy)).createWorkspaceEligible)
        for (state in HostConnectionState.entries - HostConnectionState.CONNECTED) {
            assertFalse(OwnerChoice.of(host(capabilities = supporting, connection = state)).createWorkspaceEligible)
        }
        // The flag does not change Pi or native create eligibility.
        val owner = OwnerChoice.of(host(capabilities = supporting))
        assertEquals(OwnerChoice.of(host(capabilities = legacy)).createEligible, owner.createEligible)
        assertEquals(
            OwnerChoice.of(host(capabilities = legacy)).copy(createWorkspaceEligible = true),
            owner,
        )
    }

    @Test
    fun `a fresh form is unchecked and draws the checkbox only for a supporting owner`() {
        val owners = listOf(OwnerChoice.of(host(hostA, supporting)), OwnerChoice.of(host(hostB, legacy)))
        assertFalse(CreateSessionDialog(owners = owners, proof = form(owners, null).proof).createWorkspace)
        assertFalse(form(owners, null).showsCreateWorkspace)
        assertTrue(form(owners, hostA).showsCreateWorkspace)
        assertFalse(form(owners, hostA).createWorkspaceBlocked)
        assertFalse(form(owners, hostB).showsCreateWorkspace)
        assertFalse(form(owners, hostB).createWorkspaceBlocked)
    }

    @Test
    fun `a checked choice on an unsupporting owner stays visible and blocks submit`() {
        val owners = listOf(OwnerChoice.of(host(hostA, supporting)), OwnerChoice.of(host(hostB, legacy)))
        assertFalse(form(owners, hostA, createWorkspace = true).createWorkspaceBlocked)
        val switched = form(owners, hostB, createWorkspace = true)
        assertTrue(switched.showsCreateWorkspace, "a held choice is never hidden")
        assertTrue(switched.createWorkspaceBlocked)
        // No owner chosen yet: still visible and clearable, and never submittable.
        assertTrue(form(owners, null, createWorkspace = true).showsCreateWorkspace)
        assertTrue(form(owners, null, createWorkspace = true).createWorkspaceBlocked)
        // A supporting owner that disconnects blocks the held choice the same way.
        val dropped = listOf(OwnerChoice.of(host(hostA, supporting, HostConnectionState.RETRYING)))
        assertTrue(form(dropped, hostA, createWorkspace = true).createWorkspaceBlocked)
    }
}
