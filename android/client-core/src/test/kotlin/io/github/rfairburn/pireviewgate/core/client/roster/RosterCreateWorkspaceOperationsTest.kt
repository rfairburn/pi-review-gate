package io.github.rfairburn.pireviewgate.core.client.roster

import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliBackend
import io.github.rfairburn.pireviewgate.core.protocol.native.NativeCliTarget
import io.github.rfairburn.pireviewgate.core.protocol.roster.OwnerCreateFacts
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterFrame
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

/**
 * The request-specific create-workspace flag through the real endpoint (#493).
 *
 * A checked request reaches the Pi or native create frame only on a channel whose
 * owner acknowledged the flag; anywhere else it is refused as never submitted,
 * before any write, pending slot, or attempt number. An unchecked request is the
 * exact legacy frame on every owner. Synthetic owners only.
 */
class RosterCreateWorkspaceOperationsTest {

    private val run = RosterClientHarness.RUN_ID
    private val target = NativeCliTarget("claude-default", NativeCliBackend.CLAUDE, "Claude default")

    private val offered = listOf(
        RosterWire.CLOSE_CAPABILITY,
        RosterWire.CREATE_CAPABILITY,
        RosterWire.NATIVE_CAPABILITY,
        RosterWire.NATIVE_AVAILABILITY_CAPABILITY,
        RosterWire.CREATE_WORKSPACE_CAPABILITY,
    )

    private fun subscribed(acknowledged: List<String>): RosterClientHarness {
        val harness = RosterClientHarness(offeredCapabilities = offered)
        harness.start()
        harness.acknowledgeHandshake(listOf(RosterWire.REQUIRED_CAPABILITY) + acknowledged)
        harness.push(harness.endpoint.subscribe())
        harness.publishSnapshot(nativeCliTargets = listOf(target))
        return harness
    }

    private fun current(harness: RosterClientHarness) =
        requireNotNull(harness.endpoint.state().projection.nativeCatalogScope)

    private fun piCreate(
        harness: RosterClientHarness,
        createWorkspace: Boolean,
        proofFlag: Boolean = createWorkspace,
        ui: RosterUiProof = RosterClientHarness.TRUE_PROOF,
    ) = RosterCreateCommand(
        run, "/srv/owner/new",
        RosterSendProof.Form(harness.generation, run, "/srv/owner/new", ui, proofFlag),
        createWorkspace,
    )

    private fun nativeCreate(
        harness: RosterClientHarness,
        createWorkspace: Boolean,
        proofFlag: Boolean = createWorkspace,
    ) = RosterNativeCreateCommand(
        run, "/srv/owner/new", NativeCliBackend.CLAUDE, "claude-default",
        RosterSendProof.NativeForm(
            harness.generation, run, "/srv/owner/new", NativeCliBackend.CLAUDE, "claude-default",
            current(harness), RosterClientHarness.TRUE_PROOF, proofFlag,
        ),
        createWorkspace,
    )

    private fun assertNothingSubmitted(harness: RosterClientHarness, sendsBefore: Int, reason: RosterNotSentReason) {
        assertEquals(sendsBefore, harness.sends.size, "nothing may be written")
        assertEquals(0L, harness.endpoint.state().createSequence, "no attempt number may be consumed")
        assertTrue(harness.endpoint.state().pending.none { it.kind == RosterOperationKind.CREATE })
        assertEquals(RosterOperationKind.CREATE to reason, harness.refusals().last())
    }

    @Test
    fun `a checked create reaches both create frames only on an acknowledging owner`() {
        val harness = subscribed(offered)
        assertTrue(harness.endpoint.state().supportsCreateWorkspace)

        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = true)))
        val pi = assertIs<RosterFrame.CreateRequest>(harness.sends.last().frame)
        assertTrue(pi.createWorkspace)
        assertEquals(1L, pi.sequence)
        assertTrue(RosterProtocol.encode(pi).decodeToString().endsWith(""","createWorkspace":true}"""))
        harness.drain()
        harness.deliver(RosterFrame.CreateResult(pi.requestId, OwnerCreateFacts.Refused))

        harness.push(harness.endpoint.createNativeSession(nativeCreate(harness, createWorkspace = true)))
        val native = assertIs<RosterFrame.NativeCreateRequest>(harness.sends.last().frame)
        assertTrue(native.createWorkspace)
        assertEquals(2L, native.sequence, "the flag shares the existing create slot and attempt scalar")
        assertTrue(RosterProtocol.encode(native).decodeToString().endsWith(""","createWorkspace":true}"""))
    }

    @Test
    fun `an unchecked create is the exact legacy frame even on an acknowledging owner`() {
        val harness = subscribed(offered)
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = false)))
        val pi = assertIs<RosterFrame.CreateRequest>(harness.sends.last().frame)
        assertFalse(pi.createWorkspace)
        assertFalse(RosterProtocol.encode(pi).decodeToString().contains("createWorkspace"))
    }

    @Test
    fun `a checked create to an older owner sends nothing and consumes no attempt number`() {
        // The owner acknowledged both create lanes but not the flag: an older owner.
        val legacy = subscribed(offered - RosterWire.CREATE_WORKSPACE_CAPABILITY)
        assertFalse(legacy.endpoint.state().supportsCreateWorkspace)
        val before = legacy.sends.size

        legacy.push(legacy.endpoint.createSession(piCreate(legacy, createWorkspace = true)))
        assertNothingSubmitted(legacy, before, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        legacy.push(legacy.endpoint.createNativeSession(nativeCreate(legacy, createWorkspace = true)))
        assertNothingSubmitted(legacy, before, RosterNotSentReason.CAPABILITY_UNSUPPORTED)

        // The same owner still takes the unchecked legacy create unchanged, as attempt 1.
        legacy.push(legacy.endpoint.createSession(piCreate(legacy, createWorkspace = false)))
        val sent = assertIs<RosterFrame.CreateRequest>(legacy.sends.last().frame)
        assertEquals(1L, sent.sequence)
        assertFalse(RosterProtocol.encode(sent).decodeToString().contains("createWorkspace"))
    }

    @Test
    fun `a native-only acknowledgement carries the flag on the native lane alone`() {
        val nativeOnly = subscribed(listOf(
            RosterWire.NATIVE_CAPABILITY,
            RosterWire.NATIVE_AVAILABILITY_CAPABILITY,
            RosterWire.CREATE_WORKSPACE_CAPABILITY,
        ))
        assertTrue(nativeOnly.endpoint.state().supportsCreateWorkspace)
        val before = nativeOnly.sends.size
        // The flag is not a lane: a Pi create is still refused on the Pi capability.
        nativeOnly.push(nativeOnly.endpoint.createSession(piCreate(nativeOnly, createWorkspace = true)))
        assertNothingSubmitted(nativeOnly, before, RosterNotSentReason.CAPABILITY_UNSUPPORTED)
        nativeOnly.push(nativeOnly.endpoint.createNativeSession(nativeCreate(nativeOnly, createWorkspace = true)))
        assertTrue(assertIs<RosterFrame.NativeCreateRequest>(nativeOnly.sends.last().frame).createWorkspace)
    }

    @Test
    fun `a proof that froze a different flag is refused as never submitted on both lanes`() {
        val harness = subscribed(offered)
        val before = harness.sends.size
        for ((command, proof) in listOf(true to false, false to true)) {
            harness.push(harness.endpoint.createSession(piCreate(harness, command, proofFlag = proof)))
            assertNothingSubmitted(harness, before, RosterNotSentReason.INVALID_REQUEST)
            harness.push(harness.endpoint.createNativeSession(nativeCreate(harness, command, proofFlag = proof)))
            assertNothingSubmitted(harness, before, RosterNotSentReason.INVALID_REQUEST)
        }
    }

    @Test
    fun `a checked create whose form proof lapses before the write is never dispatched`() {
        val harness = subscribed(offered)
        var current = true
        harness.push(harness.endpoint.createSession(
            piCreate(harness, createWorkspace = true, ui = RosterUiProof { current }),
        ))
        val index = harness.sends.indexOfLast { it.frame is RosterFrame.CreateRequest }
        // The operator unchecks (or otherwise edits) the form while the write is queued.
        current = false
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
    }

    @Test
    fun `a checked Pi create to a retired subscription sends nothing and consumes no attempt number`() {
        val harness = subscribed(offered)
        // Drawn from the CURRENT observation, then the subscription retires.
        val heldNative = nativeCreate(harness, createWorkspace = true)
        harness.push(harness.endpoint.resync())
        assertEquals(
            RosterProjectionState.STALE,
            harness.endpoint.state().projection.state,
        )
        val before = harness.sends.size
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = true)))
        assertNothingSubmitted(harness, before, RosterNotSentReason.TARGET_UNAVAILABLE)
        // The native lane refuses the same stale observation through its own fence.
        harness.push(harness.endpoint.createNativeSession(heldNative))
        assertNothingSubmitted(harness, before, RosterNotSentReason.TARGET_UNAVAILABLE)
    }

    @Test
    fun `an unchecked Pi create keeps its legacy admission on a retired subscription`() {
        // Reference: the same stale state, unchecked, on the same endpoint shape.
        val harness = subscribed(offered)
        harness.push(harness.endpoint.resync())
        val before = harness.sends.size
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = false)))
        val sent = harness.sends.drop(before).map { it.frame }.filterIsInstance<RosterFrame.CreateRequest>()
        assertEquals(1, sent.size, "the unchecked legacy create is not newly fenced")
        assertFalse(sent.single().createWorkspace)
    }

    @Test
    fun `a checked Pi create naming a replaced owner run is refused before any attempt number`() {
        val harness = subscribed(offered)
        harness.publishSnapshot(runId = "run-0002", revision = 2L)
        val before = harness.sends.size
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = true)))
        assertNothingSubmitted(harness, before, RosterNotSentReason.TARGET_UNAVAILABLE)
    }

    @Test
    fun `a queued checked Pi create is never dispatched after the subscription retires`() {
        val harness = subscribed(offered)
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = true)))
        val index = harness.sends.indexOfLast { it.frame is RosterFrame.CreateRequest }
        assertEquals(RosterDispatchDecision.Allow, harness.decide(index))
        harness.push(harness.endpoint.resync())
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
    }

    @Test
    fun `a queued checked Pi create is never dispatched after the owner run is replaced`() {
        val harness = subscribed(offered)
        harness.push(harness.endpoint.createSession(piCreate(harness, createWorkspace = true)))
        val index = harness.sends.indexOfLast { it.frame is RosterFrame.CreateRequest }
        harness.publishSnapshot(runId = "run-0002", revision = 2L)
        assertEquals(
            RosterDispatchDecision.Refuse(RosterSendRefusal.PROOF_UNAVAILABLE),
            harness.decide(index),
        )
    }
}
