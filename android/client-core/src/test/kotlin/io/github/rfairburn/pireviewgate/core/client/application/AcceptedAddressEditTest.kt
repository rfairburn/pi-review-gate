package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.permissions.*
import kotlin.test.*

/** Portable contracts for the actual controller transaction, not invented transport authority. */
class AcceptedAddressEditTest {
    private val host = HostId.parse("host-h")
    private val old = Endpoint("10.0.0.10", 8443)
    private val next = Endpoint("10.0.0.45", old.port)
    private val target = EditHostAddressTarget(host, old)
    private fun proof(generation: Long = 1) = MutableUiActionProof(UiActionTargetToken(
        UiProofScreen.HOST_EDIT_ADDRESS, host, generation = generation,
    )).also { commit(it) }
    private fun commit(proof: MutableUiActionProof) {
        val epoch = proof.beginDraw(); proof.setCriticalIdentityReadable(true); proof.markCommitted(epoch)
    }
    private fun form(address: String = next.host, proof: UiActionProof = proof()) =
        EditHostAddressDialog(target, "A", address, proof)
    private fun intent(form: EditHostAddressDialog) =
        ClientIntent.SaveHostAddressAndReconnect(form.target, form.addressDraft, form.proof)
    private fun snapshot(endpoint: Endpoint = old, generation: Long = 9, foreground: Boolean = true) =
        ConnectionRegistrySnapshot(50, 2, foreground, false, true, DeviceIdentityObservation.Ready("client-I"),
            StorageObservation(StorageHandleState(true), StorageHandleState(true)),
            listOf(HostConnectionSnapshot(host, endpoint, "A", HostConnectionPhase.DISCONNECTED,
                HostConnectionReason.NONE, generation, true, true, false, "remembered-K")), emptyList(), null)
    private fun accept(edit: AcceptedAddressEdit, form: EditHostAddressDialog = form()) =
        assertNotNull(edit.accept(form, intent(form), snapshot().hosts.single()))

    @Test fun exactDrawnFormAndPositiveCommitAreRequiredAtSynchronousIntake() {
        val edit = AcceptedAddressEdit()
        val form = form()
        val host = snapshot().hosts.single()
        assertNull(edit.accept(form, intent(form).copy(address = "10.0.0.46"), host))
        assertNull(edit.accept(form, intent(form).copy(target = target.copy(expectedOldEndpoint = next)), host))
        assertNull(edit.accept(form, intent(form).copy(proof = proof(2)), host))
        assertNull(edit.accept(form, intent(form), host.copy(endpoint = next)))
        assertNull(edit.accept(form, intent(form), host.copy(hostId = HostId.parse("other"))))
        val uncommitted = form(proof = MutableUiActionProof(form.proof.target))
        assertNull(edit.accept(uncommitted, intent(uncommitted), host))
        val wrongControl = form(proof = proof().let {
            MutableUiActionProof(it.target.copy(screen = UiProofScreen.HOST_REMOVE)).also(::commit)
        })
        assertNull(edit.accept(wrongControl, intent(wrongControl), host))
        assertNotNull(edit.accept(form, intent(form), host))
    }

    @Test fun validationUsesExistingStructuralRulesWithoutNormalizingOrEditingPort() {
        val edit = AcceptedAddressEdit()
        for (invalid in listOf("", " 10.0.0.45", "10.0.0.45 ", "http://host", "host/path", "a\nb")) {
            val form = form(invalid)
            assertNull(edit.accept(form, intent(form), snapshot().hosts.single()), invalid)
        }
        val ipv6 = accept(edit, form("2001:db8::45"))
        assertEquals(Endpoint("2001:db8::45", old.port), ipv6.endpoint)
        assertEquals(target, ipv6.target)
        assertEquals("2001:db8::45", ipv6.address.value)
    }

    @Test fun frozenDraftAndSaveTargetNeverFollowLaterFormOrCatalogChanges() {
        val edit = AcceptedAddressEdit()
        val form = form()
        val request = accept(edit, form)
        val laterForm = form.copy(addressDraft = "10.0.0.46", target = target.copy(expectedOldEndpoint = next))
        assertEquals(next, request.endpoint)
        assertEquals(old, request.target.expectedOldEndpoint)
        assertNotEquals(laterForm.target, request.target)
        assertTrue(edit.canSave(request, snapshot()))
        assertFalse(edit.canSave(request, snapshot(endpoint = next)))
        assertFalse(edit.canSave(request, snapshot(generation = 10)))
    }

    @Test fun savePublicationCanPrecedeReturnAndOnlySuccessfulExactResultHandsOffOnce() {
        val edit = AcceptedAddressEdit()
        val request = accept(edit)
        val saved = snapshot(next, 10)
        edit.observe(saved) // Registry published while settings IO was returning.
        val connect = assertNotNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), saved))
        assertEquals(host, connect.hostId)
        assertEquals(next, connect.endpoint)
        assertEquals(10L, connect.connectionGeneration)
        assertTrue(connect.consume())
        assertFalse(connect.consume())
        assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), saved))
        assertFalse(edit.canSave(request, snapshot()))
    }

    @Test fun handoffCannotBeQueuedPastFormDisposalOrRearmedIntoAnotherGesture() {
        val edit = AcceptedAddressEdit()
        val proof = proof()
        val request = accept(edit, form(proof = proof))
        val handoff = assertNotNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
        proof.invalidate(UiProofInvalidationReason.DISMISSED)
        commit(proof)
        assertFalse(handoff.consume())
    }

    @Test fun sameAddressMayHandOffOnlyFromThisFreshCombinedGesture() {
        val edit = AcceptedAddressEdit()
        val request = accept(edit, form(old.host))
        val connect = assertNotNull(edit.takeReconnect(request, HostAddressUpdateResult.Unchanged, snapshot()))
        assertEquals(old, connect.endpoint)
        assertEquals(9L, connect.connectionGeneration)
        assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Unchanged, snapshot()))
    }

    @Test fun cancelNewerRequestAndAllProofRetirementsCannotReviveAfterDelayedSaved() {
        for (reason in UiProofInvalidationReason.entries) {
            val edit = AcceptedAddressEdit()
            val proof = proof()
            val request = accept(edit, form(proof = proof))
            proof.invalidate(reason)
            commit(proof) // Freshly committed again is NOT the old user choice.
            assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 10)), reason.name)
        }
        val edit = AcceptedAddressEdit()
        val oldRequest = accept(edit)
        edit.cancel()
        assertFalse(edit.canSave(oldRequest, snapshot()))
        assertNull(edit.takeReconnect(oldRequest, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
        val newer = accept(edit, form(proof = proof(2)))
        edit.cancel(oldRequest) // Old coroutine's finally must not retire the newer choice.
        assertTrue(edit.canSave(newer, snapshot()))
        assertNull(edit.takeReconnect(oldRequest, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
    }

    @Test fun removalEndpointChangeDisconnectAndBackgroundPermanentlyCancel() {
        val changes = listOf(
            snapshot().copy(hosts = emptyList()),
            snapshot(Endpoint("10.0.0.46", old.port), 10),
            snapshot(generation = 10), // Disconnect, even at the same saved locator.
            snapshot(foreground = false),
        )
        for (changed in changes) {
            val edit = AcceptedAddressEdit()
            val request = accept(edit)
            edit.observe(changed)
            edit.observe(snapshot()) // Return/restoration cannot rearm a choice.
            assertFalse(edit.canSave(request, snapshot()))
            assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
        }
        val edit = AcceptedAddressEdit()
        val request = accept(edit)
        // A Disconnect during IO plus the save's own retirement is TWO generations.
        assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 11)))
    }

    @Test fun unrelatedHostAndSettingsMetadataDoNotStarveTheExactGesture() {
        val edit = AcceptedAddressEdit()
        val request = accept(edit)
        val other = snapshot().hosts.single().copy(hostId = HostId.parse("unrelated"), generation = 999)
        val chatter = snapshot().copy(generation = 9000, settingsGeneration = 9000,
            hosts = snapshot().hosts + other)
        edit.observe(chatter)
        assertTrue(edit.canSave(request, chatter))
        assertNotNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next),
            chatter.copy(hosts = snapshot(next, 10).hosts + other)))
    }

    @Test fun staleOrRefusedSaveCannotManufactureAPhantomConnectTarget() {
        val results = listOf(HostAddressUpdateResult.StaleTarget,
            HostAddressUpdateResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE))
        for (result in results) {
            val edit = AcceptedAddressEdit()
            val request = accept(edit)
            assertNull(edit.takeReconnect(request, result, snapshot()))
            assertNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
        }
    }

    @Test fun newTargetGetsNewPermissionRequestAndOnlyItsStillCurrentAllowContinues() {
        val edit = AcceptedAddressEdit()
        val form = form()
        val request = accept(edit, form)
        val reconnect = assertNotNull(edit.takeReconnect(request, HostAddressUpdateResult.Saved(next), snapshot(next, 10)))
        assertTrue(reconnect.consume()) // Still-drawn combined gesture, on Main.
        (form.proof as MutableUiActionProof).invalidate(UiProofInvalidationReason.DISMISSED)
        val gate = LocalNetworkPermissionGate { LocalNetworkPermissionPlatformFacts(LocalNetworkPermissionStatus.NOT_GRANTED) }
        gate.enterForeground()
        val oldToken = LocalNetworkRequestToken(host, old, 1)
        val oldPrompt = assertIs<LocalNetworkRequestStart.Accepted>(gate.prepareRequest(oldToken)).request
        gate.retirePending() // The real window cancels any old Connect before this transaction.
        val newToken = LocalNetworkRequestToken(reconnect.hostId, reconnect.endpoint, 2)
        val newPrompt = assertIs<LocalNetworkRequestStart.Accepted>(gate.prepareRequest(newToken)).request
        assertNotEquals(oldPrompt.requestId, newPrompt.requestId)
        assertNotEquals(oldToken.endpoint, newToken.endpoint)
        // Temporary system focus loss only refreshes facts, not foreground epoch.
        gate.refresh()
        assertEquals(LocalNetworkRequestResolution.Granted(newToken), gate.resolve(newPrompt.requestId, true, newToken))
        assertIs<LocalNetworkRequestResolution.Stale>(gate.resolve(oldPrompt.requestId, true, newToken))
        gate.prepareRequest(newToken)
        gate.leaveForeground()
        gate.enterForeground()
        assertIs<LocalNetworkRequestResolution.Stale>(gate.resolve(newPrompt.requestId, true, newToken))
    }

    @Test fun editDialogCoverageAndCancelAreSeparateFromTheScreenUnderneath() {
        val form = form()
        val dialogs = ClientDialogs(editHostAddress = form)
        assertTrue(dialogs.hasModal)
        assertEquals(listOf(ClientDialogKind.EDIT_HOST_ADDRESS), dialogs.openKinds)
        assertFalse(dialogs.isCovered(ClientDialogKind.EDIT_HOST_ADDRESS))
        assertTrue(dialogs.copy(removeHost = RemoveHostDialog(host, "A", old.displayText(), proof(2)))
            .isCovered(ClientDialogKind.EDIT_HOST_ADDRESS))
        assertEquals(ClientDialogs.NONE, dialogs.dismissing(ClientDialogKind.EDIT_HOST_ADDRESS))
        assertEquals(old.host, EditHostAddressDialog(target, "A", proof = proof()).addressDraft)
    }
}
