package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel

/**
 * One authenticated application channel this side just opened.
 *
 * This is the handoff point between connection ownership and protocol
 * ownership. The registry opened the channel and owns its lifecycle; the
 * receiver owns the one reader over it. The registry never calls
 * [PeerByteChannel.receive]: exactly one reader may consume a channel, and a
 * second reader would silently steal frames from the first.
 *
 * [generation] is this destination's admission epoch at the moment the channel
 * was accepted. A receiver must carry it into every operation and drop any late
 * result that no longer matches, because the same [hostId] can be reconnected
 * later under a newer epoch.
 */
public class HostAppChannel internal constructor(
    public val hostId: HostId,
    public val endpoint: Endpoint,
    public val generation: Long,
    public val peerFingerprint: String,
    /** The live channel. Bytes only: it carries no permission or capability. */
    public val channel: PeerByteChannel,
)

/** One deliberate content-lane channel opened on an already connected host. */
public class HostContentChannel internal constructor(
    public val hostId: HostId,
    public val endpoint: Endpoint,
    public val generation: Long,
    public val peerFingerprint: String,
    public val channel: PeerByteChannel,
)

/** Why a channel this side reported is no longer usable. */
@ConsistentCopyVisibility
public data class HostChannelLost internal constructor(
    public val hostId: HostId,
    public val endpoint: Endpoint,
    /** The epoch the channel belonged to. */
    public val generation: Long,
    public val reason: HostConnectionReason,
    /**
     * True when this host already moved on: the loss belongs to a retired
     * attempt, so the receiver must drop its state for that channel and must
     * not treat it as a removal, a metadata change, or a fresh disconnection.
     */
    public val stale: Boolean,
)

/**
 * The typed handoff a higher coordinator subscribes to.
 *
 * It reports channels and their retirement — never sockets, credentials, key
 * material, or trust decisions. A UI never receives these events: it observes
 * [ConnectionRegistrySnapshot], which carries no channel at all.
 *
 * Callbacks run on the registry's own thread pool with no registry lock held,
 * so a listener may take its own lock or schedule work. A listener must not
 * block: the registry reports a lost channel exactly once and does not queue
 * events behind a slow consumer.
 */
public interface HostConnectionListener {
    /** One application channel is open and its reader slot is free. */
    public fun onAppChannelAvailable(channel: HostAppChannel) {}

    /** One content-lane channel opened for a deliberate selection. */
    public fun onContentChannelAvailable(channel: HostContentChannel) {}

    /**
     * A previously reported channel ended, or its attempt was retired.
     *
     * [HostChannelLost.stale] distinguishes a late report about a superseded
     * attempt from the loss of the channel that is current.
     */
    public fun onChannelLost(lost: HostChannelLost) {}
}
