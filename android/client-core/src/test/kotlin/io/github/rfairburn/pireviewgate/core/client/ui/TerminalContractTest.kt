package io.github.rfairburn.pireviewgate.core.client.ui

import io.github.rfairburn.pireviewgate.core.hosts.HostId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** Back handling, transient input state, coverage, and the cross-host switcher. */
class TerminalContractTest {

    @Test
    fun `back retires the sheet, then the keyboard, then the terminal itself`() {
        val withSheet = ClientUiFixtures.terminalState(keyboardVisible = true, quickSwitcherVisible = true)
        assertEquals(TerminalBackAction.DISMISS_QUICK_SWITCHER, withSheet.backAction())

        val withKeyboard = ClientUiFixtures.terminalState(keyboardVisible = true)
        assertEquals(TerminalBackAction.DISMISS_KEYBOARD, withKeyboard.backAction())

        val bare = ClientUiFixtures.terminalState()
        assertEquals(TerminalBackAction.LEAVE_TERMINAL, bare.backAction())
    }

    @Test
    fun `leaving the terminal is a detach intent and asserts nothing about the owner`() {
        // The intent type carries no host, row, close, or stop field: detaching a
        // view cannot be read as an instruction to the owner.
        val intent: ClientIntent = ClientIntent.LeaveTerminal
        assertEquals(ClientIntent.LeaveTerminal, intent)
    }

    @Test
    fun `re-basing onto another target clears every transient affordance`() {
        val held = ClientUiFixtures.terminalState(
            keyboardVisible = true,
            extraKeysVisible = true,
            modifiers = TerminalModifiers(ctrl = true, shift = true),
        )
        val same = held.rebasedTo(held.target)
        assertEquals(held, same)

        val other = TerminalTarget(HostId.parse("b"), ClientUiFixtures.RUN_B, "row-9", 4L)
        val rebased = held.rebasedTo(other)
        assertEquals(other, rebased.target)
        assertTrue(rebased.modifiers.isNone)
        assertFalse(rebased.keyboardVisible)
        assertFalse(rebased.extraKeysVisible)
    }

    @Test
    fun `taking coverage drops held modifiers so nothing sticky rides over`() {
        val held = ClientUiFixtures.terminalState(modifiers = TerminalModifiers(alt = true))
        val covered = held.withCoverage(UiCoverage.MODAL_DIALOG)
        assertTrue(covered.coverage.suspendsTerminalInput)
        assertTrue(covered.modifiers.isNone)

        val cleared = covered.withCoverage(UiCoverage.NONE)
        assertFalse(cleared.coverage.suspendsTerminalInput)
    }

    @Test
    fun `only none coverage leaves terminal input unsuspended`() {
        assertFalse(UiCoverage.NONE.suspendsTerminalInput)
        assertTrue(UiCoverage.MODAL_DIALOG.suspendsTerminalInput)
        assertTrue(UiCoverage.OPEN_MENU.suspendsTerminalInput)
        assertTrue(UiCoverage.BOTTOM_SHEET.suspendsTerminalInput)
    }

    @Test
    fun `modifiers toggle independently and report what is held`() {
        val one = TerminalModifiers.NONE.toggled(TerminalModifier.CTRL)
        assertTrue(one.holds(TerminalModifier.CTRL))
        assertFalse(one.holds(TerminalModifier.ALT))
        val two = one.toggled(TerminalModifier.ALT)
        assertTrue(two.ctrl && two.alt)
        assertTrue(two.toggled(TerminalModifier.CTRL).toggled(TerminalModifier.ALT).isNone)
    }

    @Test
    fun `a key request carries a semantic key and the held modifiers, never bytes`() {
        val request = TerminalKeyRequest(TerminalControlKey.TAB, TerminalModifiers(ctrl = true))
        assertEquals(TerminalControlKey.TAB, request.key)
        assertTrue(request.modifiers.ctrl)
        assertEquals(TerminalModifiers.NONE, TerminalKeyRequest(TerminalControlKey.ESCAPE).modifiers)
    }

    @Test
    fun `a terminal target requires a controller-issued positive generation`() {
        assertTrue(TerminalTarget(HostId.parse("a"), ClientUiFixtures.RUN_A, "row-1", 1L).selectionGeneration == 1L)
        runCatching { TerminalTarget(HostId.parse("a"), ClientUiFixtures.RUN_A, "row-1", 0L) }
            .onSuccess { kotlin.test.fail("a non-positive selection generation must be refused") }
    }

    @Test
    fun `the quick switcher spans every configured host and labels the current target`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val b1 = ClientUiFixtures.row("b", rowId = "b1", stale = true)
        val hosts = listOf(
            ClientUiFixtures.hostState("a", rows = listOf(a1)),
            ClientUiFixtures.hostState("b", rows = listOf(b1)),
            ClientUiFixtures.hostState("c", rows = null),
            ClientUiFixtures.hostState("d", rows = emptyList()),
        )
        val current = TerminalTarget(HostId.parse("a"), ClientUiFixtures.RUN_A, "a1", 3L)
        val rows = quickSwitcherRows(hosts, current)

        assertEquals(
            listOf(
                QuickSwitcherRow.Session::class,
                QuickSwitcherRow.Session::class,
                QuickSwitcherRow.HostWithoutRoster::class,
                QuickSwitcherRow.HostWithoutRoster::class,
            ),
            rows.map { it::class },
        )
        val sessions = rows.filterIsInstance<QuickSwitcherRow.Session>()
        assertEquals(listOf(true, false), sessions.map { it.isCurrent })
        assertTrue(sessions.last().session.stale)
        assertEquals(HostId.parse("c"), rows.filterIsInstance<QuickSwitcherRow.HostWithoutRoster>().first().host.host.id)
    }

    @Test
    fun `the quick switcher interleaves canonical sessions without moving empty host slots`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val a2 = ClientUiFixtures.row("a", rowId = "a2")
        val b1 = ClientUiFixtures.row("b", rowId = "b1", stale = true)
        val b2 = ClientUiFixtures.row("b", rowId = "b2", stale = true)
        val neverReported = ClientUiFixtures.hostState("c", HostConnectionState.DISCONNECTED)
        val reportedEmpty = ClientUiFixtures.hostState("d", HostConnectionState.CONNECTING, rows = emptyList())
        val staleEmpty = ClientUiFixtures.hostState("e", HostConnectionState.ERROR, rows = emptyList()).let {
            it.copy(roster = it.roster!!.copy(freshness = RosterFreshness.STALE))
        }
        val hosts = listOf(
            neverReported,
            ClientUiFixtures.hostState("a", rows = listOf(a1, a2)),
            reportedEmpty,
            ClientUiFixtures.hostState("b", HostConnectionState.RETRYING, rows = listOf(b1, b2)),
            staleEmpty,
        )
        val expected = listOf(b2, a1, b1, a2)
        val order = expected.map { SessionRowKey.of(it) }
        val rows = quickSwitcherRows(hosts, TerminalTarget.of(b1, 3L), order)
        val sessions = rows.filterIsInstance<QuickSwitcherRow.Session>()

        assertEquals(expected, sessions.map { it.session })
        assertEquals(orderedSessionRows(hosts, order), sessions.map { it.session })
        expected.zip(sessions).forEach { (original, entry) -> assertSame(original, entry.session) }
        assertEquals(listOf(false, false, true, false), sessions.map { it.isCurrent })
        assertTrue(sessions[0].session.stale)
        assertTrue(sessions[2].session.stale)
        listOf(0 to neverReported, 3 to reportedEmpty, 6 to staleEmpty).forEach { (index, host) ->
            assertSame(host, (rows[index] as QuickSwitcherRow.HostWithoutRoster).host)
        }
        assertEquals(listOf(a1, a2), hosts[1].rows)
        assertEquals(listOf(b1, b2), hosts[3].rows)
        assertEquals(listOf("c", "a", "d", "b", "e"), hosts.map { it.host.id.value })
    }

    @Test
    fun `the quick switcher resolves full keys and ignores unknown and repeated order keys`() {
        val a = ClientUiFixtures.row("a", rowId = "shared")
        val aOtherRun = a.copy(hostRunId = ClientUiFixtures.RUN_B, stale = true)
        val b = ClientUiFixtures.row("b", rowId = "shared")
        val unlisted = ClientUiFixtures.row("b", rowId = "unlisted")
        val hosts = listOf(
            ClientUiFixtures.hostState("a", rows = listOf(a, aOtherRun)),
            ClientUiFixtures.hostState("b", rows = listOf(b, unlisted)),
        )
        val order = listOf(
            SessionRowKey.of(b).copy(hostId = HostId.parse("missing")),
            SessionRowKey.of(b),
            SessionRowKey.of(aOtherRun),
            SessionRowKey.of(b),
            SessionRowKey.of(a).copy(rowId = "missing"),
            SessionRowKey.of(b).copy(hostRunId = ClientUiFixtures.RUN_B),
            SessionRowKey.of(aOtherRun),
        )
        val current = TerminalTarget.of(aOtherRun, 7L)
        val rows = quickSwitcherRows(hosts, current, order)
        val sessions = rows.filterIsInstance<QuickSwitcherRow.Session>()

        assertEquals(listOf(b, aOtherRun, a, unlisted), sessions.map { it.session })
        assertEquals(orderedSessionRows(hosts, order), sessions.map { it.session })
        assertEquals(listOf(false, true, false, false), sessions.map { it.isCurrent })
        assertEquals(4, rows.size)
        assertTrue(sessions[1].session.stale)
        assertTrue(quickSwitcherRows(hosts, null, order).filterIsInstance<QuickSwitcherRow.Session>().none { it.isCurrent })
    }

    @Test
    fun `the quick switcher never creates sessions from order keys for empty hosts`() {
        val hosts = listOf(
            ClientUiFixtures.hostState("a", HostConnectionState.DISCONNECTED),
            ClientUiFixtures.hostState("b", HostConnectionState.ERROR, rows = emptyList()),
        )
        val missing = ClientUiFixtures.row("a")
        val order = listOf(SessionRowKey.of(missing), SessionRowKey.of(missing))

        assertEquals(
            hosts.map { QuickSwitcherRow.HostWithoutRoster(it) },
            quickSwitcherRows(hosts, TerminalTarget.of(missing, 1L), order),
        )
        assertTrue(quickSwitcherRows(emptyList(), null, order).isEmpty())
    }

    @Test
    fun `the quick switcher default and empty order preserve saved host and owner row slots`() {
        val a1 = ClientUiFixtures.row("a", rowId = "a1")
        val a2 = ClientUiFixtures.row("a", rowId = "a2")
        val b1 = ClientUiFixtures.row("b", rowId = "b1")
        val b2 = ClientUiFixtures.row("b", rowId = "b2")
        val empty = ClientUiFixtures.hostState("c", HostConnectionState.PAIRING)
        val hosts = listOf(
            ClientUiFixtures.hostState("b", rows = listOf(b2, b1)),
            empty,
            ClientUiFixtures.hostState("a", rows = listOf(a2, a1)),
        )
        val current = TerminalTarget.of(a1, 2L)
        val expected = listOf(
            QuickSwitcherRow.Session(b2, false),
            QuickSwitcherRow.Session(b1, false),
            QuickSwitcherRow.HostWithoutRoster(empty),
            QuickSwitcherRow.Session(a2, false),
            QuickSwitcherRow.Session(a1, true),
        )

        assertEquals(expected, quickSwitcherRows(hosts, current))
        assertEquals(expected, quickSwitcherRows(hosts, current, emptyList()))
    }

    @Test
    fun `the quick switcher has no current target when the screen is not a terminal`() {
        val rows = quickSwitcherRows(listOf(ClientUiFixtures.hostState("a", rows = listOf(ClientUiFixtures.row("a")))), null)
        assertTrue(rows.filterIsInstance<QuickSwitcherRow.Session>().none { it.isCurrent })
    }
}
