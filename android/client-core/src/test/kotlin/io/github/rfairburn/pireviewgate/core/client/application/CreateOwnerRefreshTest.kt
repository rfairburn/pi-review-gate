package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientHarness
import io.github.rfairburn.pireviewgate.core.client.roster.RosterCreateCommand
import io.github.rfairburn.pireviewgate.core.client.roster.RosterProjectionState
import io.github.rfairburn.pireviewgate.core.client.roster.RosterSavedListCommand
import io.github.rfairburn.pireviewgate.core.client.runtime.ALL_ROSTER_CAPABILITIES
import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntimeConfig
import io.github.rfairburn.pireviewgate.core.client.runtime.ClientRuntimeEvent
import io.github.rfairburn.pireviewgate.core.client.runtime.FakePeerByteChannel
import io.github.rfairburn.pireviewgate.core.client.runtime.HOST_A
import io.github.rfairburn.pireviewgate.core.client.runtime.ROW_1
import io.github.rfairburn.pireviewgate.core.client.runtime.RUN_ID
import io.github.rfairburn.pireviewgate.core.client.runtime.RosterOperationAdmission
import io.github.rfairburn.pireviewgate.core.client.runtime.RuntimeHarness
import io.github.rfairburn.pireviewgate.core.client.runtime.formProof
import io.github.rfairburn.pireviewgate.core.client.runtime.readProof
import io.github.rfairburn.pireviewgate.core.client.ui.CreateProviderChoice
import io.github.rfairburn.pireviewgate.core.client.ui.CreateProviderSelection
import io.github.rfairburn.pireviewgate.core.client.ui.HostCapabilities
import io.github.rfairburn.pireviewgate.core.client.ui.HostConnectionState
import io.github.rfairburn.pireviewgate.core.client.ui.HostUiState
import io.github.rfairburn.pireviewgate.core.client.ui.OwnerChoice
import io.github.rfairburn.pireviewgate.core.client.ui.RosterFreshness
import io.github.rfairburn.pireviewgate.core.client.ui.RosterSnapshot
import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlin.coroutines.CoroutineContext
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The New form's one-shot native-availability refresh (#493) against a real roster
 * lane and a fake owner channel: every assertion is about frames the lane actually
 * wrote. The owner is synthetic; nothing here dials, pairs, or launches anything.
 */
class CreateOwnerRefreshTest {

    private val host = HostId.parse(HOST_A)
    private val claude = NativeCliTarget("claude", NativeCliBackend.CLAUDE, "Claude")
    private val codex = NativeCliTarget("codex", NativeCliBackend.CODEX, "Codex")
    private val availability = ALL_ROSTER_CAPABILITIES +
        listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY)

    private class Fixture(context: CoroutineContext) {
        val harness = RuntimeHarness(context)
        val scope = CoroutineScope(context + Job())
        val refresh = CreateOwnerRefresh(harness.runtime, scope)
        private var fed = 0

        /** Feed the runtime events in order, exactly as the controller's consumer does. */
        suspend fun pump(rounds: Int = 4) {
            repeat(rounds) {
                harness.settle()
                while (fed < harness.events.size) refresh.observe(harness.events[fed++])
            }
            harness.settle()
        }

        suspend fun close() {
            scope.cancel()
            harness.closeRuntime()
        }
    }

    /** The UI projection of the lane, as `ClientProjection` would publish it. */
    private fun ui(f: Fixture, connection: HostConnectionState = HostConnectionState.CONNECTED): HostUiState {
        val lane = requireNotNull(f.harness.hostState(HOST_A))
        val projection = lane.roster.projection
        val current = projection.state == RosterProjectionState.CURRENT
        return HostUiState(
            host = ConfiguredHost(host, HostLabel.parse("Owner A"), Endpoint("owner-a.invalid", 8443)),
            connection = connection,
            roster = projection.hostRunId?.let {
                RosterSnapshot(if (current) RosterFreshness.CURRENT else RosterFreshness.STALE, it,
                    projection.revision ?: 0L, emptyList())
            },
            capabilities = HostCapabilities.fromAcknowledged(lane.roster.capabilities, 0L),
            nativeCliTargets = projection.nativeCliTargets?.takeIf { current },
            nativeCatalogScope = projection.nativeCatalogScope?.takeIf { current },
        )
    }

    private fun frames(channel: FakePeerByteChannel, type: String): Int =
        channel.rosterFrames().count { it.type == type }

    private suspend fun ready(f: Fixture, capabilities: List<String> = availability): FakePeerByteChannel {
        val (channel, _) = f.harness.attach(HOST_A)
        f.harness.subscribed(HOST_A, channel, capabilities)
        f.harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)),
            nativeCliTargets = listOf(claude, codex))
        f.pump()
        return channel
    }

    @Test
    fun `a selected owner is retired once then re-subscribed and its fresh catalog replaces the old one`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        val before = OwnerChoice.of(ui(f))
        assertEquals(listOf(claude, codex), before.nativeTargets)

        assertEquals(CreateOwnerRefresh.Outcome.STARTED, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        assertEquals(1, frames(channel, "unsubscribe"))
        assertEquals(1, frames(channel, "subscribe"), "the replacement waits for the owner's confirmation")
        assertTrue(f.refresh.isRefreshing(host))
        // While retired the catalog is not current, so no native choice is offered.
        assertEquals(emptyList(), OwnerChoice.of(ui(f)).nativeTargets)

        channel.push(RosterFrame.Unsubscribed(f.harness.subscriptionIdOf(channel)))
        f.pump()
        assertEquals(2, frames(channel, "subscribe"), "exactly one re-subscribe follows our own retirement")
        assertFalse(f.refresh.isRefreshing(host))

        // The owner's fresh probe now finds only Codex launchable.
        f.harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)), revision = 2L,
            nativeCliTargets = listOf(codex))
        f.pump()
        val after = OwnerChoice.of(ui(f))
        assertEquals(listOf(codex), after.nativeTargets)
        // A choice frozen from the old observation is withdrawn to "choose again", never Pi.
        val stale = CreateProviderSelection.choiceOf(claude, requireNotNull(before.nativeCatalogScope))
        assertEquals(null, CreateProviderSelection.reconcile(before, after, stale))
        assertEquals(listOf(CreateProviderChoice.Pi, CreateProviderSelection.choiceOf(codex,
            requireNotNull(after.nativeCatalogScope))), CreateProviderSelection.options(after))

        // Nothing further happens on its own: no poll, no second retirement.
        f.pump(rounds = 8)
        assertEquals(1, frames(channel, "unsubscribe"))
        assertEquals(2, frames(channel, "subscribe"))
        f.close()
    }

    @Test
    fun `this client offers native availability only beside the native lane`() {
        assertTrue(ClientRuntimeConfig.DEFAULT_ROSTER_CAPABILITIES.containsAll(
            listOf(RosterWire.NATIVE_CAPABILITY, RosterWire.NATIVE_AVAILABILITY_CAPABILITY)))
        assertFailsWith<IllegalArgumentException> {
            ClientRuntimeConfig(rosterCapabilities = listOf(RosterWire.NATIVE_AVAILABILITY_CAPABILITY))
        }
    }

    @Test
    fun `a Saved-capable owner's passive policy never blocks the refresh and is re-earned after it`() {
        for (deleteExposed in listOf(false, true)) runBlocking {
            val f = Fixture(coroutineContext)
            val channel = ready(f)
            // The owner describes its Saved policy after the first snapshot of every
            // subscription, with no picker opened and no handle owned.
            channel.push(RosterFrame.SavedPolicy(RUN_ID, deleteExposed))
            f.pump()
            val lane = requireNotNull(f.harness.hostState(HOST_A)).roster
            assertEquals(deleteExposed, lane.savedPolicy?.deleteExposed, "policy observed ($deleteExposed)")
            assertEquals(null, lane.savedOwnership)

            assertEquals(CreateOwnerRefresh.Outcome.STARTED, f.refresh.request(ui(f), 1L, callerBusy = false),
                "deleteExposed=$deleteExposed")
            f.pump()
            assertEquals(1, frames(channel, "unsubscribe"))
            channel.push(RosterFrame.Unsubscribed(f.harness.subscriptionIdOf(channel)))
            f.pump()
            assertEquals(2, frames(channel, "subscribe"))

            f.harness.publishSnapshot(channel, rows = listOf(RosterClientHarness.row(ROW_1)), revision = 2L,
                nativeCliTargets = listOf(claude))
            channel.push(RosterFrame.SavedPolicy(RUN_ID, deleteExposed))
            f.pump()
            assertEquals(listOf(claude), OwnerChoice.of(ui(f)).nativeTargets)
            assertEquals(deleteExposed,
                requireNotNull(f.harness.hostState(HOST_A)).roster.savedPolicy?.deleteExposed,
                "the fresh subscription re-earns the owner's own policy description")
            f.pump(rounds = 8)
            assertEquals(1, frames(channel, "unsubscribe"), "exactly one refresh, no repeat")
            assertEquals(2, frames(channel, "subscribe"))
            f.close()
        }
    }

    @Test
    fun `owned Saved handles still keep the subscription untouched`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        channel.push(RosterFrame.SavedPolicy(RUN_ID, true))
        f.pump()
        val list = f.harness.runtime.savedList(host, RosterSavedListCommand(RUN_ID, "query", 0, 50,
            readProof(1L, RUN_ID))) as RosterOperationAdmission.Accepted
        f.pump()
        // While the list is pending, the pending-operation fence holds.
        assertEquals(CreateOwnerRefresh.Outcome.BUSY, f.refresh.request(ui(f), 1L, callerBusy = false))
        val rows = listOf(RosterClientHarness.entry(0))
        channel.push(RosterFrame.SavedWindowBegin(list.requestId, RUN_ID, "catalog-1", "result-1", 1, 0, 0, 1, 1))
        channel.push(RosterFrame.SavedWindowPage(list.requestId, 0, rows))
        channel.push(RosterFrame.SavedWindowEnd(list.requestId, 1, 1))
        f.pump()
        val lane = requireNotNull(f.harness.hostState(HOST_A)).roster
        assertTrue(lane.pending.isEmpty())
        assertTrue(lane.savedOwnership != null, "the picker now owns Saved handles")
        assertEquals(CreateOwnerRefresh.Outcome.BUSY, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        assertEquals(0, frames(channel, "unsubscribe"))
        f.close()
    }

    @Test
    fun `a legacy owner with unknown availability is never refreshed`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f, ALL_ROSTER_CAPABILITIES + RosterWire.NATIVE_CAPABILITY)
        assertEquals(emptyList(), OwnerChoice.of(ui(f)).nativeTargets, "unverified native choices are hidden")
        assertEquals(CreateOwnerRefresh.Outcome.NOT_ELIGIBLE, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        assertEquals(0, frames(channel, "unsubscribe"))
        f.close()
    }

    @Test
    fun `a disconnected owner or another channel generation is never touched or dialed`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        assertEquals(CreateOwnerRefresh.Outcome.NOT_ELIGIBLE,
            f.refresh.request(ui(f, HostConnectionState.DISCONNECTED), 1L, callerBusy = false))
        assertEquals(CreateOwnerRefresh.Outcome.NOT_ELIGIBLE, f.refresh.request(ui(f), 2L, callerBusy = false))
        assertEquals(CreateOwnerRefresh.Outcome.NOT_ELIGIBLE, f.refresh.request(ui(f), null, callerBusy = false))
        assertEquals(CreateOwnerRefresh.Outcome.NOT_ELIGIBLE, f.refresh.request(null, 1L, callerBusy = false))
        f.pump()
        assertEquals(0, frames(channel, "unsubscribe"))
        assertEquals(1, frames(channel, "subscribe"))
        f.close()
    }

    @Test
    fun `an in-flight create or caller-side busy fact keeps the subscription untouched`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        assertEquals(CreateOwnerRefresh.Outcome.BUSY, f.refresh.request(ui(f), 1L, callerBusy = true))

        val admission = f.harness.runtime.createSession(host,
            RosterCreateCommand(RUN_ID, "/srv/owner/new", proof = formProof(1L, RUN_ID, "/srv/owner/new")))
        assertTrue(admission is RosterOperationAdmission.Accepted, "$admission")
        f.pump()
        assertEquals(CreateOwnerRefresh.Outcome.BUSY, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        assertEquals(0, frames(channel, "unsubscribe"))
        assertFalse(f.refresh.isRefreshing(host))
        f.close()
    }

    @Test
    fun `a second request joins the outstanding refresh instead of repeating it`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        val ui = ui(f)
        assertEquals(CreateOwnerRefresh.Outcome.STARTED, f.refresh.request(ui, 1L, callerBusy = false))
        assertEquals(CreateOwnerRefresh.Outcome.ALREADY_REFRESHING, f.refresh.request(ui, 1L, callerBusy = false))
        f.pump()
        assertEquals(1, frames(channel, "unsubscribe"))
        f.close()
    }

    @Test
    fun `a refresh from a replaced channel never re-subscribes the replacement`() = runBlocking {
        val f = Fixture(coroutineContext)
        val old = ready(f)
        assertEquals(CreateOwnerRefresh.Outcome.STARTED, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        assertEquals(1, frames(old, "unsubscribe"))

        // The channel is replaced before the owner confirmed the old retirement.
        f.harness.runtime.detachHost(host)
        f.pump()
        val (replacement, _) = f.harness.attach(HOST_A, generation = 2L)
        f.pump()
        f.harness.ackRoster(replacement, availability)
        f.pump()
        old.push(RosterFrame.Unsubscribed(f.harness.subscriptionIdOf(old)))
        f.pump()
        assertFalse(f.refresh.isRefreshing(host))
        // The replacement subscribes through its own handshake path, never through this.
        assertEquals(0, frames(replacement, "subscribe"))
        assertEquals(1, frames(old, "subscribe"))
        f.close()
    }

    @Test
    fun `an unconfirmed retirement ends the channel and is never followed by a retry`() = runBlocking {
        val f = Fixture(coroutineContext)
        val channel = ready(f)
        assertEquals(CreateOwnerRefresh.Outcome.STARTED, f.refresh.request(ui(f), 1L, callerBusy = false))
        f.pump()
        f.harness.time.advanceMillis(120_000L)
        f.pump()
        assertFalse(f.refresh.isRefreshing(host))
        assertEquals(1, frames(channel, "subscribe"))
        assertTrue(f.harness.events.any { it is ClientRuntimeEvent.RosterChannelRetirementRequested })
        f.close()
    }
}
