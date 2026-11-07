package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.Test
import kotlin.test.assertSame
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Presentation-contract invariants the future controller depends on: capability and
 * policy gating stay closed until positively opened, frozen targets never retarget,
 * and unknown is never collapsed into a decision.
 */
class ClientUiStateContractTest {

    @Test
    fun `capabilities are unknown before an acknowledgement and never read as support`() {
        val unknown = HostCapabilities.UNKNOWN
        assertFalse(unknown.negotiated)
        assertFalse(unknown.supports(RosterWire.CLOSE_CAPABILITY))
        assertEquals(CapabilityStatus.UNKNOWN, unknown.statusOf(RosterWire.SAVED_CAPABILITY))
        assertEquals(CapabilityStatus.UNKNOWN, unknown.statusOf("some-future-capability"))
    }

    @Test
    fun `a completed acknowledgement reports both support and refusal`() {
        val caps = HostCapabilities.fromAcknowledged(
            capabilities = listOf(RosterWire.CLOSE_CAPABILITY, RosterWire.SAVED_CAPABILITY),
            minor = 2L,
        )
        assertTrue(caps.negotiated)
        assertEquals(2L, caps.minor)
        assertTrue(caps.supports(RosterWire.CLOSE_CAPABILITY))
        assertTrue(caps.supports(RosterWire.SAVED_CAPABILITY))
        assertFalse(caps.supports(RosterWire.CREATE_CAPABILITY))
        assertEquals(CapabilityStatus.UNSUPPORTED, caps.statusOf(RosterWire.RENAME_CAPABILITY))
    }

    @Test
    fun `saved delete is offered only on a positive owner exposure`() {
        assertFalse(ClientUiFixtures.hostState("a", savedPolicy = SavedPolicyStatus.UNKNOWN).savedDeleteExposed)
        assertFalse(ClientUiFixtures.hostState("a", savedPolicy = SavedPolicyStatus.OFF).savedDeleteExposed)
        assertTrue(ClientUiFixtures.hostState("a", savedPolicy = SavedPolicyStatus.EXPOSED).savedDeleteExposed)
    }

    @Test
    fun `a frozen action target keeps naming what was drawn after the row changes`() {
        val drawn = ClientUiFixtures.row("a", rowId = "row-1", revision = 7L)
        val frozen = SessionActionTarget.of(drawn)

        val superseded = drawn.copy(
            rosterRevision = 9L,
            metadata = drawn.metadata.copy(label = "renamed by a later snapshot"),
        )
        assertEquals("row-1", frozen.rowId)
        assertEquals(7L, frozen.rosterRevision)
        assertEquals("display-row-1", frozen.drawnTitle)
        assertEquals(9L, SessionActionTarget.of(superseded).rosterRevision)
        assertFalse(frozen == SessionActionTarget.of(superseded))
    }

    @Test
    fun `rename is fenced to the native tuple and is unavailable without one`() {
        val withNative = ClientUiFixtures.row("a", nativeSession = ClientUiFixtures.nativeSession(epoch = 42L))
        val fenced = RenameTarget.of(withNative)
        assertNotNull(fenced)
        assertEquals(42L, fenced.expectedSessionEpoch)
        assertEquals("native-1", fenced.expectedSessionId)
        assertEquals("Native name", fenced.currentName)

        assertNull(RenameTarget.of(ClientUiFixtures.row("a", nativeSession = null)))
    }

    @Test
    fun `back from hosts, settings, and saved lands on the session list`() {
        assertEquals(BackAction.SYSTEM_DEFAULT, ClientUiState(route = ClientRoute.Sessions).backAction())
        assertEquals(BackAction.SHOW_SESSIONS, ClientUiState(route = ClientRoute.Hosts).backAction())
        assertEquals(BackAction.SHOW_SESSIONS, ClientUiState(route = ClientRoute.Settings).backAction())
        assertEquals(
            BackAction.SHOW_SESSIONS,
            ClientUiState(route = ClientRoute.Saved(HostId.parse("a"))).backAction(),
        )
    }

    @Test
    fun `the terminal has no navigation destination and the other routes do`() {
        assertEquals(NavigationDestination.SESSIONS, ClientRoute.Sessions.destination())
        assertEquals(NavigationDestination.HOSTS, ClientRoute.Hosts.destination())
        assertEquals(NavigationDestination.SETTINGS, ClientRoute.Settings.destination())
        assertNull(ClientRoute.Terminal(ClientUiFixtures.terminalState()).destination())
    }

    @Test
    fun `dismissing one dialog kind leaves the others open`() {
        val dialogs = ClientDialogs(
            addHost = AddHostDialog(proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token(UiProofScreen.HOST_ADD_FORM))),
            closeSession = CloseSessionDialog(
                target = SessionActionTarget(HostId.parse("a"), ClientUiFixtures.RUN_A, "row-1", 7L, "row 1"),
                proof = ClientUiFixtures.FakeProof(ClientUiFixtures.token()),
            ),
        )
        assertTrue(dialogs.hasModal)
        val after = dialogs.dismissing(ClientDialogKind.ADD_HOST)
        assertNull(after.addHost)
        assertNotNull(after.closeSession)
        assertTrue(after.hasModal)
        assertFalse(ClientDialogs.NONE.hasModal)
    }

    @Test
    fun `settings defaults stay the source defaults the view reports`() {
        val state = ClientUiState()
        assertFalse(state.settings.autoReconnect)
        assertTrue(state.settings.viewerRemoteInputEnabled)
        assertFalse(state.hasLiveRoster)
        assertTrue(state.hostStates.isEmpty())
    }

    // -- proof scope: unrelated owners must not starve an action ------------------

    @Test
    fun `a projection never mints or retires a proof, so another host cannot starve this one`() {
        val proofA = MutableUiActionProof(ClientUiFixtures.token(UiProofScreen.SESSION_CLOSE, hostId = "a"))
        val epoch = proofA.beginDraw()
        proofA.markCommitted(epoch)
        proofA.setCriticalIdentityReadable(true)
        val rowA = ClientUiFixtures.row("a", rowId = "a1", selectProof = proofA)

        val before = ClientUiState(
            hostStates = listOf(
                ClientUiFixtures.hostState("a", rows = listOf(rowA)),
                ClientUiFixtures.hostState("b", rows = listOf(ClientUiFixtures.row("b", rowId = "b1"))),
            ),
        )
        val state = before.hostState(HostId.parse("a"))
        assertNotNull(state)

        // Another owner reports: new roster, new revision, new connection state. The
        // projection is rebuilt from scratch, and the standing of host a's row is
        // untouched, because nothing in a projection manufactures or retires proofs.
        val after = before.copy(
            hostStates = listOf(
                before.hostStates[0],
                ClientUiFixtures.hostState(
                    "b",
                    connection = HostConnectionState.CONNECTING,
                    rows = listOf(
                        ClientUiFixtures.row("b", rowId = "b2", revision = 99L),
                        ClientUiFixtures.row("b", rowId = "b3", revision = 99L),
                    ),
                ),
            ),
        )

        val carried = assertNotNull(after.sessions.first { it.rowId == "a1" }.selectProof)
        val original = assertNotNull(before.sessions.first { it.rowId == "a1" }.selectProof)
        assertSame(original, carried)
        assertTrue(carried.grantsFor(carried.target))
        assertTrue(proofA.grantsAction())
    }

    @Test
    fun `a row whose own target changed is the only one whose standing is asked about`() {
        val stableProof = MutableUiActionProof(ClientUiFixtures.token(UiProofScreen.SESSION_CLOSE, hostId = "a"))
        val stableEpoch = stableProof.beginDraw()
        stableProof.markCommitted(stableEpoch)
        stableProof.setCriticalIdentityReadable(true)
        val stableRow = ClientUiFixtures.row("a", rowId = "a1", selectProof = stableProof)
        val movingRow = ClientUiFixtures.row("a", rowId = "a2")

        val drawn = orderedSessionRows(
            hostStates = listOf(ClientUiFixtures.hostState("a", rows = listOf(stableRow, movingRow))),
            rowOrder = listOf(SessionRowKey.of(stableRow), SessionRowKey.of(movingRow)),
        )
        assertEquals(listOf("a1", "a2"), drawn.map { it.rowId })

        // The order changes for the row below. The stable row's frozen target still
        // equals its own proof's target, so its action remains spendable while the
        // moved row is the only one whose drawn target has to be re-frozen.
        val reordered = orderedSessionRows(
            hostStates = listOf(ClientUiFixtures.hostState("a", rows = listOf(movingRow, stableRow))),
            rowOrder = listOf(SessionRowKey.of(movingRow), SessionRowKey.of(stableRow)),
        )
        assertEquals(listOf("a2", "a1"), reordered.map { it.rowId })

        val carried = reordered.first { it.rowId == "a1" }
        val carriedProof = assertNotNull(carried.selectProof)
        assertTrue(stableProof.grantsFor(carriedProof.target))
        assertTrue(carriedProof.grantsAction())
    }
}
