package io.github.rfairburn.pireviewgate.core.client.connection

import io.github.rfairburn.pireviewgate.core.hosts.ConfiguredHost
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.hosts.HostAddress
import io.github.rfairburn.pireviewgate.core.hosts.HostCatalog
import io.github.rfairburn.pireviewgate.core.hosts.HostId
import io.github.rfairburn.pireviewgate.core.hosts.HostLabel
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettings
import io.github.rfairburn.pireviewgate.core.hosts.NetworkSettingsStore
import io.github.rfairburn.pireviewgate.core.hosts.SettingsMutation
import io.github.rfairburn.pireviewgate.core.hosts.StorageException
import io.github.rfairburn.pireviewgate.core.hosts.StorageFailureReason
import io.github.rfairburn.pireviewgate.core.identity.HostPinStore
import io.github.rfairburn.pireviewgate.core.identity.IdentityException
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityHandle
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStatus
import io.github.rfairburn.pireviewgate.core.identity.PeerIdentityStore
import io.github.rfairburn.pireviewgate.core.identity.PinClearResult
import io.github.rfairburn.pireviewgate.core.identity.PinRead
import io.github.rfairburn.pireviewgate.core.identity.PinRecordResult
import io.github.rfairburn.pireviewgate.core.transport.PeerAdmissionGate
import io.github.rfairburn.pireviewgate.core.transport.PeerAppLane
import io.github.rfairburn.pireviewgate.core.transport.PeerByteChannel
import io.github.rfairburn.pireviewgate.core.transport.PeerEndpoint
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyApprover
import io.github.rfairburn.pireviewgate.core.transport.PeerKeyDecision
import io.github.rfairburn.pireviewgate.core.transport.PeerPairOptions
import io.github.rfairburn.pireviewgate.core.transport.PeerPairStatus
import io.github.rfairburn.pireviewgate.core.transport.PeerSendGuard
import io.github.rfairburn.pireviewgate.core.transport.PeerServerKeyPrompt
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportErrorCode
import io.github.rfairburn.pireviewgate.core.transport.PeerTransportException
import io.github.rfairburn.pireviewgate.core.transport.PeerTrustSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Every host connection this phone client holds.
 *
 * The client is multi-host by construction. One entry in the saved catalog is
 * one destination with its own admission epoch, its own attempt, its own retry
 * schedule, and — the part that makes independence real — its own
 * [HostTransport] instance for the lifetime of that connection. Nothing here
 * pools destinations and nothing here elects a single active host, so closing
 * one destination disposes one transport and touches no other. Two saved hosts
 * at the same address, or two Pi hosts whose session rows happen to look
 * identical, stay two honest views.
 *
 * Saved-catalog capacity is the whole limit story: every saved host may be
 * connected at once. The transport's per-instance operation bound counts one
 * destination's in-flight pair/open calls and is never consulted as a host cap.
 *
 * ## What this owns, and what it deliberately does not
 *
 * It owns dialing, pairing, pinning, retrying, and tearing down. It does not
 * read a channel. Once an application channel opens, exactly one reader — a
 * higher coordinator — consumes it; a second reader would quietly steal frames,
 * so the registry only awaits the channel's end. Protocol meaning, roster rows,
 * viewport selection, and remote operations belong above this layer, and the
 * [HostConnectionListener] handoff is how they receive the channel.
 *
 * It also never touches an Android lifecycle type. [setForeground] is the entire
 * contract: an Activity calls it, this reacts. There is no foreground service,
 * and no channel is kept alive behind the user's back.
 *
 * ## Lifecycle contract
 *
 * - Background closes everything. `setForeground(false)` invalidates every
 *   admission epoch synchronously and first, so a queued frame is dropped rather
 *   than written even before its transport is gone; then attempts, timers, and
 *   pending confirmations are cancelled and every owned transport is disposed.
 *   The far side's sessions keep running: nothing here asks an owner to close,
 *   create, or cancel anything, and no accepted owner work is claimed.
 * - Foreground dials fresh. Only hosts that were active, are still saved, are
 *   not suppressed, and already have a remembered key are re-dialed — with that
 *   key only. A resume never pairs, never prompts, and never replaces a key,
 *   because coming back to the app is not a request to start a new trust
 *   relationship.
 * - No replay. Input, remote operations, consent decisions, and viewport state
 *   are never buffered, so there is nothing to replay. A confirmation that was
 *   pending when the app backgrounded is cancelled, not deferred.
 *
 * ## Fail closed
 *
 * A trust or settings read that fails is reported as a refusal and changes
 * nothing. It is never downgraded into "no key remembered", which would turn
 * unreadable trust into an unattended first-use acceptance. Saved configuration
 * that cannot be read also forces
 * [ConnectionRegistrySnapshot.viewerRemoteInputEnabled] off: an unknown
 * preference is never treated as enabled.
 *
 * @param settingsStore durable saved configuration. Reading it creates nothing.
 * @param pinStore durable remembered server keys, one slot per association.
 * @param identityStore this device's own identity. Only an explicit Connect may
 *   initialize it; startup and observation never do.
 * @param transportFactory the per-destination transport seam. Production
 *   delegates to the real peer transport; a fixture supplies its own.
 * @param networkAccess the injected local-network capability. Consulted, never
 *   requested, and never inferred from a timeout.
 * @param policy human-flow windows and the finite automatic schedule.
 * @param promptValidator the foreground UI's committed-prompt state. Required:
 *   both a key confirmation and its denial are admitted only while the UI says it
 *   is presenting that exact prompt, so an adapter that cannot answer gets
 *   refusals rather than silent trust.
 * @param dispatcher where attempts and timers run. Production uses IO.
 */
public class HostConnectionRegistry(
    private val settingsStore: NetworkSettingsStore,
    private val pinStore: HostPinStore,
    private val identityStore: PeerIdentityStore,
    private val promptValidator: CommittedPromptValidator,
    private val transportFactory: HostTransportFactory = HostTransportFactory.PRODUCTION,
    private val networkAccess: NetworkAccessAdmission = NetworkAccessAdmission.UNRESTRICTED,
    private val policy: HostConnectionPolicy = HostConnectionPolicy.DEFAULT,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Any()

    /**
     * Orders settings publication: stage, durable write, and result adoption
     * happen in that order for one mutation at a time.
     *
     * The registry lock is never held across the store write, so a slow document
     * cannot stall a guard or a socket callback. This monitor exists because the
     * saved configuration is one whole document: two threads that staged in order
     * but published out of order would silently roll the later change back on
     * disk while both believed they had saved.
     */
    private val settingsTransaction = Any()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val _snapshot = MutableStateFlow(BLANK)

    /**
     * The current observation. A UI collects this: it carries no channel, no
     * socket, and no credential.
     */
    public val snapshot: StateFlow<ConnectionRegistrySnapshot> = _snapshot.asStateFlow()

    private val listeners = ArrayList<HostConnectionListener>()
    private val runtimes = LinkedHashMap<HostId, HostRuntime>()
    private val consents = LinkedHashMap<Long, PendingConsent>()
    private val suppressionOverride = HashSet<HostId>()

    /**
     * Hosts whose removal is in progress, from retirement through durable
     * completion.
     *
     * Removal spans storage, so it cannot hold the registry lock for its whole
     * lifetime. Without this fence the interval between retiring the current
     * attempt and finishing the removal is an open door: an explicit Connect can
     * re-dial using the key that has not been cleared yet, and removal then
     * deletes the runtime underneath that replacement without ever disposing its
     * transport — leaving a live connection that no later background or close can
     * even find.
     */
    private val removingHosts = HashSet<HostId>()
    private val restoreCandidates = LinkedHashSet<HostId>()

    /**
     * Saved association and remembered key per host, published as one immutable
     * map after every operation storage actually confirmed. Send guards read this
     * without taking the lock, which is what lets a guard refuse a frame without
     * doing IO or ordering itself against a socket.
     */
    @Volatile
    private var eligibility: Map<HostId, HostEligibility> = emptyMap()

    private var settings: NetworkSettings = NetworkSettings.DEFAULTS

    /** Read by send guards without the lock, so it is published atomically. */
    @Volatile
    private var trustUsable: Boolean = false
    private var settingsState: StorageHandleState = StorageHandleState(available = false)
    private var trustState: StorageHandleState = StorageHandleState(available = false)
    private var identityObservation: DeviceIdentityObservation = DeviceIdentityObservation.NeverInitialized
    private var notice: RegistryNotice? = null

    private var snapshotGeneration = 0L
    private var settingsGeneration = 0L
    private var foregroundEpoch = 0L
    private var foreground = true
    private var started = false
    private var startupAutoPending = false
    private var closed = false
    private var nextConsentId = 1L

    // ---------------------------------------------------------------- startup

    /**
     * Read saved state and publish it.
     *
     * This creates nothing: no directory, no document, no key, no identity, and
     * no connection the user did not ask for. When the automatic-reconnect
     * preference is on, eligible hosts get their first bounded retry scheduled;
     * when it is off — the default — nothing dials until asked.
     */
    public fun start() {
        val settingsRead = runCatching { settingsStore.read() }
        val pinsRead = runCatching { pinStore.snapshot().associate { it.hostId to it.key.keyId } }
        val identity = observeIdentity()

        val toSchedule = synchronized(lock) sync@{
            if (closed) return@sync emptyList()
            settingsState = if (settingsRead.isSuccess) {
                StorageHandleState(available = true)
            } else {
                StorageHandleState(available = false, reason = StorageFailureReason.UNAVAILABLE)
            }
            settings = settingsRead.getOrNull() ?: NetworkSettings.DEFAULTS
            trustState = if (pinsRead.isSuccess) {
                StorageHandleState(available = true)
            } else {
                StorageHandleState(available = false, reason = StorageFailureReason.UNAVAILABLE)
            }
            trustUsable = pinsRead.isSuccess
            identityObservation = identity
            rebuildRuntimes(settings.hosts, pinsRead.getOrNull() ?: emptyMap())
            // Background construction defers the saved Auto startup opportunity,
            // not a connection: eligibility is checked at the first foreground.
            if (!started) startupAutoPending = settings.autoReconnect && !foreground
            started = true
            val eligible = ArrayList<HostId>()
            if (settings.autoReconnect && foreground) {
                for (runtime in runtimes.values) if (autoEligibleLocked(runtime)) eligible += runtime.id
            }
            publishLocked()
            eligible
        }
        // A saved automatic-reconnect preference dials at once on startup; only
        // the retries that follow a failure wait out the finite backoff.
        toSchedule.forEach { scheduleRetry(it, immediate = true) }
    }

    /**
     * Re-read saved configuration and trust after another component changed them.
     *
     * New hosts appear and removed hosts are retired locally. No connection is
     * opened that the previous snapshot did not already justify, and no live
     * channel is disturbed by a reload that succeeded.
     *
     * A refused read is published as a refusal, never ignored. Saved
     * configuration that could not be read leaves [settingsState] unavailable,
     * which forces the viewer's remote-input preference off in the snapshot: an
     * unknown preference is never treated as enabled. Trust that could not be
     * read revokes outbound eligibility outright — cached pins the registry can
     * no longer confirm are not evidence, and a channel that keeps admitting
     * frames against them would be trusting storage the registry has just
     * reported as broken. Availability returns only with a read that succeeded.
     *
     * Reload takes the same settings transaction as a publication, in the same
     * order — transaction first, registry lock second. Serializing writers alone
     * is not enough: a reload could read the document, a Disconnect could durably
     * save its suppression and drop its in-memory override, and the reload could
     * then adopt the copy it captured earlier, quietly un-suppressing a host the
     * user stopped. Holding the transaction across the read and the adoption means
     * a reload either sees the suppression or is overtaken by it, never both.
     */
    public fun reload(): HostCommandResult = synchronized(settingsTransaction) {
        val events = ArrayList<HostChannelLost>()
        val settingsRead = runCatching { settingsStore.read() }
        val pinsRead = runCatching { pinStore.snapshot().associate { it.hostId to it.key.keyId } }
        val adopted = synchronized(lock) sync@{
            if (closed || !started) return@sync Reloaded(emptyList(), true, true)
            val pins = pinsRead.getOrNull()
            val fresh = settingsRead.getOrNull()

            settingsState = if (settingsRead.isSuccess) {
                StorageHandleState(available = true)
            } else {
                StorageHandleState(
                    available = false,
                    reason = (settingsRead.exceptionOrNull() as? StorageException)?.reason
                        ?: StorageFailureReason.UNAVAILABLE,
                )
            }
            trustState = if (pins != null) {
                StorageHandleState(available = true)
            } else {
                StorageHandleState(
                    available = false,
                    reason = (pinsRead.exceptionOrNull() as? StorageException)?.reason
                        ?: StorageFailureReason.UNAVAILABLE,
                )
            }
            trustUsable = pins != null

            // A preference adopted from storage is a new durable fact, and a
            // controller watching only the generation must see it move.
            if (fresh != null && fresh != settings) settingsGeneration += 1
            if (fresh != null) settings = fresh

            // Trust the registry cannot confirm is not a reason to keep sending.
            // Cached key ids are dropped so every guard refuses its next frame;
            // the next successful read republishes them.
            val owned = if (pins == null) {
                // Retirement marks each watcher already-reported so the later
                // socket-closure report stays silent. That is exactly why the
                // report has to be computed here, while the channels are still
                // attributed to a generation the coordinator can match.
                for (runtime in runtimes.values) {
                    events += lostEventsLocked(runtime, HostConnectionReason.TRUST_UNAVAILABLE)
                }
                retireAllLocked(HostConnectionReason.TRUST_UNAVAILABLE)
            } else {
                rebuildRuntimes(settings.hosts, pins, events)
            }
            notice = when {
                !settingsRead.isSuccess -> RegistryNotice(RegistryNoticeReason.SETTINGS_UNREADABLE, null)
                pins == null -> RegistryNotice(RegistryNoticeReason.TRUST_UNREADABLE, null)
                else -> null
            }
            publishLocked()
            Reloaded(owned, settingsRead.isSuccess, pins != null)
        }
        adopted.teardown.forEach { it.dispose() }
        // Owned channels are disposed before anyone is told about them, and the
        // report is delivered outside the registry lock so a coordinator is never
        // called while it would be impossible for it to act.
        val subscribers = listenerSnapshot()
        events.forEach { event -> subscribers.forEach { it.onChannelLost(event) } }
        return when {
            !adopted.settingsReadable -> HostCommandResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
            !adopted.trustReadable -> HostCommandResult.Refused(HostCommandRefusal.TRUST_UNAVAILABLE)
            else -> HostCommandResult.Accepted
        }
    }

    private data class Reloaded(
        val teardown: List<HostTransport>,
        val settingsReadable: Boolean,
        val trustReadable: Boolean,
    )

    // ---------------------------------------------------------------- commands

    /**
     * Save one new local association, without connecting or changing trust.
     *
     * Inputs are already validated value types. Connection history and Disconnect
     * suppression are always fresh; callers cannot inject either fact. The caller
     * supplies a fresh id, and the catalog refuses a duplicate or a full catalog.
     *
     * Unlike session history, a requested addition is not a fact until its write
     * succeeds. Stage, write, and adoption share the same transaction as internal
     * settings writers, but disk IO never holds the registry lock. Existing live
     * runtimes and eligibility are left intact, including facts arriving during
     * the write. No automatic attempt is scheduled, even with Auto enabled.
     */
    public fun addHost(freshHostId: HostId, label: HostLabel, endpoint: Endpoint): HostAddResult =
        synchronized(settingsTransaction) {
            val next = synchronized(lock) {
                if (closed || !started) return HostAddResult.Refused(HostCommandRefusal.NOT_RUNNING)
                if (!settingsState.available) {
                    return HostAddResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
                }
                when (val mutation = settings.addingHost(ConfiguredHost(freshHostId, label, endpoint))) {
                    is SettingsMutation.Ok -> mutation.settings
                    is SettingsMutation.Failed -> return HostAddResult.CatalogRefused(mutation.reason)
                }
            }
            val failure = runCatching { settingsStore.write(next) }.exceptionOrNull()
            synchronized(lock) {
                if (failure != null) {
                    settingsState = StorageHandleState(
                        available = false,
                        reason = (failure as? StorageException)?.reason ?: StorageFailureReason.WRITE_FAILED,
                    )
                    notice = RegistryNotice(RegistryNoticeReason.SETTINGS_WRITE_FAILED, null)
                    publishLocked()
                    return HostAddResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
                }
                settings = next
                settingsGeneration += 1
                val runtime = HostRuntime(freshHostId).apply {
                    this.endpoint = endpoint
                    this.label = label.value
                    configured = true
                }
                runtimes[freshHostId] = runtime
                eligibility = eligibility + (freshHostId to HostEligibility(runtime.epoch, endpoint, null))
                publishLocked()
            }
            HostAddResult.Saved
        }

    /**
     * Save a manually supplied address for one stable association; never connect.
     *
     * [expectedOldEndpoint] must be the exact saved target captured by the caller.
     * The port, label, catalog position, history, suppression, preferences, and
     * other hosts are preserved. Trust is untouched: the next explicit Connect
     * must prove the same exact remembered key at the new locator.
     *
     * Stage/write/adopt share the settings transaction with every other writer.
     * No registry lock is held across settings IO. Only a successful write adopts
     * the address, first retiring the old epoch, channels, attempts, timers, and
     * consents and removing foreground restoration eligibility. Automatic/resume
     * policy cannot infer a new connection from this edit: this runtime waits for
     * normal explicit Connect, which alone clears Disconnect suppression. Loss
     * events name the retired endpoint and generation; no input or work is replayed.
     */
    public fun updateHostAddress(
        hostId: HostId,
        expectedOldEndpoint: Endpoint,
        newAddress: HostAddress,
    ): HostAddressUpdateResult = synchronized(settingsTransaction) {
        val endpoint = Endpoint(newAddress.value, expectedOldEndpoint.port)
        val next = synchronized(lock) {
            if (closed || !started) return HostAddressUpdateResult.Refused(HostCommandRefusal.NOT_RUNNING)
            if (!settingsState.available) {
                return HostAddressUpdateResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
            }
            val saved = settings.findHost(hostId)
                ?: return HostAddressUpdateResult.Refused(HostCommandRefusal.UNKNOWN_HOST)
            if (hostId in removingHosts) {
                return HostAddressUpdateResult.Refused(HostCommandRefusal.ATTEMPT_IN_FLIGHT)
            }
            if (saved.endpoint != expectedOldEndpoint) return HostAddressUpdateResult.StaleTarget
            if (saved.endpoint == endpoint) return HostAddressUpdateResult.Unchanged
            when (val mutation = settings.updatingHost(hostId) { it.withEndpoint(endpoint) }) {
                is SettingsMutation.Ok -> mutation.settings
                is SettingsMutation.Failed -> return HostAddressUpdateResult.Refused(HostCommandRefusal.UNKNOWN_HOST)
            }
        }
        val failure = runCatching { settingsStore.write(next) }.exceptionOrNull()
        val events = ArrayList<HostChannelLost>()
        val owned = synchronized(lock) {
            if (failure != null) {
                settingsState = StorageHandleState(
                    available = false,
                    reason = (failure as? StorageException)?.reason ?: StorageFailureReason.WRITE_FAILED,
                )
                notice = RegistryNotice(RegistryNoticeReason.SETTINGS_WRITE_FAILED, hostId)
                publishLocked()
                return HostAddressUpdateResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
            }
            // A runtime may have connected or disconnected during the write.
            // Retire what is current now, not a staged runtime or history copy.
            val runtime = runtimes.getValue(hostId)
            events += lostEventsLocked(runtime, HostConnectionReason.CONNECTION_LOST)
            val teardown = retireLocked(runtime, HostConnectionReason.NONE)
            restoreCandidates.remove(hostId)
            runtime.explicitConnectRequired = true
            runtime.phase = HostConnectionPhase.DISCONNECTED
            runtime.endpoint = endpoint
            // Keep only the key already confirmed by trust storage. Neither
            // connection history nor the new locator can manufacture eligibility.
            publishEligibilityLocked(runtime)
            settings = next
            settingsGeneration += 1
            publishLocked()
            teardown
        }
        owned.forEach { it.dispose() }
        events.forEach { event -> listenerSnapshot().forEach { it.onChannelLost(event) } }
        HostAddressUpdateResult.Saved(endpoint)
    }

    /**
     * Explicit user Connect for one saved host.
     *
     * This is the only entry point that may initialize this device's identity,
     * and the only one that may pair. It overrides an automatic attempt still in
     * flight, and a second explicit request while one is running is refused
     * rather than interleaved: two pairings for one destination would race the
     * same confirmation.
     *
     * An explicit Connect also clears a manual Disconnect suppression, including
     * the in-memory failsafe that stands in when the save itself failed.
     */
    public fun connect(hostId: HostId): HostCommandResult {
        val prepared = synchronized(lock) sync@{
            if (closed || !started) return@sync Prepared.NOT_RUNNING
            val runtime = runtimes[hostId] ?: return@sync Prepared.UNKNOWN_HOST
            // A removal owns this destination end to end; a Connect that landed in
            // its middle would be orphaned by the removal completing.
            if (hostId in removingHosts) return@sync Prepared.IN_FLIGHT
            if (runtime.phase == HostConnectionPhase.CONNECTED) return@sync Prepared.ALREADY
            // Only another explicit attempt is refused. An automatic or resume
            // dial is this same user's connection, and an explicit Connect
            // outranks it: it is retired and disposed here, never raced against.
            val superseded = when (runtime.mode) {
                AttemptMode.EXPLICIT -> return@sync Prepared.IN_FLIGHT
                AttemptMode.AUTO, AttemptMode.RESUME -> retireLocked(runtime, HostConnectionReason.CONNECTING)
                null -> emptyList()
            }
            // An explicit Connect re-arms the destination and outranks any
            // pending automatic attempt, which is cancelled rather than raced.
            runtime.retryJob?.cancel()
            runtime.retryJob = null
            runtime.autoAttempts = 0
            runtime.explicitConnectRequired = false
            // One epoch move, published: the send guard this attempt installs
            // must read the same epoch the snapshot reports.
            retireLocked(runtime, HostConnectionReason.CONNECTING)
            runtime.mode = AttemptMode.EXPLICIT
            runtime.phase = HostConnectionPhase.CONNECTING
            runtime.reason = HostConnectionReason.CONNECTING
            publishLocked()
            Prepared.Ready(planFor(runtime, AttemptMode.EXPLICIT), superseded)
        }
        when (prepared) {
            Prepared.NOT_RUNNING -> return HostCommandResult.Refused(HostCommandRefusal.NOT_RUNNING)
            Prepared.UNKNOWN_HOST -> return HostCommandResult.Refused(HostCommandRefusal.UNKNOWN_HOST)
            Prepared.IN_FLIGHT -> return HostCommandResult.Refused(HostCommandRefusal.ATTEMPT_IN_FLIGHT)
            Prepared.ALREADY -> {
                if (suppressedLocked(hostId)) clearSuppression(hostId)
                return HostCommandResult.Accepted
            }
            is Prepared.Ready -> Unit
        }
        val plan = prepared.plan ?: return HostCommandResult.Accepted
        // The superseded dial's transport belongs to the destination, not to the
        // attempt that made it, so it is disposed here — after the lock, before
        // the new dial starts, and never by the retired coroutine itself.
        prepared.teardown.forEach { it.dispose() }
        // The suppression copy is durable IO, so it happens outside the lock, and
        // only when there is a suppression to clear.
        if (synchronized(lock) { suppressedLocked(hostId) }) clearSuppression(hostId)
        launchAttempt(plan)
        return HostCommandResult.Accepted
    }

    /**
     * Explicit user Disconnect.
     *
     * Association, remembered key, and connection history all survive: only
     * automatic attempts are suppressed, and only until an explicit Connect. The
     * suppression is persisted; when the save fails, an in-memory override keeps
     * this session truthful and the snapshot reports the failed save instead of
     * pretending the preference landed.
     */
    public fun disconnect(hostId: HostId): HostCommandResult {
        val events = ArrayList<HostChannelLost>()
        val prepared = synchronized(lock) sync@{
            if (closed || !started) return@sync Prepared.NOT_RUNNING
            val runtime = runtimes[hostId] ?: return@sync Prepared.UNKNOWN_HOST
            suppressionOverride += hostId
            events += lostEventsLocked(runtime, HostConnectionReason.NONE)
            val owned = retireLocked(runtime, HostConnectionReason.NONE)
            runtime.phase = HostConnectionPhase.DISCONNECTED
            publishLocked()
            Prepared.Ready(null, owned)
        }
        when {
            prepared === Prepared.NOT_RUNNING -> return HostCommandResult.Refused(HostCommandRefusal.NOT_RUNNING)
            prepared === Prepared.UNKNOWN_HOST -> return HostCommandResult.Refused(HostCommandRefusal.UNKNOWN_HOST)
            else -> Unit
        }
        (prepared as Prepared.Ready).teardown.forEach { it.dispose() }
        events.forEach { event -> listenerSnapshot().forEach { it.onChannelLost(event) } }

        val saved = updateSettings { it.updatingHost(hostId) { host -> host.withReconnectSuppressed(true) } }
        synchronized(lock) sync@{
            if (saved) {
                suppressionOverride -= hostId
            } else {
                notice = RegistryNotice(RegistryNoticeReason.SUPPRESSION_NOT_PERSISTED, hostId)
            }
            publishLocked()
        }
        return HostCommandResult.Accepted
    }

    /**
     * Forget one saved host.
     *
     * This is local only: it drops this side's remembered key and this side's
     * association, and it never revokes the other host's receiving grant, stops
     * any of its sessions, or sends anything at all. A key that could not be
     * cleared is reported as such — the snapshot never claims a forgotten pin
     * when trust storage refused.
     *
     * Removal fences its whole lifetime. It cannot hold the registry lock across
     * the key clear and the document write, so it marks the destination as being
     * removed for the duration: Connect is refused, and neither an automatic nor a
     * resume dial may start. Without that fence a Connect landing in the gap would
     * re-dial with a key that has not been cleared yet, and the removal would then
     * delete the runtime without disposing that replacement's transport, leaving a
     * live connection nothing can later reach. A second concurrent removal of the
     * same host is refused rather than interleaved.
     */
    public fun remove(hostId: HostId): HostCommandResult {
        val events = ArrayList<HostChannelLost>()
        val prepared = synchronized(lock) sync@{
            if (closed || !started) return@sync Prepared.NOT_RUNNING
            val runtime = runtimes[hostId] ?: return@sync Prepared.UNKNOWN_HOST
            // One removal per destination, and it owns the whole lifetime.
            if (!removingHosts.add(hostId)) return@sync Prepared.IN_FLIGHT
            consents.values.filter { it.hostId == hostId }.toList().forEach { entry ->
                consents.remove(entry.consentId)
                entry.decision.complete(PeerKeyDecision.CANCEL)
            }
            events += lostEventsLocked(runtime, HostConnectionReason.NONE)
            val owned = retireLocked(runtime, HostConnectionReason.NONE)
            runtime.phase = HostConnectionPhase.DISCONNECTED
            publishLocked()
            Prepared.Ready(null, owned)
        }
        when {
            prepared === Prepared.NOT_RUNNING -> return HostCommandResult.Refused(HostCommandRefusal.NOT_RUNNING)
            prepared === Prepared.UNKNOWN_HOST -> return HostCommandResult.Refused(HostCommandRefusal.UNKNOWN_HOST)
            prepared === Prepared.IN_FLIGHT -> return HostCommandResult.Refused(HostCommandRefusal.ATTEMPT_IN_FLIGHT)
            else -> Unit
        }
        (prepared as Prepared.Ready).teardown.forEach { it.dispose() }
        events.forEach { event -> listenerSnapshot().forEach { it.onChannelLost(event) } }

        var pinNotCleared = false
        val cleared = runCatching { pinStore.clear(hostId) }
        when {
            cleared.isFailure -> pinNotCleared = true
            cleared.getOrThrow() is PinClearResult.Refused -> pinNotCleared = true
            else -> dropRemembered(hostId)
        }

        val removed = updateSettings { it.removingHost(hostId) }
        synchronized(lock) sync@{
            // The fence lifts only once the durable work is over, so nothing was
            // admitted into the gap at any point.
            removingHosts -= hostId
            if (removed) {
                runtimes.remove(hostId)
                // No published eligibility may outlive the association it describes:
                // a send guard reading it would otherwise keep admitting frames for
                // a host this device no longer has.
                eligibility = eligibility - hostId
                suppressionOverride -= hostId
                restoreCandidates.remove(hostId)
            }
            notice = when {
                pinNotCleared -> RegistryNotice(RegistryNoticeReason.PIN_NOT_CLEARED, hostId)
                !removed -> RegistryNotice(RegistryNoticeReason.HOST_NOT_REMOVED, hostId)
                else -> null
            }
            publishLocked()
        }
        return if (removed) {
            HostCommandResult.Accepted
        } else {
            HostCommandResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
        }
    }

    /**
     * Copy the automatic-reconnect preference.
     *
     * Turning it off cancels scheduled and in-flight automatic attempts for
     * every host; a healthy connected session is never dropped by a preference
     * change. Turning it on schedules the hosts that are eligible now. The
     * published [ConnectionRegistrySnapshot.settingsGeneration] moves either way,
     * which is how a controller invalidates its own view of the switch.
     */
    public fun setAutoReconnect(enabled: Boolean): HostCommandResult {
        val saved = updatePreference { it.withAutoReconnect(enabled) }
        if (enabled) {
            val eligible = synchronized(lock) sync@{
                val ids = ArrayList<HostId>()
                for (runtime in runtimes.values) if (autoEligibleLocked(runtime)) ids += runtime.id
                ids
            }
            // Turning the preference on is itself a request to be connected, so
            // these dial now; only the retries that follow wait out the backoff.
            eligible.forEach { scheduleRetry(it, immediate = true) }
        } else {
            val teardown = synchronized(lock) sync@{
                // Only the attempts this switch is about are torn down. A host
                // that is happily connected stays connected: a preference change
                // never drops somebody's session.
                val owned = ArrayList<HostTransport>()
                for (runtime in runtimes.values) {
                    runtime.retryJob?.cancel()
                    runtime.retryJob = null
                    if (runtime.phase == HostConnectionPhase.RETRYING) {
                        runtime.phase = HostConnectionPhase.DISCONNECTED
                        runtime.reason = HostConnectionReason.NONE
                    }
                    if (runtime.mode == AttemptMode.AUTO) owned += retireLocked(runtime, HostConnectionReason.NONE)
                }
                publishLocked()
                owned
            }
            teardown.forEach { it.dispose() }
        }
        return if (saved) {
            HostCommandResult.Accepted
        } else {
            HostCommandResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
        }
    }

    /** Copy this viewer's remote native input/copy preference. Nothing else moves. */
    public fun setViewerRemoteInputEnabled(enabled: Boolean): HostCommandResult {
        val saved = updatePreference { it.withViewerRemoteInputEnabled(enabled) }
        return if (saved) {
            HostCommandResult.Accepted
        } else {
            HostCommandResult.Refused(HostCommandRefusal.SETTINGS_UNAVAILABLE)
        }
    }

    // ------------------------------------------------------------- foreground

    /**
     * Move the app between foreground and background.
     *
     * `false` closes every connection this client owns. Admission epochs move
     * synchronously and first, so a frame in flight is dropped rather than
     * written even before its transport is gone; then attempts, timers, and
     * pending confirmations are cancelled and every owned transport is disposed.
     * The far side's sessions keep running: nothing here asks an owner to close,
     * create, or cancel anything, and no accepted owner work is claimed.
     *
     * `true` dials fresh. Only hosts that were active, are still saved, are not
     * suppressed, and already have a remembered key are attempted, and only with
     * that key. A resume is one attempt per host even when automatic reconnect is
     * off, because returning to the app is itself the user's request to be
     * connected again; a failed resume does not become a loop unless the
     * automatic preference is on and the host is eligible. If startup happened
     * in the background with saved Auto on, the first foreground also consumes
     * that one deferred startup opportunity using automatic eligibility.
     *
     * [continuationCandidates] exists for process recreation, where no in-memory
     * active set survived. It is a candidate list, never a command: ids that are
     * not saved, not suppressed, and not keyed are ignored, so it can never turn
     * into a startup connection storm across the whole catalog. Nothing about a
     * channel, an operation, or a wire state is persisted to make this work.
     */
    public fun setForeground(foreground: Boolean, continuationCandidates: List<HostId> = emptyList()) {
        if (foreground) enterForeground(continuationCandidates) else leaveForeground()
    }

    /** Background: close every connection this client owns. */
    public fun leaveForeground() {
        val events = ArrayList<HostChannelLost>()
        val teardown = synchronized(lock) sync@{
            if (closed || !foreground) return@sync emptyList()
            foreground = false
            foregroundEpoch += 1
            // Epochs move first, and synchronously: from this instant every send
            // guard and every late callback is refused, before any teardown.
            restoreCandidates.clear()
            val owned = ArrayList<HostTransport>()
            for (runtime in runtimes.values) {
                if (runtime.phase == HostConnectionPhase.CONNECTED ||
                    runtime.phase == HostConnectionPhase.CONNECTING ||
                    runtime.phase == HostConnectionPhase.PAIRING ||
                    runtime.phase == HostConnectionPhase.RETRYING
                ) {
                    restoreCandidates += runtime.id
                }
                events += lostEventsLocked(runtime, HostConnectionReason.BACKGROUND)
                owned += retireLocked(runtime, HostConnectionReason.BACKGROUND)
                runtime.phase = HostConnectionPhase.DISCONNECTED
            }
            for (entry in consents.values.toList()) {
                consents.remove(entry.consentId)
                entry.decision.complete(PeerKeyDecision.CANCEL)
            }
            publishLocked()
            owned
        }
        teardown.forEach { it.dispose() }
        events.forEach { event -> listenerSnapshot().forEach { it.onChannelLost(event) } }
    }

    /** Foreground: restore active hosts and any deferred saved-Auto startup. */
    public fun enterForeground(continuationCandidates: List<HostId> = emptyList()) {
        val toDial = ArrayList<AttemptPlan>()
        val toSchedule = ArrayList<HostId>()
        synchronized(lock) sync@{
            if (closed) return@sync
            val candidates = when {
                restoreCandidates.isNotEmpty() -> restoreCandidates.toList()
                continuationCandidates.isNotEmpty() -> continuationCandidates
                else -> emptyList()
            }
            restoreCandidates.clear()
            foreground = true
            foregroundEpoch += 1
            for (hostId in candidates) {
                if (hostId in removingHosts) continue
                val runtime = runtimes[hostId] ?: continue
                if (runtime.explicitConnectRequired) continue
                val saved = settings.findHost(hostId) ?: continue
                if (saved.reconnectSuppressed || hostId in suppressionOverride) continue
                if (runtime.mode != null || runtime.phase == HostConnectionPhase.CONNECTED) continue
                if (eligibility[hostId]?.keyId == null) continue
                if (identityObservation !is DeviceIdentityObservation.Ready) continue
                runtime.epoch += 1
                publishEligibilityLocked(runtime)
                runtime.mode = AttemptMode.RESUME
                runtime.phase = HostConnectionPhase.CONNECTING
                runtime.reason = HostConnectionReason.CONNECTING
                toDial += planFor(runtime, AttemptMode.RESUME)
            }
            if (startupAutoPending) {
                startupAutoPending = false
                for (runtime in runtimes.values) if (autoEligibleLocked(runtime)) toSchedule += runtime.id
            }
            publishLocked()
        }
        toDial.forEach { launchAttempt(it) }
        toSchedule.forEach { scheduleRetry(it, immediate = true) }
    }

    // --------------------------------------------------------------- consents

    /**
     * Deliver the operator's answer to one latched key confirmation.
     *
     * Both answers take the same path, and both are refused for exactly the same
     * reasons: backgrounded, a different foreground UI, a superseded attempt, a
     * host that is gone or re-pointed, an expired window, a key that is already
     * remembered, or — the one only the UI can answer — a prompt the committed
     * foreground frame no longer presents. Checking the proof costs four
     * comparisons and no IO; checking the committed frame costs one atomic read of
     * the adapter's own state.
     *
     * So a click from a dismissed screen, a callback replayed after the dialog was
     * replaced, and a decision assembled from a snapshot nobody rendered are all
     * refusals. A stale click can never connect, and is never mistaken for a
     * decision that was honoured.
     */
    public fun decideKeyConsent(
        choice: HostKeyConsentChoice,
        proof: HostKeyConsentProof,
    ): HostKeyConsentResolution {
        val gate: ConsentGate = synchronized(lock) sync@{
            val pending = consents[proof.consentId]
                ?: return@sync ConsentGate.Denied(HostKeyConsentStaleReason.UNKNOWN_CONSENT)
            val refusal = when {
                proof.hostId != pending.hostId ||
                    proof.generation != pending.generation ||
                    proof.foregroundEpoch != pending.record.foregroundEpoch ->
                    HostKeyConsentStaleReason.PROOF_MISMATCH
                !foreground -> HostKeyConsentStaleReason.NOT_IN_FOREGROUND
                proof.foregroundEpoch != foregroundEpoch -> HostKeyConsentStaleReason.FOREGROUND_EPOCH_CHANGED
                pending.record.expiresAtMonoMs <= monotonicNowMs() -> HostKeyConsentStaleReason.EXPIRED
                else -> {
                    val runtime = runtimes[pending.hostId]
                    val saved = settings.findHost(pending.hostId)
                    when {
                        runtime == null || saved == null ||
                            runtime.epoch != pending.generation ||
                            runtime.mode != AttemptMode.EXPLICIT -> HostKeyConsentStaleReason.ATTEMPT_SUPERSEDED
                        saved.endpoint != pending.record.endpoint -> HostKeyConsentStaleReason.TARGET_NOT_CURRENT
                        eligibility[pending.hostId]?.keyId != null -> HostKeyConsentStaleReason.PIN_STATE_CHANGED
                        else -> null
                    }
                }
            }
            if (refusal != null) return@sync ConsentGate.Denied(refusal)
            ConsentGate.Presenting(pending.record)
        }
        if (gate is ConsentGate.Denied) return HostKeyConsentResolution.Stale(gate.reason)
        val committed = (gate as ConsentGate.Presenting).record

        // The latched record proves the decision matches an offer the registry
        // made. It cannot prove a person was shown that offer: only the committed
        // foreground frame can. This runs outside the registry monitor — it is a
        // foreign callback — and the record it is asked about is immutable, so the
        // re-check below still owns the outcome.
        if (!promptValidator.isCommitted(committed)) {
            return HostKeyConsentResolution.Stale(HostKeyConsentStaleReason.UI_NOT_COMMITTED)
        }

        val settled: ConsentSettlement = synchronized(lock) sync@{
            // Nothing may have replaced or withdrawn the prompt while the UI was
            // being asked; the same record must still be the live one.
            val still = consents[proof.consentId]
            if (still == null || still.record !== committed) {
                return@sync ConsentSettlement.Denied(HostKeyConsentStaleReason.UNKNOWN_CONSENT)
            }
            val lateRefusal = when {
                !foreground -> HostKeyConsentStaleReason.NOT_IN_FOREGROUND
                proof.foregroundEpoch != foregroundEpoch -> HostKeyConsentStaleReason.FOREGROUND_EPOCH_CHANGED
                committed.expiresAtMonoMs <= monotonicNowMs() -> HostKeyConsentStaleReason.EXPIRED
                else -> null
            }
            if (lateRefusal != null) return@sync ConsentSettlement.Denied(lateRefusal)
            consents.remove(still.consentId)
            publishLocked()
            ConsentSettlement.Take(still.decision)
        }
        if (settled is ConsentSettlement.Denied) {
            return HostKeyConsentResolution.Stale(settled.reason)
        }
        // The decision crosses to the waiting pairing only after the lock is
        // released, so no pairing callback ever runs inside a registry monitor.
        (settled as ConsentSettlement.Take).decision.complete(
            if (choice == HostKeyConsentChoice.APPROVE) PeerKeyDecision.ACCEPT else PeerKeyDecision.REJECT,
        )
        return HostKeyConsentResolution.Applied(choice)
    }

    // ------------------------------------------------------------ content lane

    /**
     * Open the content lane on one already-connected host.
     *
     * This is the deliberate-selection entry point. It refuses unless the host is
     * currently connected in the foreground, so a content channel can never be
     * opened against a host the user is not looking at, and it shares that host's
     * own transport rather than dialing a second connection. Lifecycle stays
     * here — background, loss, and removal all close it — while the channel's one
     * reader belongs to the caller.
     */
    public suspend fun openContentChannel(hostId: HostId): HostContentChannelResult {
        val staged = synchronized(lock) sync@{
            if (closed) return@sync null
            val runtime = runtimes[hostId]
                ?: return@sync StagedContent.refused(HostCommandRefusal.UNKNOWN_HOST)
            if (runtime.phase != HostConnectionPhase.CONNECTED || runtime.appChannel == null) {
                return@sync StagedContent.refused(HostCommandRefusal.NOT_CONNECTED, runtime.reason)
            }
            if (!foreground) {
                return@sync StagedContent.refused(HostCommandRefusal.NOT_CONNECTED, HostConnectionReason.BACKGROUND)
            }
            val transport = runtime.transport
                ?: return@sync StagedContent.refused(HostCommandRefusal.NOT_CONNECTED, runtime.reason)
            StagedContent.ready(transport, planFor(runtime, AttemptMode.RESUME), sendGuard(planFor(runtime, AttemptMode.RESUME)))
        }
        if (staged == null) return HostContentChannelResult.Refused(HostCommandRefusal.NOT_RUNNING)
        if (staged.refusal != null) {
            return HostContentChannelResult.Refused(staged.refusal, staged.connectionReason)
        }

        val identity = try {
            DevicePeerIdentity(currentIdentityHandle())
        } catch (_: RegistryIdentityException) {
            return HostContentChannelResult.Refused(
                HostCommandRefusal.NOT_CONNECTED,
                HostConnectionReason.IDENTITY_UNAVAILABLE,
            )
        }

        val plan = staged.plan!!
        val channel = try {
            staged.transport!!.open(
                endpoint = PeerEndpoint(plan.endpoint.host, plan.endpoint.port),
                lane = PeerAppLane.CONTENT,
                identity = identity,
                trust = trustSource(plan),
                admission = connectedGate(plan),
                sendGuard = staged.guard!!,
            )
        } catch (failure: PeerTransportException) {
            return HostContentChannelResult.Refused(HostCommandRefusal.NOT_CONNECTED, reasonForTransport(failure.code))
        } catch (_: Throwable) {
            return HostContentChannelResult.Refused(HostCommandRefusal.NOT_CONNECTED)
        }

        val accepted = synchronized(lock) sync@{
            val runtime = runtimes[hostId]
            if (runtime == null || runtime.epoch != plan.epoch || !foreground || runtime.transport !== staged.transport) {
                null
            } else {
                runtime.contentChannels += channel
                publishLocked()
                HostContentChannel(
                    hostId = hostId,
                    endpoint = plan.endpoint,
                    generation = plan.epoch,
                    peerFingerprint = channel.peerKey.fingerprint,
                    channel = channel,
                )
            }
        }
        if (accepted == null) {
            runCatching { channel.close() }
            return HostContentChannelResult.Refused(
                HostCommandRefusal.NOT_CONNECTED,
                HostConnectionReason.BACKGROUND,
            )
        }
        // A content lane is opened and closed many times over one long-lived
        // connection, so its reference cannot be kept until the whole host
        // retires: a closed channel still holds its TLS connection and any
        // inbound buffers nobody is draining. Await the closure — never reading
        // the channel, which belongs to the coordinator — and drop only this
        // generation's reference. An old closure that lands after the host was
        // re-armed finds a different epoch and leaves the replacement alone.
        scope.launch {
            try {
                channel.closed.await()
            } finally {
                synchronized(lock) {
                    val current = runtimes[hostId]
                    if (current != null && current.epoch == plan.epoch) {
                        current.contentChannels.remove(channel)
                    }
                }
            }
        }
        listenerSnapshot().forEach { it.onContentChannelAvailable(accepted) }
        return HostContentChannelResult.Opened(accepted)
    }

    // ------------------------------------------------------------------- close

    /** Retire every connection and stop scheduling. Idempotent. */
    public fun close() {
        val teardown = synchronized(lock) sync@{
            if (closed) return@sync emptyList()
            closed = true
            val owned = ArrayList<HostTransport>()
            for (runtime in runtimes.values) owned += retireLocked(runtime, null)
            for (entry in consents.values.toList()) entry.decision.complete(PeerKeyDecision.CANCEL)
            consents.clear()
            publishLocked()
            owned
        }
        teardown.forEach { it.dispose() }
        scope.cancel()
    }

    // --------------------------------------------------------------- listeners

    /**
     * Subscribe to channel handoffs. Listeners receive channels, never sockets,
     * credentials, or trust decisions — and a UI should never be a listener: it
     * observes [snapshot] instead.
     */
    public fun addListener(listener: HostConnectionListener) {
        synchronized(lock) { if (!listeners.contains(listener)) listeners += listener }
    }

    /** Unsubscribe. A listener that is still reading a channel keeps that channel. */
    public fun removeListener(listener: HostConnectionListener) {
        synchronized(lock) { listeners -= listener }
    }

    /**
     * A stable copy of the current listeners, taken under the same lock that
     * registration mutates.
     *
     * Copying the mutable list without the lock is not safe: a concurrent
     * unregistration can empty an element while the copy is walking the old size,
     * and the resulting null entry throws mid-delivery. In the application
     * handoff that throw lands in the failure path after the channel was already
     * marked connected, which would report a live connection as disconnected and
     * leave it unwatched. Callbacks are still invoked outside the lock, so a
     * coordinator is never called reentrantly.
     */
    private fun listenerSnapshot(): List<HostConnectionListener> = synchronized(lock) { listeners.toList() }

    // --------------------------------------------------------------- internals

    private enum class AttemptMode { EXPLICIT, AUTO, RESUME }

    /** One prepared command: what to attempt, and what the caller must dispose. */
    private sealed interface Prepared {
        data object NOT_RUNNING : Prepared
        data object UNKNOWN_HOST : Prepared
        data object ALREADY : Prepared
        data object IN_FLIGHT : Prepared
        data class Ready(
            val plan: AttemptPlan? = null,
            val teardown: List<HostTransport> = emptyList(),
        ) : Prepared
    }

    private class StagedContent(
        val transport: HostTransport?,
        val plan: AttemptPlan?,
        val guard: PeerSendGuard?,
        val refusal: HostCommandRefusal?,
        val connectionReason: HostConnectionReason,
    ) {
        companion object {
            fun ready(transport: HostTransport, plan: AttemptPlan, guard: PeerSendGuard) =
                StagedContent(transport, plan, guard, null, HostConnectionReason.NONE)

            fun refused(reason: HostCommandRefusal, connection: HostConnectionReason = HostConnectionReason.NONE) =
                StagedContent(null, null, null, reason, connection)
        }
    }

    private class AttemptWatch {
        @Volatile
        var reported: Boolean = false
    }

    private inner class HostRuntime(val id: HostId) {
        var endpoint: Endpoint = LOOPBACK_PLACEHOLDER
        var label: String = ""
        /** False until a saved catalog has actually described this destination. */
        var configured: Boolean = false
        var epoch: Long = 0L
        var phase: HostConnectionPhase = HostConnectionPhase.NEVER
        var reason: HostConnectionReason = HostConnectionReason.NONE
        var mode: AttemptMode? = null
        var autoAttempts: Int = 0
        /** An address save withdraws policy continuation until a fresh explicit Connect. */
        var explicitConnectRequired: Boolean = false
        var attemptJob: Job? = null
        var retryJob: Job? = null
        var transport: HostTransport? = null
        var appChannel: PeerByteChannel? = null
        val contentChannels = ArrayList<PeerByteChannel>()
        var peerFingerprint: String? = null
        var watch: AttemptWatch? = null
    }

    private data class AttemptPlan(
        val hostId: HostId,
        val epoch: Long,
        val endpoint: Endpoint,
        val label: String,
        val mode: AttemptMode,
    )

    private class PendingConsent(
        val consentId: Long,
        val hostId: HostId,
        val generation: Long,
        val record: HostKeyConsent,
        val decision: CompletableDeferred<PeerKeyDecision>,
    )

    private companion object {
        val LOOPBACK_PLACEHOLDER: Endpoint = Endpoint("127.0.0.1", 1)

        val BLANK = ConnectionRegistrySnapshot(
            generation = 0L,
            settingsGeneration = 0L,
            foreground = true,
            autoReconnectEnabled = NetworkSettings.DEFAULT_AUTO_RECONNECT,
            viewerRemoteInputEnabled = NetworkSettings.DEFAULT_VIEWER_REMOTE_INPUT_ENABLED,
            identity = DeviceIdentityObservation.NeverInitialized,
            storage = StorageObservation(StorageHandleState(false), StorageHandleState(false)),
            hosts = emptyList(),
            pendingConsents = emptyList(),
            notice = null,
        )

        fun monotonicNowMs(): Long = System.nanoTime() / 1_000_000L
    }

    /** Build the immutable snapshot. Always called with the lock held. */
    private fun publishLocked() {
        snapshotGeneration += 1
        val current = settings
        _snapshot.value = ConnectionRegistrySnapshot(
            generation = snapshotGeneration,
            settingsGeneration = settingsGeneration,
            foreground = foreground,
            autoReconnectEnabled = current.autoReconnect,
            // An unreadable document is never treated as "on".
            viewerRemoteInputEnabled = settingsState.available && current.viewerRemoteInputEnabled,
            identity = identityObservation,
            storage = StorageObservation(settingsState, trustState),
            hosts = runtimes.values.map { runtime ->
                val saved = current.findHost(runtime.id)
                HostConnectionSnapshot(
                    hostId = runtime.id,
                    endpoint = saved?.endpoint ?: runtime.endpoint,
                    label = saved?.label?.value ?: runtime.label,
                    phase = runtime.phase,
                    reason = runtime.reason,
                    generation = runtime.epoch,
                    previouslyConnected = saved?.previouslyConnected ?: false,
                    reconnectSuppressed = (saved?.reconnectSuppressed ?: false) || runtime.id in suppressionOverride,
                    // The finite schedule is part of eligibility: once its bounded
                    // waits are used up only an explicit Connect restarts the host.
                    autoEligible = autoEligibleLocked(runtime) &&
                        runtime.autoAttempts < policy.autoReconnectDelaysMs.size,
                    peerFingerprint = runtime.peerFingerprint,
                )
            },
            pendingConsents = consents.values.map { it.record },
            notice = notice,
        )
    }

    /**
     * Adopt one saved catalog.
     *
     * A host that is still saved at the same endpoint keeps its runtime, its
     * epoch, and its live transport untouched, so reloading after another screen
     * edited the catalog never disturbs a connection in progress. Only a host
     * that left the catalog, or moved to another endpoint, is retired: a live
     * channel to the old address is no longer the association the user saved.
     */
    /**
     * Retire every destination and revoke every published key.
     *
     * Used when trust storage stopped being confirmable. Connections to a peer
     * this side can no longer verify are closed rather than kept, and no frame
     * is admitted against a key the registry has just reported as unreadable.
     */
    private fun retireAllLocked(reason: HostConnectionReason): List<HostTransport> {
        val owned = ArrayList<HostTransport>()
        val cleared = eligibility.entries.associate { (id, value) -> id to value.copy(keyId = null) }
        eligibility = cleared
        for (runtime in runtimes.values) {
            owned += retireLocked(runtime, reason)
            if (runtime.phase != HostConnectionPhase.ERROR) {
                runtime.phase = HostConnectionPhase.DISCONNECTED
            }
        }
        return owned
    }

    /**
     * Adopt a saved catalog, tearing down only what genuinely changed.
     *
     * [events] is optional because startup has nothing handed off to report yet.
     * When a reload supplies it, each retirement contributes its loss report
     * before [retireLocked] clears the watcher: once that watcher is marked
     * reported, the eventual socket closure stays silent forever, and a
     * coordinator holding a channel for a host that disappeared or moved would
     * never be told to drop it.
     */
    private fun rebuildRuntimes(
        catalog: HostCatalog,
        keys: Map<HostId, String>,
        events: MutableList<HostChannelLost>? = null,
    ): List<HostTransport> {
        val saved = catalog.hosts
        val nextEligibility = HashMap<HostId, HostEligibility>()
        val teardown = ArrayList<HostTransport>()
        for (host in saved) {
            val runtime = runtimes.getOrPut(host.id) { HostRuntime(host.id) }
            if (runtime.configured && runtime.endpoint != host.endpoint) {
                events?.addAll(lostEventsLocked(runtime, HostConnectionReason.CONNECTION_LOST))
                teardown += retireLocked(runtime, HostConnectionReason.CONNECTION_LOST)
                runtime.phase = HostConnectionPhase.DISCONNECTED
            }
            runtime.endpoint = host.endpoint
            runtime.label = host.label.value
            runtime.configured = true
            nextEligibility[host.id] = HostEligibility(runtime.epoch, host.endpoint, keys[host.id])
        }
        val keep = saved.mapTo(HashSet()) { it.id }
        for (id in runtimes.keys.toList()) {
            if (id in keep) continue
            events?.addAll(lostEventsLocked(runtimes.getValue(id), HostConnectionReason.CONNECTION_LOST))
            teardown += retireLocked(runtimes.getValue(id), null)
            runtimes.remove(id)
        }
        eligibility = nextEligibility
        return teardown
    }

    private fun dropRemembered(hostId: HostId) {
        synchronized(lock) sync@{
            val current = eligibility[hostId] ?: return@sync
            eligibility = eligibility + (hostId to current.copy(keyId = null))
            publishLocked()
        }
    }

    private fun planFor(runtime: HostRuntime, mode: AttemptMode): AttemptPlan = AttemptPlan(
        hostId = runtime.id,
        epoch = runtime.epoch,
        endpoint = runtime.endpoint,
        label = runtime.label,
        mode = mode,
    )

    /** Everything the caller must dispose, collected while the lock is held. */
    /**
     * Retire one destination: invalidate its epoch, drop its channels, and hand
     * back the transport its caller must dispose. No other destination is
     * touched — that is the whole point of one transport per host.
     */
    private fun retireLocked(runtime: HostRuntime, reason: HostConnectionReason?): List<HostTransport> {
        runtime.epoch += 1
        runtime.watch?.reported = true
        runtime.watch = null
        runtime.mode = null
        runtime.attemptJob?.cancel()
        runtime.attemptJob = null
        runtime.retryJob?.cancel()
        runtime.retryJob = null
        runtime.appChannel = null
        runtime.contentChannels.clear()
        runtime.peerFingerprint = null
        cancelConsentsLocked(runtime.id)
        if (reason != null) runtime.reason = reason
        publishEligibilityLocked(runtime)
        val owned = runtime.transport
        runtime.transport = null
        return if (owned != null) listOf(owned) else emptyList()
    }

    /**
     * Drop and cancel every confirmation belonging to one destination.
     *
     * A prompt is an offer about a live attempt. Once that attempt is retired —
     * by a disconnect, a removal, a background, or an explicit Connect re-arming
     * the host — the offer is withdrawn. Leaving it latched would both keep a
     * dead prompt on screen and block the next explicit Connect from asking
     * again, because only one confirmation per host may exist at a time.
     *
     * The waiting pairing resumes on its own dispatcher, never inline here, so no
     * attempt code runs while the registry monitor is held.
     */
    private fun cancelConsentsLocked(hostId: HostId) {
        if (consents.values.none { it.hostId == hostId }) return
        consents.values.filter { it.hostId == hostId }.toList().forEach { entry ->
            consents.remove(entry.consentId)
            entry.decision.complete(PeerKeyDecision.CANCEL)
        }
    }

    private fun publishEligibilityLocked(runtime: HostRuntime) {
        eligibility = eligibility + (
            runtime.id to HostEligibility(
                runtime.epoch,
                runtime.endpoint,
                eligibility[runtime.id]?.keyId,
            )
            )
    }

    /** The loss reports for one destination, computed before its epoch moves. */
    private fun lostEventsLocked(runtime: HostRuntime, reason: HostConnectionReason): List<HostChannelLost> {
        if (runtime.appChannel == null && runtime.contentChannels.isEmpty()) return emptyList()
        return listOf(HostChannelLost(runtime.id, runtime.endpoint, runtime.epoch, reason, stale = false))
    }

    // --------------------------------------------------------------- attempts

    private fun launchAttempt(plan: AttemptPlan) {
        val job = scope.launch(start = CoroutineStart.LAZY) { runAttempt(plan) }
        val go = synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync false
            if (runtime.epoch != plan.epoch || runtime.mode != plan.mode) return@sync false
            runtime.attemptJob = job
            runtime.watch = AttemptWatch()
            true
        }
        if (go) job.start() else job.cancel()
    }

    private suspend fun runAttempt(plan: AttemptPlan) {
        var transport: HostTransport? = null
        var connected = false
        try {
            if (!networkAccess.allows(plan.endpoint)) {
                failAttempt(plan, HostConnectionReason.LOCAL_NETWORK_UNAVAILABLE)
                return
            }

            val identity = try {
                if (plan.mode == AttemptMode.EXPLICIT) ensureIdentityForExplicit() else currentIdentity()
            } catch (_: RegistryIdentityException) {
                failAttempt(plan, HostConnectionReason.IDENTITY_UNAVAILABLE)
                return
            }
            publishIdentityObservation()

            if (plan.mode != AttemptMode.EXPLICIT && eligibility[plan.hostId]?.keyId == null) {
                // Automatic recovery never prompts and never pairs.
                stopAttempt(plan)
                return
            }

            val created = transportFactory.create(
                PeerEndpoint(plan.endpoint.host, plan.endpoint.port),
                humanFlowTransportBounds(policy),
            )
            transport = created
            val owned = synchronized(lock) sync@{
                val runtime = runtimes[plan.hostId] ?: return@sync false
                if (runtime.epoch != plan.epoch || runtime.mode != plan.mode) return@sync false
                runtime.transport = created
                true
            }
            if (!owned) {
                created.dispose()
                return
            }

            if (plan.mode == AttemptMode.EXPLICIT) {
                if (!markPairing(plan)) return
                val pairing = created.pair(
                    endpoint = PeerEndpoint(plan.endpoint.host, plan.endpoint.port),
                    identity = identity,
                    trust = trustSource(plan),
                    approver = PeerKeyApprover { prompt -> awaitConsent(plan, prompt) },
                    admission = admissionGate(plan),
                    options = PeerPairOptions(label = plan.label),
                )
                if (!pairing.ok) {
                    failAttempt(plan, reasonForPairing(pairing.status, pairing.httpStatus))
                    return
                }
                val serverKey = pairing.serverKey
                if (serverKey == null) {
                    // No verified echo of this side's own key means nothing to remember.
                    failAttempt(plan, HostConnectionReason.PEER_KEY_CHANGED)
                    return
                }
                when (val commit = commitPairKey(plan, serverKey, identity.keyId)) {
                    is PinCommit.Rejected -> {
                        failAttempt(plan, commit.reason)
                        return
                    }
                    PinCommit.Stale -> return
                    PinCommit.Committed -> Unit
                }
            }

            val channel = created.open(
                endpoint = PeerEndpoint(plan.endpoint.host, plan.endpoint.port),
                lane = PeerAppLane.APP,
                identity = identity,
                trust = trustSource(plan),
                admission = admissionGate(plan),
                sendGuard = sendGuard(plan),
            )

            val handoff = synchronized(lock) sync@{
                val runtime = runtimes[plan.hostId] ?: return@sync null
                if (runtime.epoch != plan.epoch || runtime.mode != plan.mode || !foreground) return@sync null
                runtime.appChannel = channel
                runtime.peerFingerprint = channel.peerKey.fingerprint
                runtime.phase = HostConnectionPhase.CONNECTED
                runtime.reason = HostConnectionReason.NONE
                runtime.mode = null
                runtime.autoAttempts = 0
                connected = true
                publishLocked()
                HostAppChannel(
                    hostId = plan.hostId,
                    endpoint = plan.endpoint,
                    generation = plan.epoch,
                    peerFingerprint = channel.peerKey.fingerprint,
                    channel = channel,
                )
            }
            if (handoff == null) {
                runCatching { channel.close() }
                return
            }

            // Only an authenticated application channel that actually opened is
            // connection history. A mere attempt never marks anything.
            markPreviouslyConnected(plan.hostId)
            listenerSnapshot().forEach { it.onAppChannelAvailable(handoff) }

            // The registry never reads this channel. Waiting for its end is the
            // only fact about it that belongs at this layer.
            runCatching { channel.closed.await() }
            handleChannelLoss(plan, channel)
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (failure: PeerTransportException) {
            failAttempt(plan, reasonForTransport(failure.code))
        } catch (_: PeerKeyConversionRejected) {
            failAttempt(plan, HostConnectionReason.TRUST_UNAVAILABLE)
        } catch (_: Throwable) {
            failAttempt(plan, HostConnectionReason.NONE)
        } finally {
            if (!connected) {
                val orphan = synchronized(lock) sync@{
                    val runtime = runtimes[plan.hostId]
                    if (runtime != null && runtime.transport === transport) {
                        runtime.transport = null
                        transport
                    } else {
                        null
                    }
                }
                orphan?.dispose()
            }
        }
    }

    private fun markPairing(plan: AttemptPlan): Boolean = synchronized(lock) sync@{
        val runtime = runtimes[plan.hostId] ?: return@sync false
        if (runtime.epoch != plan.epoch || runtime.mode != AttemptMode.EXPLICIT) return@sync false
        runtime.phase = HostConnectionPhase.PAIRING
        runtime.reason = HostConnectionReason.PAIRING
        publishLocked()
        true
    }

    private fun stopAttempt(plan: AttemptPlan) {
        synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync
            if (runtime.epoch != plan.epoch) return@sync
            runtime.mode = null
            if (runtime.phase != HostConnectionPhase.CONNECTED) {
                runtime.phase = HostConnectionPhase.DISCONNECTED
                runtime.reason = HostConnectionReason.NONE
            }
            publishLocked()
        }
    }

    /**
     * Settle a failed attempt. A terminal reason is reported and never retried
     * in the background; anything else is eligible for the finite schedule.
     */
    private fun failAttempt(plan: AttemptPlan, reason: HostConnectionReason) {
        val retry = synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync false
            if (runtime.epoch != plan.epoch) return@sync false
            runtime.mode = null
            runtime.attemptJob = null
            runtime.watch?.reported = true
            runtime.watch = null
            if (reason.terminal) {
                runtime.phase = HostConnectionPhase.ERROR
                runtime.reason = reason
                publishLocked()
                false
            } else {
                runtime.phase = HostConnectionPhase.DISCONNECTED
                runtime.reason = reason
                publishLocked()
                true
            }
        }
        if (retry) scheduleRetry(plan.hostId, expectedEpoch = plan.epoch)
    }

    /**
     * A channel ended. Its destination's epoch moves first, so a late callback
     * from the same attempt is refused before anything is reported, and only this
     * destination's transport is disposed.
     */
    private fun handleChannelLoss(plan: AttemptPlan, channel: PeerByteChannel) {
        var retryEpoch: Long? = null
        val events = ArrayList<HostChannelLost>()
        val owned = synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync null
            // No live watcher means this destination was already retired by the
            // registry itself — a background, a disconnect, a removal, or the
            // loss report below. Its channel ending afterwards is expected, and
            // reporting it again would invent a second, contradicting loss.
            val watch = runtime.watch ?: return@sync null
            if (watch.reported) return@sync null
            if (runtime.epoch != plan.epoch || runtime.appChannel !== channel) {
                events += HostChannelLost(plan.hostId, plan.endpoint, plan.epoch, HostConnectionReason.CONNECTION_LOST, stale = true)
                null
            } else {
                watch.reported = true
                runtime.epoch += 1
                retryEpoch = runtime.epoch
                runtime.watch = null
                runtime.appChannel = null
                runtime.contentChannels.clear()
                runtime.peerFingerprint = null
                runtime.mode = null
                runtime.phase = HostConnectionPhase.DISCONNECTED
                runtime.reason = HostConnectionReason.CONNECTION_LOST
                publishEligibilityLocked(runtime)
                events += HostChannelLost(plan.hostId, plan.endpoint, plan.epoch, HostConnectionReason.CONNECTION_LOST, stale = false)
                val transport = runtime.transport
                runtime.transport = null
                publishLocked()
                transport
            }
        }
        owned?.dispose()
        events.forEach { event -> listenerSnapshot().forEach { it.onChannelLost(event) } }
        retryEpoch?.let { scheduleRetry(plan.hostId, expectedEpoch = it) }
    }

    // -------------------------------------------------------------- scheduling

    /**
     * Queue one automatic attempt for one destination.
     *
     * [immediate] is used only for the first dial a saved automatic-reconnect
     * preference asks for at startup: the user already said "keep me connected",
     * so that dial does not wait out a backoff and does not consume a slot in the
     * finite schedule. Every later attempt backs off, and the schedule stops once
     * its bounded waits are used up.
     */
    private fun scheduleRetry(hostId: HostId, immediate: Boolean = false, expectedEpoch: Long? = null) {
        val epoch = synchronized(lock) {
            val runtime = runtimes[hostId] ?: return
            if (expectedEpoch != null && runtime.epoch != expectedEpoch) return
            if (!autoEligibleLocked(runtime)) return
            runtime.epoch
        }
        val job = scope.launch(start = CoroutineStart.LAZY) scheduled@{
            val waitMs = synchronized(lock) sync@{
                val runtime = runtimes[hostId] ?: return@sync null
                if (runtime.epoch != epoch) return@sync null
                // This job owns the timer, so its own `RETRYING` phase and its
                // own slot are not reasons to refuse; everything durable is.
                if (!autoEligibleLocked(runtime, fromTimer = true)) {
                    if (runtime.phase == HostConnectionPhase.RETRYING) {
                        runtime.phase = HostConnectionPhase.DISCONNECTED
                        runtime.reason = HostConnectionReason.NONE
                    }
                    runtime.retryJob = null
                    publishLocked()
                    null
                } else if (runtime.autoAttempts >= policy.autoReconnectDelaysMs.size) {
                    // The schedule is finite: it stops instead of repeating the
                    // last delay forever.
                    runtime.phase = HostConnectionPhase.DISCONNECTED
                    runtime.reason = HostConnectionReason.AUTO_STOPPED
                    runtime.retryJob = null
                    publishLocked()
                    null
                } else {
                    val first = immediate && runtime.autoAttempts == 0
                    val wait = if (first) {
                        0L
                    } else {
                        policy.autoReconnectDelaysMs[minOf(runtime.autoAttempts, policy.autoReconnectDelaysMs.size - 1)]
                    }
                    if (!first) runtime.autoAttempts += 1
                    runtime.phase = HostConnectionPhase.RETRYING
                    runtime.reason = if (first) HostConnectionReason.CONNECTING else HostConnectionReason.RECONNECTING
                    publishLocked()
                    wait
                }
            } ?: return@scheduled
            delay(waitMs)
            val plan = synchronized(lock) sync@{
                val runtime = runtimes[hostId] ?: return@sync null
                if (runtime.epoch != epoch) return@sync null
                runtime.retryJob = null
                if (!autoEligibleLocked(runtime, fromTimer = true)) {
                    if (runtime.phase == HostConnectionPhase.RETRYING) {
                        runtime.phase = HostConnectionPhase.DISCONNECTED
                        runtime.reason = HostConnectionReason.NONE
                    }
                    publishLocked()
                    null
                } else {
                    runtime.epoch += 1
                    publishEligibilityLocked(runtime)
                    runtime.mode = AttemptMode.AUTO
                    runtime.phase = HostConnectionPhase.CONNECTING
                    runtime.reason = HostConnectionReason.RECONNECTING
                    publishLocked()
                    planFor(runtime, AttemptMode.AUTO)
                }
            } ?: return@scheduled
            // Installed through the same ownership path as every other attempt,
            // so an automatic connection has a watch, an attempt job, and a loss
            // report exactly like an explicit one. Calling the attempt body
            // directly here would leave a successful Auto connection unwatched:
            // it would stay CONNECTED forever after its channel ended.
            launchAttempt(plan)
        }
        val installed = synchronized(lock) sync@{
            val runtime = runtimes[hostId] ?: return@sync false
            if (runtime.epoch != epoch || runtime.retryJob != null || !autoEligibleLocked(runtime)) return@sync false
            runtime.retryJob = job
            true
        }
        if (installed) job.start() else job.cancel()
    }

    /**
     * Automatic eligibility, from durable facts plus the keys storage already
     * confirmed.
     *
     * A trust read that failed is a refusal, never a "no key": unreadable trust
     * must not become an unattended first-use acceptance. A terminal failure is
     * never retried behind the user's back, and a destination that already has
     * something scheduled or in flight is never double-scheduled.
     *
     * [fromTimer] relaxes only the two facts the timer itself owns — the
     * `RETRYING` phase and its own job — so the durable conditions are identical
     * whether eligibility is asked before or after a wait elapsed.
     */
    private fun autoEligibleLocked(runtime: HostRuntime, fromTimer: Boolean = false): Boolean {
        if (runtime.id in removingHosts || runtime.explicitConnectRequired) return false
        if (closed || !foreground) return false
        if (!settingsState.available) return false
        if (!settings.autoReconnect) return false
        val saved = settings.findHost(runtime.id) ?: return false
        if (!saved.previouslyConnected) return false
        if (saved.reconnectSuppressed || runtime.id in suppressionOverride) return false
        if (runtime.phase == HostConnectionPhase.CONNECTED || runtime.phase == HostConnectionPhase.ERROR) return false
        if (!fromTimer &&
            (
                runtime.phase == HostConnectionPhase.RETRYING ||
                    runtime.phase == HostConnectionPhase.CONNECTING ||
                    runtime.phase == HostConnectionPhase.PAIRING
                )
        ) {
            return false
        }
        if (runtime.mode != null) return false
        if (!fromTimer && runtime.retryJob?.isActive == true) return false
        if (!trustState.available) return false
        if (eligibility[runtime.id]?.keyId == null) return false
        return identityObservation is DeviceIdentityObservation.Ready
    }

    // --------------------------------------------------------------- settings

    /**
     * Publish one settings copy.
     *
     * The in-memory model keeps the change either way, because connection
     * history and an explicit Disconnect are real facts about this session even
     * when the document write failed. What never happens is a silent reset: the
     * snapshot reports the failed save instead.
     *
     * Staging, the durable write, and the adoption of its result all happen
     * inside [settingsTransaction], in the order the mutations were asked for.
     * Saved configuration is one whole document, so two attempts that staged in
     * order but wrote out of order would leave the disk holding the older one
     * while both callers believed theirs had landed — the classic way an explicit
     * Disconnect quietly comes back. The registry lock is never held across the
     * store write, so a slow document cannot stall a send guard or a socket
     * callback; this narrower monitor only keeps publications in line.
     */
    private fun updateSettings(apply: (NetworkSettings) -> SettingsMutation): Boolean =
        synchronized(settingsTransaction) {
            val next = synchronized(lock) sync@{
                when (val mutation = apply(settings)) {
                    is SettingsMutation.Ok -> {
                        settings = mutation.settings
                        settingsGeneration += 1
                        publishLocked()
                        mutation.settings
                    }
                    is SettingsMutation.Failed -> null
                }
            } ?: return false
            val failure = runCatching { settingsStore.write(next) }.exceptionOrNull()
            if (failure == null) {
                synchronized(lock) sync@{
                    // A write that landed replaces the report that it had not.
                    if (!settingsState.available || notice?.reason == RegistryNoticeReason.SETTINGS_WRITE_FAILED ||
                        notice?.reason == RegistryNoticeReason.SUPPRESSION_NOT_PERSISTED
                    ) {
                        settingsState = StorageHandleState(available = true)
                        if (notice?.reason == RegistryNoticeReason.SETTINGS_WRITE_FAILED ||
                            notice?.reason == RegistryNoticeReason.SUPPRESSION_NOT_PERSISTED
                        ) {
                            notice = null
                        }
                        publishLocked()
                    }
                }
                return true
            }
            synchronized(lock) sync@{
                settingsState = StorageHandleState(
                    available = false,
                    reason = (failure as? StorageException)?.reason ?: StorageFailureReason.WRITE_FAILED,
                )
                notice = RegistryNotice(RegistryNoticeReason.SETTINGS_WRITE_FAILED, null)
                publishLocked()
            }
            false
        }

    /** Copy one whole-preference value and publish it. */
    private fun updatePreference(copy: (NetworkSettings) -> NetworkSettings): Boolean =
        updateSettings { SettingsMutation.Ok(copy(it)) }

    /**
     * Whether this destination carries an explicit Disconnect intent.
     *
     * The durable copy is the remembered answer; the in-memory set is the
     * failsafe that stands in when that save itself failed. Either one suppresses,
     * and only an explicit Connect clears both.
     */
    private fun suppressedLocked(hostId: HostId): Boolean {
        val saved = settings.findHost(hostId)?.reconnectSuppressed ?: false
        return saved || hostId in suppressionOverride
    }

    private fun clearSuppression(hostId: HostId) {
        updateSettings { it.updatingHost(hostId) { host -> host.withReconnectSuppressed(false) } }
        synchronized(lock) sync@{
            if (hostId in suppressionOverride) {
                suppressionOverride -= hostId
                publishLocked()
            }
        }
    }

    private fun markPreviouslyConnected(hostId: HostId) {
        val already = synchronized(lock) { settings.findHost(hostId)?.previouslyConnected ?: false }
        if (already) return
        updateSettings { it.updatingHost(hostId) { host -> host.withPreviouslyConnected(true) } }
    }

    // --------------------------------------------------------------- identity

    /** Observe this device's identity. Never creates a key, file, or directory. */
    private fun observeIdentity(): DeviceIdentityObservation = try {
        when (val status = identityStore.status()) {
            PeerIdentityStatus.NeverInitialized -> DeviceIdentityObservation.NeverInitialized
            PeerIdentityStatus.Ready -> DeviceIdentityObservation.Ready(identityStore.current().key.fingerprint)
            is PeerIdentityStatus.Refused -> DeviceIdentityObservation.Refused(identityReason(status.reason))
        }
    } catch (failure: IdentityException) {
        DeviceIdentityObservation.Refused(identityReason(failure.reason))
    } catch (_: Throwable) {
        DeviceIdentityObservation.Refused(DeviceIdentityReason.KEY_STORE_UNAVAILABLE)
    }

    private fun publishIdentityObservation() {
        val refreshed = observeIdentity()
        synchronized(lock) sync@{
            if (identityObservation == refreshed) return@sync
            identityObservation = refreshed
            publishLocked()
        }
    }

    private fun currentIdentityHandle(): PeerIdentityHandle = try {
        identityStore.current()
    } catch (failure: IdentityException) {
        throw asRegistryIdentityFailure(failure)
    }

    private fun currentIdentity(): DevicePeerIdentity = DevicePeerIdentity(currentIdentityHandle())

    /**
     * The only path that may generate this device's identity, and only once.
     *
     * A never-initialized device initializes on an explicit Connect, because the
     * user asked for a connection. A device whose earlier initialization is
     * missing or inconsistent is refused instead: regenerating would silently
     * break every host that pinned the first key, and no reconnect may do that
     * quietly.
     */
    private fun ensureIdentityForExplicit(): DevicePeerIdentity = try {
        when (val status = identityStore.status()) {
            PeerIdentityStatus.Ready -> DevicePeerIdentity(identityStore.current())
            PeerIdentityStatus.NeverInitialized ->
                DevicePeerIdentity(identityStore.initialize(HostLabel.parse(DevicePeerIdentity.LABEL)))
            is PeerIdentityStatus.Refused -> throw RegistryIdentityException(identityReason(status.reason))
        }
    } catch (failure: IdentityException) {
        throw asRegistryIdentityFailure(failure)
    }

    // ------------------------------------------------------------ trust glue

    /**
     * The trust the transport is allowed to act on right now.
     *
     * A storage refusal throws, deliberately: the transport treats a failed
     * trust source as a closed connection, whereas returning null here would say
     * "nothing is remembered" and invite an unattended first-use acceptance.
     */
    private fun trustSource(plan: AttemptPlan): PeerTrustSource = PeerTrustSource {
        when (val pin = pinStore.read(plan.hostId, plan.endpoint)) {
            PinRead.NoPin -> null
            is PinRead.Remembered -> PeerKeyBridge.toTransport(pin.key)
            PinRead.EndpointMismatch -> throw IllegalStateException("saved association is pinned elsewhere")
            is PinRead.Refused -> throw IllegalStateException("trust storage refused")
        }
    }

    /**
     * Commit a freshly paired key inside one section that retirement cannot enter.
     *
     * The transport returns a key only after the peer echoed this side's own key
     * back on the same verified handshake, so the echo is already proven. What is
     * checked here is everything the transport cannot see: that this attempt is
     * still the live explicit attempt at the epoch it dialed with, that the app is
     * still foreground, that the saved association still names the endpoint this
     * handshake went to, and that this device is still the identity the handshake
     * was made with — a key remembered under a local identity that no longer
     * exists would be trusted against a proof nobody can reproduce. The identity
     * is read from the store inside this section rather than taken from the
     * observation cached before pairing, because that observation only describes
     * how things looked when the dial started.
     *
     * The whole decision is one critical section. A durable record is IO, but it
     * is storage only: no socket and no listener callback runs in here, so it can
     * be serialized against retirement instead of being compensated afterwards.
     * A removal or a background that arrives mid-record simply waits, and when it
     * proceeds it finds a committed key and an epoch it is free to move.
     *
     * There is deliberately no post-write withdrawal. Clearing a pin as
     * compensation is not safe in either direction: `Unchanged` describes a key
     * this host may have remembered for months and this handshake merely
     * re-proved, and a delayed cleanup can just as easily delete a pin a newer
     * attempt committed successfully a moment earlier. Trust the user never
     * revoked is never a rollback target. Whichever order the two operations
     * happen in, the association ends holding what the user's last action said it
     * should.
     */
    private fun commitPairKey(
        plan: AttemptPlan,
        observed: io.github.rfairburn.pireviewgate.core.transport.PeerKey,
        pairingKeyId: String,
    ): PinCommit = synchronized(lock) {
        if (!pairCommitAdmissibleLocked(plan)) return@synchronized PinCommit.Stale

        // The live store, not the cached view: an identity that became unreadable
        // during pairing invalidates the proof this key would be trusted against.
        val currentKeyId = runCatching { identityStore.current().key.keyId }.getOrNull()
        if (currentKeyId != pairingKeyId) {
            return@synchronized PinCommit.Rejected(HostConnectionReason.IDENTITY_UNAVAILABLE)
        }

        val stored = try {
            PeerKeyBridge.toStored(observed)
        } catch (_: PeerKeyConversionRejected) {
            return@synchronized PinCommit.Rejected(HostConnectionReason.TRUST_UNAVAILABLE)
        }
        val outcome = runCatching { pinStore.record(plan.hostId, plan.endpoint, stored) }
        if (outcome.isFailure) return@synchronized PinCommit.Rejected(HostConnectionReason.TRUST_UNAVAILABLE)
        when (outcome.getOrThrow()) {
            PinRecordResult.Recorded, PinRecordResult.Unchanged -> Unit
            PinRecordResult.RejectedChangedKey -> return@synchronized PinCommit.Rejected(HostConnectionReason.PEER_KEY_CHANGED)
            PinRecordResult.EndpointMismatch -> return@synchronized PinCommit.Rejected(HostConnectionReason.PIN_ENDPOINT_MISMATCH)
            is PinRecordResult.Refused -> return@synchronized PinCommit.Rejected(HostConnectionReason.TRUST_UNAVAILABLE)
        }

        val current = eligibility[plan.hostId] ?: return@synchronized PinCommit.Stale
        eligibility = eligibility + (plan.hostId to current.copy(keyId = stored.keyId))
        // The record landing is itself proof that trust storage is usable again.
        trustState = StorageHandleState(available = true)
        trustUsable = true
        publishLocked()
        PinCommit.Committed
    }

    /** Every fact that must still hold for a pairing result to be admissible. */
    private fun pairCommitAdmissibleLocked(plan: AttemptPlan): Boolean {
        val runtime = runtimes[plan.hostId] ?: return false
        val saved = settings.findHost(plan.hostId) ?: return false
        return !closed &&
            runtime.epoch == plan.epoch &&
            runtime.mode == AttemptMode.EXPLICIT &&
            foreground &&
            saved.endpoint == plan.endpoint &&
            eligibility[plan.hostId]?.endpoint == plan.endpoint
    }

    private sealed interface PinCommit {
        data object Committed : PinCommit
        data object Stale : PinCommit
        data class Rejected(val reason: HostConnectionReason) : PinCommit
    }

    // --------------------------------------------------------- guards & gates

    /**
     * The association and lifecycle proof the transport re-checks immediately
     * before the first request byte. Only an explicit user Connect may put a
     * pairing on the wire.
     */
    private fun admissionGate(plan: AttemptPlan): PeerAdmissionGate = PeerAdmissionGate { _, _, _ ->
        synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync false
            if (runtime.epoch != plan.epoch) return@sync false
            if (!foreground) return@sync false
            if (eligibility[plan.hostId]?.endpoint != plan.endpoint) return@sync false
            runtime.mode == plan.mode
        }
    }

    /** The same proof for a content lane opened on an already connected host. */
    private fun connectedGate(plan: AttemptPlan): PeerAdmissionGate = PeerAdmissionGate { _, _, _ ->
        synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync false
            runtime.epoch == plan.epoch &&
                foreground &&
                runtime.phase == HostConnectionPhase.CONNECTED &&
                eligibility[plan.hostId]?.endpoint == plan.endpoint
        }
    }

    /**
     * The send guard the transport evaluates when a frame is queued and again
     * immediately before the socket write.
     *
     * It is lock-free and IO-free by construction: one volatile map read and a
     * few comparisons. It never touches storage, a framework, or UI, and it never
     * runs while a registry lock is held, because a guard that blocks is a guard
     * that deadlocks the writer it is supposed to protect.
     *
     * Pin truth arrives through the published eligibility snapshot, which is
     * refreshed only after a storage operation actually confirmed. So a cleared,
     * changed, or re-pointed key drops pending frames immediately without this
     * guard reading anything, and a storage read that failed is never mistaken
     * for "no key".
     */
    private fun sendGuard(plan: AttemptPlan): PeerSendGuard {
        val hostId = plan.hostId
        val capturedEpoch = plan.epoch
        val capturedEndpoint = plan.endpoint
        val capturedKey = eligibility[hostId]?.keyId
        return object : PeerSendGuard {
            override fun allows(): Boolean {
                if (!foreground) return false
                // Trust the registry could not confirm is not a reason to keep
                // writing: eligibility was revoked with the failed read, and this
                // check closes the window between the read and the retirement.
                if (!trustUsable) return false
                val current = eligibility[hostId] ?: return false
                if (current.endpoint != capturedEndpoint) return false
                if (current.epoch != capturedEpoch) return false
                val key = current.keyId ?: return false
                if (capturedKey != null && key != capturedKey) return false
                return true
            }

            override fun epoch(): Long = capturedEpoch
        }
    }

    // --------------------------------------------------------------- consents

    /**
     * Latch one confirmation and wait for the foreground answer.
     *
     * Only an explicit Connect reaches here. An automatic or resume attempt
     * supplies no approver, so an unknown key is refused by the transport instead
     * of being answered by a prompt nobody asked for.
     */
    private suspend fun awaitConsent(plan: AttemptPlan, prompt: PeerServerKeyPrompt): PeerKeyDecision {
        val deferred = synchronized(lock) sync@{
            val runtime = runtimes[plan.hostId] ?: return@sync null
            if (runtime.epoch != plan.epoch || runtime.mode != AttemptMode.EXPLICIT || !foreground) return@sync null
            if (consents.values.any { it.hostId == plan.hostId }) return@sync null
            if (eligibility[plan.hostId]?.keyId != null) return@sync null
            val id = nextConsentId++
            val completion = CompletableDeferred<PeerKeyDecision>()
            val record = HostKeyConsent(
                consentId = id,
                hostId = plan.hostId,
                label = settings.findHost(plan.hostId)?.label?.value ?: prompt.label ?: DevicePeerIdentity.LABEL,
                endpoint = plan.endpoint,
                keyId = prompt.key.keyId,
                fingerprint = prompt.key.fingerprint,
                generation = plan.epoch,
                foregroundEpoch = foregroundEpoch,
                expiresAtMonoMs = monotonicNowMs() + policy.consentWindowMs,
            )
            consents[id] = PendingConsent(id, plan.hostId, plan.epoch, record, completion)
            publishLocked()
            completion
        } ?: return PeerKeyDecision.CANCEL

        val answer = try {
            withTimeoutOrNull(policy.consentWindowMs) { deferred.await() }
        } catch (cancellation: CancellationException) {
            // A cancelled attempt is not an unanswered prompt: the coroutine stops
            // here, and the `finally` below still withdraws the confirmation.
            throw cancellation
        } catch (_: Throwable) {
            null
        } finally {
            // Always, including the cancellation path: a confirmation whose
            // attempt was cancelled must not stay latched. A record nobody can
            // answer any more would hold the host's single prompt slot and keep
            // the next explicit Connect from ever asking.
            synchronized(lock) sync@{
                if (consents.values.any { it.decision === deferred }) {
                    consents.values.filter { it.decision === deferred }.toList()
                        .forEach { consents.remove(it.consentId) }
                    publishLocked()
                }
            }
        }
        // Nobody answered in time. The attempt fails and nothing re-prompts.
        return answer ?: PeerKeyDecision.CANCEL
    }

    // ---------------------------------------------------------------- reasons

    private fun reasonForPairing(status: PeerPairStatus, httpStatus: Int): HostConnectionReason = when {
        status == PeerPairStatus.DENIED -> HostConnectionReason.PAIRING_DENIED
        status == PeerPairStatus.TIMEOUT -> HostConnectionReason.PAIRING_EXPIRED
        status == PeerPairStatus.HTTP_ERROR && httpStatus == 403 -> HostConnectionReason.PAIRING_DENIED
        else -> HostConnectionReason.NONE
    }

    private fun reasonForTransport(code: PeerTransportErrorCode): HostConnectionReason = when (code) {
        PeerTransportErrorCode.PEER_KEY_MISMATCH,
        PeerTransportErrorCode.PEER_KEY_CHANGED,
        PeerTransportErrorCode.PAIRING_KEY_ECHO_MISMATCH,
        -> HostConnectionReason.PEER_KEY_CHANGED
        PeerTransportErrorCode.TRUST_STORE_FAILED -> HostConnectionReason.TRUST_UNAVAILABLE
        PeerTransportErrorCode.PEER_KEY_REJECTED,
        PeerTransportErrorCode.PEER_KEY_CANCELLED,
        PeerTransportErrorCode.PEER_KEY_PROMPT_TIMEOUT,
        PeerTransportErrorCode.PEER_KEY_DECISION_INVALID,
        PeerTransportErrorCode.PEER_KEY_APPROVER_FAILED,
        PeerTransportErrorCode.CONSENT_LIMIT_REACHED,
        -> HostConnectionReason.APPROVAL_DECLINED
        PeerTransportErrorCode.PAIRING_DENIED -> HostConnectionReason.PAIRING_DENIED
        PeerTransportErrorCode.PAIRING_TIMEOUT -> HostConnectionReason.PAIRING_EXPIRED
        PeerTransportErrorCode.APP_REFUSED -> HostConnectionReason.NOT_AUTHORIZED
        else -> HostConnectionReason.NONE
    }
}

/**
 * Whether a latched confirmation is still admissible, and which record it is.
 *
 * Split out so the committed-frame question can be asked outside the registry
 * monitor without holding a lock across a foreign callback.
 */
private sealed interface ConsentGate {
    data class Denied(val reason: HostKeyConsentStaleReason) : ConsentGate
    data class Presenting(val record: HostKeyConsent) : ConsentGate
}

/** The outcome of the second consent pass: a refusal, or the waiter to answer. */
private sealed interface ConsentSettlement {
    data class Denied(val reason: HostKeyConsentStaleReason) : ConsentSettlement
    data class Take(val decision: CompletableDeferred<PeerKeyDecision>) : ConsentSettlement
}

/**
 * The published association and key facts one destination currently has.
 *
 * Immutable and published wholesale, so a send guard can read it at any moment
 * from any thread without a lock and without seeing a half-applied change.
 */
internal data class HostEligibility(
    val epoch: Long,
    val endpoint: Endpoint,
    val keyId: String?,
)

/** A fixed, sanitized report about one thing the registry could not complete. */
public data class RegistryNotice(
    public val reason: RegistryNoticeReason,
    public val hostId: HostId?,
)

/** Fixed notice reasons. None carries a path, a key, or peer text. */
public enum class RegistryNoticeReason {
    /** Saved configuration refused the publication. */
    SETTINGS_WRITE_FAILED,

    /** Saved configuration could not be read; its preferences are unknown. */
    SETTINGS_UNREADABLE,

    /** Remembered keys could not be read; outbound eligibility was revoked. */
    TRUST_UNREADABLE,

    /** An explicit Disconnect is remembered for this session but not on disk. */
    SUPPRESSION_NOT_PERSISTED,

    /** The saved host is still configured because its removal could not be saved. */
    HOST_NOT_REMOVED,

    /** The remembered key is still present because trust storage refused. */
    PIN_NOT_CLEARED,
    ;
}
