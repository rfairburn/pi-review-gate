package io.github.rfairburn.pireviewgate.core.client.runtime

import io.github.rfairburn.pireviewgate.core.client.content.ContentEndpoint
import io.github.rfairburn.pireviewgate.core.client.content.ContentDeadlineSettings
import io.github.rfairburn.pireviewgate.core.client.content.ContentInputPolicy
import io.github.rfairburn.pireviewgate.core.client.content.ContentSendGuard
import io.github.rfairburn.pireviewgate.core.client.roster.RosterClientEndpoint
import io.github.rfairburn.pireviewgate.core.client.roster.RosterDispatchDecision
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentBounds
import io.github.rfairburn.pireviewgate.core.protocol.content.ContentProtocol
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterBounds
import io.github.rfairburn.pireviewgate.core.protocol.roster.RosterWire
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerDelivery
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerSendReceipt
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * The runtime's local monotonic time source, in nanoseconds.
 *
 * Every deadline in this package is a monotonic mark rather than a wall-clock
 * reading: the roster lane's endpoint is handed the same source in whole
 * milliseconds, so the token it returns, the timer armed for that token, and the
 * expiry delivered back to it all agree, and a wall-clock jump can neither advance
 * nor rewind a deadline.
 */
fun interface MonotonicClock {
    fun nowNanos(): Long

    companion object {
        /** The process monotonic clock. */
        val SYSTEM: MonotonicClock = MonotonicClock { System.nanoTime() }
    }
}

/** Cancel one armed deadline. Cancelling twice is harmless. */
fun interface DeadlineHandle {
    fun cancel()
}

/**
 * Where the runtime gets its timers.
 *
 * [dueAtNanos] is an absolute mark on the same [MonotonicClock] the runtime was
 * built with. The callback runs at most once per handle and never after a
 * successful [DeadlineHandle.cancel], so a retired arm cannot fire behind its
 * replacement. Production arms one short-lived coroutine per live deadline; a test
 * supplies a hand-driven virtual clock and fires due marks itself.
 */
fun interface DeadlineScheduler {
    fun schedule(dueAtNanos: Long, onDue: () -> Unit): DeadlineHandle
}

/** The production scheduler: one short-lived coroutine per armed deadline. */
internal class CoroutineDeadlineScheduler(
    private val scope: CoroutineScope,
    private val clock: MonotonicClock,
) : DeadlineScheduler {

    override fun schedule(dueAtNanos: Long, onDue: () -> Unit): DeadlineHandle {
        val job = scope.launch {
            val remaining = dueAtNanos - clock.nowNanos()
            if (remaining > 0L) delay((remaining + 999_999L) / 1_000_000L)
            onDue()
        }
        return DeadlineHandle { job.cancel() }
    }
}

/**
 * Everything the parent connection registry hands this runtime for one live host
 * APP lane attempt.
 *
 * The runtime owns no handshake, pairing, reconnect, retry, or storage: it consumes
 * one already-negotiated APP channel exactly once for the lifetime of the attempt
 * and stops when that channel ends. [connectionGeneration] is the parent's
 * monotonic attempt identity and is never re-derived here; [connectionGuard] is the
 * parent's cheap, thread-safe lifecycle and association fence, consulted for every
 * write this lane attempts.
 */
data class HostChannelBinding(
    val hostId: HostId,
    val channel: PeerByteChannel,
    val connectionGeneration: Long,
    val connectionGuard: PeerSendGuard = PeerSendGuard.NONE,
) {
    init {
        require(connectionGeneration >= 0L) { "connection generation must not be negative" }
    }
}

/**
 * The parent's one CONTENT channel seam.
 *
 * The runtime asks for exactly one content channel per deliberate terminal
 * selection, and closes a channel it is given when that selection is withdrawn,
 * superseded, or completed late. Opening stays the parent's decision: it may refuse
 * by throwing, which the runtime reports as a truthful selection failure and never
 * retries.
 */
fun interface ContentChannelOpener {
    /**
     * Open one CONTENT channel for [hostId] on the connection identified by
     * [connectionGeneration], honouring [connectionGuard] for every write.
     */
    suspend fun open(
        hostId: HostId,
        connectionGeneration: Long,
        connectionGuard: PeerSendGuard,
    ): PeerByteChannel
}

/**
 * Fixed bounds, capability offers, and queue sizes for one runtime.
 *
 * [maxHosts] is this runtime's own concurrent-host ceiling: the full 64, not any
 * per-operation limit the transport imposes elsewhere. Every queue here is bounded,
 * overflow is refused honestly rather than buffered without limit, and nothing
 * replays a step that was refused.
 */
data class ClientRuntimeConfig(
    val rosterBounds: RosterBounds = RosterBounds.DEFAULT,
    /**
     * Optional roster capabilities to offer. Close is always offered by the
     * endpoint itself; this list adds the rest of what this build implements.
     * Offering grants nothing: the owner's acknowledgement is the only authority.
     */
    val rosterCapabilities: List<String> = DEFAULT_ROSTER_CAPABILITIES,
    /** Optional content capabilities to offer, in the same offer-only sense. */
    val contentCapabilities: List<String> = DEFAULT_CONTENT_CAPABILITIES,
    val contentBounds: ContentBounds = ContentBounds.DEFAULT,
    val contentDeadlines: ContentDeadlineSettings = ContentDeadlineSettings.DEFAULT,
    val initialInputPolicy: ContentInputPolicy = ContentInputPolicy(enabled = false, generation = 0L),
    val maxHosts: Int = MAX_HOSTS,
    /** Per-lane signal queue: inbound frames, deadline expiries, send dispositions. */
    val laneSignalQueueCapacity: Int = 64,
    /** Per-lane outbound message queue. Overflow is refused as never dispatched. */
    val laneOutboundQueueCapacity: Int = 64,
    /** Runtime event queue. Producers suspend rather than dropping an event. */
    val eventQueueCapacity: Int = 256,
    /** Bounded wait for one lane's graceful retirement before it is cancelled. */
    val retirementGraceMs: Long = 30_000L,
    /** Correlation id source for both lanes. Ids are this side's own and never reused. */
    val idFactory: () -> String = { UUID.randomUUID().toString() },
) {
    init {
        require(maxHosts in 1..MAX_HOSTS) { "host ceiling is out of range" }
        require(laneSignalQueueCapacity > 0) { "lane signal queue must be bounded and positive" }
        require(laneOutboundQueueCapacity > 0) { "lane outbound queue must be bounded and positive" }
        require(eventQueueCapacity > 0) { "event queue must be bounded and positive" }
        require(retirementGraceMs > 0L) { "retirement grace must be positive" }
        require(rosterCapabilities.distinct().all { RosterWire.KNOWN_OPTIONAL_CAPABILITIES.contains(it) }) {
            "roster capability is not implementable"
        }
        require(
            contentCapabilities.distinct().all { ContentProtocol.IMPLEMENTABLE_OPTIONAL_CAPABILITIES.contains(it) },
        ) {
            "content capability is not implementable"
        }
        require(
            !contentCapabilities.contains(ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY) ||
                contentCapabilities.contains(ContentProtocol.NATIVE_IO_CAPABILITY),
        ) { "content startup input requires the native IO capability" }
    }

    companion object {
        /** Concurrent host rosters this runtime supports at once. */
        const val MAX_HOSTS: Int = 64

        /** Every optional roster capability this build implements. */
        val DEFAULT_ROSTER_CAPABILITIES: List<String> = listOf(
            RosterWire.CREATE_CAPABILITY,
            RosterWire.SAVED_CAPABILITY,
            RosterWire.RENAME_CAPABILITY,
            RosterWire.ROSTER_SLOT_CAPABILITY,
        )

        /** Every optional content capability this build implements. */
        val DEFAULT_CONTENT_CAPABILITIES: List<String> = listOf(
            ContentProtocol.NATIVE_IO_CAPABILITY,
            ContentProtocol.NATIVE_INPUT_STARTUP_CAPABILITY,
        )
    }
}

/**
 * The truthful local disposition of one attempted channel write, derived only from
 * durable evidence.
 *
 * A coroutine cancellation is never itself evidence of "never sent": the durable
 * [PeerSendReceipt] decides, because it records the invocation boundary even when
 * the send call cannot return a value.
 */
internal enum class SendOutcome {
    /** The write was entered and returned. Never a claim that the peer read anything. */
    WRITTEN,

    /** Positively established: no write was ever invoked. */
    NEVER_INVOKED,

    /** The invocation boundary was crossed, or it cannot be excluded. */
    UNKNOWN,
}

internal fun classifySend(receipt: PeerSendReceipt, failure: Throwable?): SendOutcome {
    if (receipt.wasInvoked) {
        return if (receipt.delivery == PeerDelivery.WRITTEN) SendOutcome.WRITTEN else SendOutcome.UNKNOWN
    }
    return when (receipt.delivery) {
        PeerDelivery.NOT_SENT -> SendOutcome.NEVER_INVOKED
        PeerDelivery.WRITTEN -> SendOutcome.WRITTEN
        PeerDelivery.SUBMITTED_UNKNOWN -> SendOutcome.UNKNOWN
        null -> when {
            failure == null -> SendOutcome.WRITTEN
            failure is PeerTransportException && !failure.deliveryIsUnknown -> SendOutcome.NEVER_INVOKED
            else -> SendOutcome.UNKNOWN
        }
    }
}

/**
 * A cheap, non-blocking, thread-safe [PeerSendGuard] over one lane's own lifetime.
 *
 * This one carries only facts the lane itself owns. The model's own decision and the
 * message's own UI fence are carried by [ModelDispatchFence] and
 * [ContentMessageFence], because the real channel evaluates a per-message guard at
 * admission AND again under write ownership immediately before the socket write, and a
 * fence checked only before the queue wait cannot stop a frame that expired inside it.
 */
internal class LifetimeSendGuard(
    private val live: AtomicBoolean,
    private val epoch: AtomicLong? = null,
) : PeerSendGuard {
    override fun allows(): Boolean = live.get()

    override fun epoch(): Long = epoch?.get() ?: 0L
}

/**
 * One roster message's own last-instant model decision, carried into the transport.
 *
 * [RosterClientEndpoint.decideDispatch] is the only place where every fact that can
 * invalidate a queued write is visible together: this endpoint's lifetime, whether the
 * request the message belongs to is still the outstanding one, whether its own deadline
 * passed, whether the observed run and native tuple still match, whether the owner still
 * exposes remote delete, and the message's own caller proof. Passing it as the
 * per-message [PeerSendGuard] means the final writer — not merely the lane before it
 * queued — is what consults those facts, at admission and again immediately before the
 * socket write.
 *
 * It is a synchronized read of endpoint-owned state and one caller-supplied atomic proof
 * check. It performs no I/O, takes no lock the endpoint holds across a suspension or a
 * write, and never runs user code beyond that proof.
 */
internal class RosterMessageFence(
    private val endpoint: RosterClientEndpoint,
    private val messageId: Long,
) : PeerSendGuard {
    override fun allows(): Boolean = endpoint.decideDispatch(messageId) == RosterDispatchDecision.Allow
}

/**
 * One content effect's own guard, plus the fences that apply only to input pages,
 * carried into the transport.
 *
 * [ContentEndpoint.isSendGuardCurrent] is the endpoint's designed last-instant check, and
 * each guard answers only for its own lifetime: an ended input never invalidates a hello,
 * subscribe, resize, unsubscribe, or protocol refusal. [inputOnly] is consulted for
 * [ContentSendGuard.Input] pages alone, so a withdrawn selection, a backgrounded app, a
 * covered pane, a demanded fresh commit, or a caller proof that turned false retires that
 * input's own bytes and nothing else.
 */
internal class ContentMessageFence(
    private val endpoint: ContentEndpoint,
    private val guard: ContentSendGuard,
    private val inputOnly: (() -> Boolean)?,
) : PeerSendGuard {
    override fun allows(): Boolean {
        if (!endpoint.isSendGuardCurrent(guard)) return false
        val fence = inputOnly ?: return true
        return fence()
    }
}

/** Composition of independent cheap guards. All of them must hold. */
internal class CompositeSendGuard(private val parts: List<PeerSendGuard>) : PeerSendGuard {
    override fun allows(): Boolean {
        for (part in parts) if (!part.allows()) return false
        return true
    }

    /** The highest observed epoch, so a bump by any part moves the composite fence. */
    override fun epoch(): Long {
        var highest = 0L
        for (part in parts) {
            val value = part.epoch()
            if (value > highest) highest = value
        }
        return highest
    }
}
