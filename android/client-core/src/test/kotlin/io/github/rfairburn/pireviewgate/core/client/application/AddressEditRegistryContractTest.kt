package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import kotlinx.coroutines.Dispatchers
import kotlin.test.*

/** Actual save-only registry and durable stores plus the transaction used by native intake. */
class AddressEditRegistryContractTest {
    private fun form(host: ConfiguredHost): EditHostAddressDialog {
        val proof = MutableUiActionProof(UiActionTargetToken(UiProofScreen.HOST_EDIT_ADDRESS, host.id, generation = 1))
        val epoch = proof.beginDraw(); proof.setCriticalIdentityReadable(true); proof.markCommitted(epoch)
        return EditHostAddressDialog(EditHostAddressTarget(host.id, host.endpoint), host.label.value, "10.0.0.45", proof)
    }
    private fun accept(edit: AcceptedAddressEdit, form: EditHostAddressDialog, registry: HostConnectionRegistry) =
        assertNotNull(edit.accept(form,
            ClientIntent.SaveHostAddressAndReconnect(form.target, form.addressDraft, form.proof),
            registry.snapshot.value.hosts.first { it.hostId == form.target.hostId }))

    @Test fun durableSaveKeepsAssociationOrderPinClientIdentityPortAndFlagsBeforeExplicitConnect() {
        RegistryHarness().use { harness ->
            val one = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
            val other = RegistryFixtures.host(2)
            harness.seedSettings(RegistryFixtures.settings(one, other))
            harness.seedPins(listOf(one, other))
            val pins = harness.pins.snapshot()
            val registry = harness.registry(Dispatchers.Unconfined)
            registry.start()
            try {
                val edit = AcceptedAddressEdit()
                val form = form(one)
                val request = accept(edit, form, registry)
                assertTrue(edit.canSave(request, registry.snapshot.value))
                val result = registry.updateHostAddress(request.target.hostId, request.target.expectedOldEndpoint, request.address)
                assertEquals(HostAddressUpdateResult.Saved(request.endpoint), result)
                assertEquals(listOf(one.withEndpoint(request.endpoint), other), harness.savedCatalog().hosts)
                assertEquals(pins, harness.pins.snapshot())
                assertEquals(0, harness.identity.generations)
                assertTrue(harness.transports.isEmpty())
                assertTrue(harness.pins.clears.isEmpty())
                assertTrue(registry.snapshot.value.hosts.first().reconnectSuppressed)
                val reconnect = assertNotNull(edit.takeReconnect(request, result, registry.snapshot.value))
                assertEquals(one.id, reconnect.hostId)
                assertEquals(Endpoint("10.0.0.45", one.endpoint.port), reconnect.endpoint)
                // The handoff is still data, not a dial, identity initialization or pin approval.
                assertTrue(harness.transports.isEmpty())
                assertEquals(0, harness.prompt.asked)
            } finally { registry.close() }
        }
    }

    @Test fun retirementInsideActualSaveDoesNotTurnDurableSavedIntoFailureOrResurrectConnect() {
        for (retirement in listOf("dismiss", "window", "background", "closed", "newer-request")) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1, previouslyConnected = true, suppressed = true)
                harness.seedSettings(RegistryFixtures.settings(one))
                harness.seedPins(listOf(one))
                val registry = harness.registry(Dispatchers.Unconfined)
                registry.start()
                try {
                    val edit = AcceptedAddressEdit()
                    val form = form(one)
                    val request = accept(edit, form, registry)
                    assertTrue(edit.canSave(request, registry.snapshot.value))
                    // The real settings write is entered, but has not published. These
                    // synchronous hooks model the lifecycle/intent interleaving at that seam.
                    harness.settings.onWrite = {
                        when (retirement) {
                            "dismiss" -> (form.proof as MutableUiActionProof).invalidate(UiProofInvalidationReason.DISMISSED)
                            "window" -> edit.cancel()
                            "background" -> registry.setForeground(false)
                            "closed" -> registry.close()
                            "newer-request" -> accept(edit, form.copy(proof = MutableUiActionProof(form.proof.target.copy(generation = 2)).also {
                                val epoch = it.beginDraw(); it.setCriticalIdentityReadable(true); it.markCommitted(epoch)
                            }), registry)
                        }
                    }
                    val result = registry.updateHostAddress(one.id, one.endpoint, request.address)
                    assertEquals(HostAddressUpdateResult.Saved(request.endpoint), result, retirement)
                    assertEquals(request.endpoint, harness.savedCatalog().find(one.id)?.endpoint, retirement)
                    assertNull(edit.takeReconnect(request, result, registry.snapshot.value), retirement)
                    assertTrue(harness.transports.isEmpty(), retirement)
                    assertEquals(0, harness.identity.generations, retirement)
                    assertTrue(harness.pins.clears.isEmpty(), retirement)
                } finally { registry.close() }
            }
        }
    }

    @Test fun refusedWriteOrStaleOldEndpointNeverOffersNewTargetContinuation() {
        for (failure in listOf("write", "stale")) {
            RegistryHarness().use { harness ->
                val one = RegistryFixtures.host(1)
                harness.seedSettings(RegistryFixtures.settings(one))
                val registry = harness.registry(Dispatchers.Unconfined)
                registry.start()
                try {
                    val edit = AcceptedAddressEdit()
                    val request = accept(edit, form(one), registry)
                    if (failure == "write") harness.settings.refuseWrites = StorageFailureReason.WRITE_FAILED
                    else registry.updateHostAddress(one.id, one.endpoint, HostAddress.parse("10.0.0.46"))
                    val result = registry.updateHostAddress(one.id, one.endpoint, request.address)
                    if (failure == "write") assertIs<HostAddressUpdateResult.Refused>(result)
                    else assertEquals(HostAddressUpdateResult.StaleTarget, result)
                    assertNull(edit.takeReconnect(request, result, registry.snapshot.value))
                    assertNotEquals(request.endpoint, harness.savedCatalog().find(one.id)?.endpoint)
                    assertTrue(harness.transports.isEmpty())
                } finally { registry.close() }
            }
        }
    }
}
