package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.application.*
import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.roster.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import io.github.rfairburn.pireviewgate.core.protocol.roster.*
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.*

/** Real runtime admission, channel writer and transfer fences for the Saved continuation. */
class SavedDeletionRefreshRuntimeTest {
    private enum class Scenario {
        ZERO, NONZERO, QUEUED_CANCEL, QUEUED_WINDOW, QUEUED_OWNER, QUEUED_GENERATION,
        QUEUED_REMOVAL, QUEUED_CHANNEL, QUEUED_REPLACEMENT, QUEUED_RESYNC, QUEUED_UNPUBLISHED_RESYNC,
        TRANSFER_CANCEL, TRANSFER_WINDOW,
        TRANSFER_OWNER, TRANSFER_RUN, TRANSFER_PROJECTION, TRANSFER_DISMISS, COMPLETED_CANCEL,
    }

    @Test fun confirmedDeleteRelistsOnceAndCancellationCannotWriteOrInstallALateResult() = runBlocking {
        for (scenario in Scenario.entries) {
            val h = RuntimeHarness(coroutineContext, config = runtimeConfig(ids = CountingRuntimeIds(),
                eventQueueCapacity = if (scenario == Scenario.QUEUED_UNPUBLISHED_RESYNC) 1 else 512))
            val host = HostId.parse(HOST_A)
            val (channel, _) = h.attach(HOST_A)
            h.subscribed(HOST_A, channel)
            h.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)))
            channel.push(RosterFrame.SavedPolicy(RUN_ID, true)); h.settle()
            val list = h.runtime.savedList(host, RosterSavedListCommand(RUN_ID, " exact query ", 0, 50,
                readProof(1, RUN_ID))) as RosterOperationAdmission.Accepted
            h.settle()
            val rows = listOf(RosterClientHarness.entry(0))
            channel.push(RosterFrame.SavedWindowBegin(list.requestId, RUN_ID, "catalog-1", "result-1", 1, 0, 0, 1, 1))
            channel.push(RosterFrame.SavedWindowPage(list.requestId, 0, rows))
            channel.push(RosterFrame.SavedWindowEnd(list.requestId, 1, 1)); h.settle()
            val display = SavedUiState(host, SavedRequestStatus.Ready, RUN_ID, "catalog-1", "result-1",
                list.requestId, assertNotNull(list.pending?.sequence), total = 1, entries = rows, query = " exact query ")
            val entry = assertNotNull(SavedEntryTarget.of(display, rows.single()))
            val command = RosterSavedDeleteCommand(RUN_ID, "catalog-1", "result-1", entry.entryId,
                entryProof(1, RUN_ID, "catalog-1", "result-1", entry.entryId))
            val prepare = h.runtime.savedDeletePrepare(host, command) as RosterOperationAdmission.Accepted
            h.settle()
            assertEquals(false, prepare.pending?.savedDeleteConfirmed)
            channel.push(RosterFrame.SavedDeleteResult(prepare.requestId, OwnerSavedDeleteFacts.ConfirmationRequired)); h.settle()
            val dialog = MutableUiActionProof(UiActionTargetToken(UiProofScreen.SAVED_DELETE, host,
                hostRunId = RUN_ID, catalogId = "catalog-1", resultId = "result-1", entryId = entry.entryId, generation = 40)).also {
                val epoch = it.beginDraw(); it.setCriticalIdentityReadable(true); it.markCommitted(epoch)
            }
            val click = assertNotNull(FrozenAction.capture(dialog))
            val send = RosterSendProof.PickerEntry(1, RUN_ID, "catalog-1", "result-1", entry.entryId, 1, click, click)
            val window = AtomicBoolean(true)
            val registry = MutableStateFlow(ConnectionRegistrySnapshot(1, 0, true, false, true,
                DeviceIdentityObservation.NeverInitialized, StorageObservation(StorageHandleState(true), StorageHandleState(true)),
                listOf(HostConnectionSnapshot(host, Endpoint("192.0.2.1", 8443), "Owner", HostConnectionPhase.CONNECTED,
                    HostConnectionReason.NONE, 1, true, false, false, null)), emptyList(), null))
            val connected = registry.value
            // The same production guard as the controller, including real published
            // runtime state. Never call hostState/endpoint state from inside this proof.
            val lifetime = AcceptedSavedDeletion.ownerLifetime(entry, 1, RosterUiProof { window.get() }, registry, h.runtime.state)
            val continuation = assertNotNull(AcceptedSavedDeletion.capture(entry, assertNotNull(SavedResultTarget.of(display)),
                8, display.query, send, dialog, click, lifetime))
            val admission = h.runtime.savedDeleteConfirmed(host, command.copy(proof = send), click) as RosterOperationAdmission.Accepted
            h.settle()
            val pending = assertNotNull(admission.pending)
            assertEquals(true, pending.savedDeleteConfirmed)
            assertEquals(1L, pending.savedPickerRevision)
            assertEquals(entry.entryId, pending.entryId)
            channel.push(RosterFrame.SavedDeleteResult(admission.requestId, OwnerSavedDeleteFacts.Deleted(SavedDeleteMethod.TRASH)))
            h.settle()
            assertNull(h.hostState(HOST_A)?.roster?.savedOwnership)
            // Application admission may arrive after settlement; use the returned accepting
            // metadata even though the runtime's current pending slot is already empty.
            assertTrue(h.hostState(HOST_A)!!.roster.pending.isEmpty())
            continuation.admitted(pending)
            val deleted = h.settledOperations().single { it.requestId == admission.requestId }
            val refresh = assertNotNull(continuation.refresh(deleted, display, 8, dialog))
            dialog.invalidate(UiProofInvalidationReason.DISMISSED)
            continuation.observe(refresh.display, 8, null)
            repeat(3) { assertNull(continuation.refresh(deleted, display, 8, dialog)) }
            val queued = scenario.name.startsWith("QUEUED_")
            if (queued) channel.blockWrites()
            val read = h.runtime.savedList(host, refresh.command)
            h.settle()
            if (queued) {
                val queuedRead = assertIs<RosterOperationAdmission.Accepted>(read)
                when (scenario) {
                    Scenario.QUEUED_CANCEL -> continuation.cancel()
                    Scenario.QUEUED_WINDOW -> window.set(false)
                    Scenario.QUEUED_OWNER -> registry.value = connected.copy(hosts = connected.hosts.map {
                        it.copy(phase = HostConnectionPhase.DISCONNECTED)
                    })
                    Scenario.QUEUED_GENERATION -> registry.value = connected.copy(hosts = connected.hosts.map {
                        it.copy(generation = 2)
                    })
                    Scenario.QUEUED_REMOVAL -> registry.value = connected.copy(hosts = emptyList())
                    Scenario.QUEUED_CHANNEL -> h.runtime.detachHost(host)
                    Scenario.QUEUED_REPLACEMENT -> {
                        h.runtime.detachHost(host)
                        val (replacement, _) = h.attach(HOST_A, generation = 2)
                        h.subscribed(HOST_A, replacement)
                        h.publishSnapshot(replacement, rows = listOf(RosterClientHarness.row(ROW_1)))
                    }
                    Scenario.QUEUED_RESYNC -> h.runtime.resyncRoster(host)
                    Scenario.QUEUED_UNPUBLISHED_RESYNC -> {
                        // Hold publication after the endpoint has retired this request.
                        // The published lifetime may still say CURRENT, but the writer's
                        // independent pending-request fence must already reject it.
                        h.pauseEvents(); h.settle()
                        val resync = async { h.runtime.resyncRoster(host) }
                        h.settle()
                        assertFalse(resync.isCompleted)
                        assertNotEquals(RosterProjectionState.CURRENT, h.hostState(HOST_A)?.roster?.projection?.state)
                        assertEquals(RosterProjectionState.CURRENT,
                            h.runtime.state.value.hosts.single().roster.projection.state)
                        assertTrue(continuation.isStillCurrent())
                        channel.releaseWrites(); h.settle()
                        assertEquals(1, h.rosterFrames(channel).count { it.type == "saved_list_request" })
                        h.resumeEvents(); resync.await(); h.settle()
                    }
                    else -> error("not queued")
                }
                // Let the actual channel writer evaluate the changed facts first.
                channel.releaseWrites(); h.settle()
                assertFalse(continuation.isStillCurrent(), scenario.name)
                // Even an abrupt return to identical window/owner facts cannot rearm it.
                window.set(true); registry.value = connected
                assertFalse(continuation.isStillCurrent(), scenario.name)
                channel.push(RosterFrame.SavedWindowBegin(queuedRead.requestId, RUN_ID, "late-catalog", "late-result", 0, 0, 0, 0, 0))
                channel.push(RosterFrame.SavedWindowEnd(queuedRead.requestId, 0, 0)); h.settle()
            }
            if (queued) {
                assertEquals(1, h.rosterFrames(channel).count { it.type == "saved_list_request" }, scenario.name)
                assertNull(h.hostState(HOST_A)?.roster?.savedOwnership, scenario.name)
            } else {
                val accepted = read as RosterOperationAdmission.Accepted
                val fresh = h.lastRequest(channel, "saved_list_request") as RosterFrame.SavedListRequest
                assertEquals(accepted.pending?.sequence, fresh.sequence)
                assertEquals(pending.sequence!! + 1, fresh.sequence)
                assertEquals(display.query, fresh.query)
                assertEquals(RUN_ID, fresh.hostRunId)
                assertEquals(0L, fresh.offset); assertEquals(50L, fresh.count)
                val entries = if (scenario == Scenario.ZERO) emptyList() else listOf(RosterClientHarness.entry(10), RosterClientHarness.entry(11))
                val total = entries.size.toLong()
                val pages = if (entries.isEmpty()) 0L else 1L
                channel.push(RosterFrame.SavedWindowBegin(fresh.requestId, RUN_ID, "fresh-catalog", "fresh-result", total, 0, 0, total, pages))
                if (entries.isNotEmpty()) channel.push(RosterFrame.SavedWindowPage(fresh.requestId, 0, entries))
                h.settle()
                assertEquals(1L, refresh.display.total)
                assertSame(rows, refresh.display.entries)
                when (scenario) {
                    Scenario.TRANSFER_CANCEL -> continuation.cancel()
                    Scenario.TRANSFER_WINDOW -> window.set(false)
                    Scenario.TRANSFER_OWNER -> registry.value = connected.copy(hosts = emptyList())
                    Scenario.TRANSFER_RUN -> h.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)),
                        runId = OTHER_RUN_ID, revision = 2)
                    Scenario.TRANSFER_PROJECTION -> h.runtime.resyncRoster(host)
                    Scenario.TRANSFER_DISMISS -> h.runtime.dismissSavedPicker(host)
                    else -> Unit
                }
                channel.push(RosterFrame.SavedWindowEnd(fresh.requestId, total, pages)); h.settle()
                if (scenario.name.startsWith("TRANSFER_")) {
                    assertNull(h.hostState(HOST_A)?.roster?.savedOwnership, scenario.name)
                    assertFalse(h.settledOperations().any { it.requestId == fresh.requestId &&
                        ((it.result as? RosterRequestResult.OwnerResult)?.outcome as? RosterOwnerOutcome.SavedWindow)
                            ?.facts is RosterSavedWindowFacts.Complete }, scenario.name)
                    if (scenario != Scenario.TRANSFER_DISMISS) {
                        assertFalse(continuation.isStillCurrent(), scenario.name)
                        window.set(true); registry.value = connected
                        assertFalse(continuation.isStillCurrent(), scenario.name)
                    }
                    // A duplicate late terminal frame cannot revive a retired transfer.
                    channel.push(RosterFrame.SavedWindowEnd(fresh.requestId, total, pages)); h.settle()
                    assertNull(h.hostState(HOST_A)?.roster?.savedOwnership, scenario.name)
                } else {
                    val completed = h.settledOperations().single { it.requestId == fresh.requestId }
                    val facts = ((completed.result as RosterRequestResult.OwnerResult).outcome as RosterOwnerOutcome.SavedWindow)
                        .facts as RosterSavedWindowFacts.Complete
                    assertEquals(total, facts.total); assertEquals(entries, facts.entries)
                    // Exercise snapshot -> ownership -> actual production lifetime
                    // before adoption, the cycle that previously canceled the result.
                    val ownership = assertNotNull(h.hostState(HOST_A)?.roster?.savedOwnership)
                    assertEquals("fresh-catalog", ownership.catalogId)
                    assertEquals("fresh-result", ownership.resultId)
                    assertEquals(total, ownership.windows.single().total)
                    assertTrue(continuation.isStillCurrent())
                    if (scenario == Scenario.COMPLETED_CANCEL) {
                        window.set(false)
                        assertFalse(continuation.adoptResult())
                        window.set(true)
                        assertFalse(continuation.isStillCurrent())
                        assertNull(h.hostState(HOST_A)?.roster?.savedOwnership)
                    } else {
                        assertTrue(continuation.adoptResult())
                        window.set(false); registry.value = connected.copy(hosts = emptyList())
                        continuation.cancel()
                        // Adopted ownership has normal detached manual-read lifetime.
                        assertEquals(ownership, h.hostState(HOST_A)?.roster?.savedOwnership)
                    }
                }
                assertEquals(2, h.rosterFrames(channel).count { it.type == "saved_list_request" })
            }
            assertEquals(0, h.rosterFrames(channel).count { it.type == "saved_search_request" })
            assertEquals(2, h.rosterFrames(channel).count { it.type == "saved_delete_request" })
            h.closeRuntime()
        }
    }
}
