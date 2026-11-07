package io.github.rfairburn.pireviewgate.core.client.application

import io.github.rfairburn.pireviewgate.core.client.connection.*
import io.github.rfairburn.pireviewgate.core.client.ui.*
import io.github.rfairburn.pireviewgate.core.hosts.*
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A bounded local transaction, not a replacement UI proof or a reusable Connect permit.
 * Intake happens synchronously in the drawn combined button's callback. Until handoff,
 * the SAME committed form epoch must remain valid. Disposal/re-arming cannot revive it.
 * Only a successful result may hand off once to the window's normal permission flow.
 */
public class AcceptedAddressEdit {
    public class Request internal constructor(
        public val target: EditHostAddressTarget,
        public val address: HostAddress,
        public val connectionGeneration: Long,
        internal val click: FrozenAction,
    ) {
        public val endpoint: Endpoint = Endpoint(address.value, target.expectedOldEndpoint.port)
    }

    /** Exact post-save target. Does not grant trust, permission, or any owner operation. */
    public class Reconnect internal constructor(
        public val hostId: HostId,
        public val endpoint: Endpoint,
        public val connectionGeneration: Long,
        private val click: FrozenAction,
    ) {
        private val spent = AtomicBoolean()

        /** Spend synchronously BEFORE disposing the form, never after a queued handoff. */
        public fun consume(): Boolean = spent.compareAndSet(false, true) && click.isStillCurrent()
    }

    private val current = AtomicReference<Request?>()

    public fun accept(form: EditHostAddressDialog, intent: ClientIntent.SaveHostAddressAndReconnect,
                      host: HostConnectionSnapshot): Request? {
        cancel()
        if (form.target != intent.target || form.addressDraft != intent.address || form.proof !== intent.proof ||
            intent.proof.target.screen != UiProofScreen.HOST_EDIT_ADDRESS ||
            intent.proof.target.hostId != form.target.hostId || host.hostId != form.target.hostId ||
            host.endpoint != form.target.expectedOldEndpoint) return null
        val address = HostAddress.parseOrNull(intent.address) ?: return null
        val click = FrozenAction.capture(intent.proof) ?: return null
        return Request(form.target, address, host.generation, click).also { current.set(it) }
    }

    public fun cancel() { current.set(null) }
    public fun cancel(request: Request) { current.compareAndSet(request, null) }

    /** Latest check at FIFO writer dispatch, before invoking the registry save-only API. */
    public fun canSave(request: Request, snapshot: ConnectionRegistrySnapshot): Boolean {
        val host = snapshot.hosts.firstOrNull { it.hostId == request.target.hostId }
        return current.get() === request && request.click.isStillCurrent() && snapshot.foreground &&
            host != null && host.endpoint == request.target.expectedOldEndpoint && host.generation == request.connectionGeneration
    }

    /**
     * Observe only this host, not global/settings generations or unrelated metadata.
     * During IO, allow the save's own single retirement to publish before its return.
     * Every other target/epoch change permanently cancels; a later matching row cannot revive it.
     */
    public fun observe(snapshot: ConnectionRegistrySnapshot) {
        val request = current.get() ?: return
        val host = snapshot.hosts.firstOrNull { it.hostId == request.target.hostId }
        val old = host != null && host.endpoint == request.target.expectedOldEndpoint && host.generation == request.connectionGeneration
        val saved = request.endpoint != request.target.expectedOldEndpoint && host != null && host.endpoint == request.endpoint &&
            host.generation == request.connectionGeneration + 1
        if (!snapshot.foreground || !request.click.isStillCurrent() || (!old && !saved)) current.compareAndSet(request, null)
    }

    /** Called on Main while the original form is still drawn; never from a later coroutine. */
    public fun takeReconnect(request: Request, result: HostAddressUpdateResult,
                             snapshot: ConnectionRegistrySnapshot): Reconnect? {
        observe(snapshot)
        val generation = when (result) {
            is HostAddressUpdateResult.Saved -> {
                if (result.endpoint != request.endpoint) return null
                request.connectionGeneration + 1
            }
            HostAddressUpdateResult.Unchanged -> request.connectionGeneration
            else -> { current.compareAndSet(request, null); return null }
        }
        val host = snapshot.hosts.firstOrNull { it.hostId == request.target.hostId }
        if (host == null || host.endpoint != request.endpoint || host.generation != generation ||
            !request.click.isStillCurrent() || !current.compareAndSet(request, null)) return null
        return Reconnect(request.target.hostId, request.endpoint, generation, request.click)
    }
}
