package io.github.rfairburn.pireviewgate.core.permissions

import io.github.rfairburn.pireviewgate.core.hosts.HostId

/**
 * One native permission prompt, bound to an explicit connect intent and the
 * foreground UI epoch in which it was started.
 *
 * The request id is issued by [LocalNetworkPermissionGate]. Callers pass it back
 * with the platform result; they must not synthesize or reuse one.
 */
public data class LocalNetworkPendingRequest(
    public val requestId: Long,
    public val token: LocalNetworkRequestToken,
    public val foregroundEpoch: Long,
)

/** Why a caller may not start a native permission prompt. */
public enum class LocalNetworkRequestRejectionReason {
    /** The app has no active foreground UI epoch that may own a system prompt. */
    NOT_IN_FOREGROUND_UI,

    /** No explicit connect intent is current, so there is no target to bind to. */
    NO_CURRENT_EXPLICIT_INTENT,

    /** A prompt is already tracked; a second prompt would race the first result. */
    REQUEST_ALREADY_PENDING,

    /** The device is below API 37, so the permission does not apply. */
    PERMISSION_NOT_REQUIRED,

    /** The permission is already granted; a prompt would be redundant. */
    PERMISSION_ALREADY_GRANTED,
}

/** Result of asking the gate to start a native permission prompt. */
public sealed interface LocalNetworkRequestStart {
    /** The request is tracked; the caller may now launch the native system prompt. */
    public data class Accepted(public val request: LocalNetworkPendingRequest) : LocalNetworkRequestStart

    /** No prompt may be started for [reason]. */
    public data class Rejected(public val reason: LocalNetworkRequestRejectionReason) : LocalNetworkRequestStart
}

/** Why a platform permission result is no longer usable. */
public enum class LocalNetworkRequestStaleReason {
    /** The app left the foreground or entered a different foreground UI epoch. */
    FOREGROUND_UI_CHANGED,

    /** The request id was never issued, already resolved, or already retired. */
    NO_MATCHING_REQUEST,

    /** The current explicit connect intent is gone or names another token. */
    TARGET_NOT_CURRENT,
}

/** Resolution of one native permission result. */
public sealed interface LocalNetworkRequestResolution {
    /**
     * The permission was granted for the request's token, and the token is still the
     * current explicit intent. The caller must still use this token only for the
     * current catalog target; this resolution starts nothing by itself.
     */
    public data class Granted(public val token: LocalNetworkRequestToken) : LocalNetworkRequestResolution

    /** The permission was denied for the request's token while that token was current. */
    public data class Denied(public val token: LocalNetworkRequestToken) : LocalNetworkRequestResolution

    /**
     * The result no longer belongs to the active foreground UI and intent. Callers
     * must ignore it: it must not start a connection, retry, or replay an action.
     */
    public data class Stale(
        public val requestId: Long,
        public val reason: LocalNetworkRequestStaleReason,
    ) : LocalNetworkRequestResolution
}

/**
 * Owns only the prompt lifecycle fence for the local-network permission.
 *
 * It never launches a native prompt (an Android adapter does that only from an
 * explicit foreground user action), never retries, never replays a connection or
 * UI action, never prompts on resume, and never starts a connection. Only one
 * native prompt is tracked at a time, even when several configured hosts are
 * connected concurrently.
 *
 * Each request is bound to a [LocalNetworkRequestToken] and the foreground UI epoch
 * in which it started. [enterForeground] starts a new epoch and retires any pending
 * request; [leaveForeground] retires it; [retirePending] and [retireForHost] retire
 * it on navigation, source changes, and host removal. A result becomes [Granted] or
 * [Denied] only while the request id, foreground epoch, and current explicit intent
 * token all still match. Once the app backgrounds, navigates, changes source, or
 * removes the host, a late grant is [LocalNetworkRequestResolution.Stale] and must
 * never start the old connection.
 *
 * [refresh] and [enterForeground] read the platform grant only; they never request.
 * [prepareRequest] refuses to prompt when the permission is already granted or not
 * required. The caller still decides whether a connection needs local-network
 * access; this gate exposes capability and never blocks public-internet traffic.
 *
 * A TCP connection blocked by the missing permission can look like a timeout, and a
 * timeout can have other causes. This gate reports permission status separately and
 * never treats a network failure as proof about the permission.
 */
public class LocalNetworkPermissionGate(
    private val probe: LocalNetworkPermissionProbe,
) {
    private val lock: Any = Any()
    private var nextRequestId: Long = 0L
    private var foregroundEpoch: Long = 0L
    private var inForeground: Boolean = false
    private var pending: LocalNetworkPendingRequest? = null
    private var lastExplicitRequestDenied: Boolean = false

    /** True while a foreground UI epoch owns prompt eligibility. */
    public val isInForegroundUi: Boolean
        get() = synchronized(lock) { inForeground }

    /**
     * Read the current grant and rationale without requesting or changing any
     * pending request. Safe to call on resume; it never prompts.
     */
    public fun refresh(): LocalNetworkPermissionObservation =
        synchronized(lock) { observationLocked(probe.observe()) }

    /**
     * Enter a fresh foreground UI epoch, retire any pending prompt, and read the
     * current grant and rationale. This never requests the permission.
     */
    public fun enterForeground(): LocalNetworkPermissionObservation = synchronized(lock) {
        inForeground = true
        foregroundEpoch += 1
        pending = null
        observationLocked(probe.observe())
    }

    /**
     * Leave the foreground and retire any pending prompt. Its eventual result is
     * stale. This never requests the permission.
     */
    public fun leaveForeground(): LocalNetworkRequestToken? = synchronized(lock) {
        inForeground = false
        val retired = pending?.token
        pending = null
        retired
    }

    /** Retire a pending prompt for navigation or a source change. */
    public fun retirePending(): LocalNetworkRequestToken? = synchronized(lock) {
        val retired = pending?.token
        pending = null
        retired
    }

    /** Retire a pending prompt when [hostId] is removed; other hosts are untouched. */
    public fun retireForHost(hostId: HostId): LocalNetworkRequestToken? = synchronized(lock) {
        val request = pending
        if (request != null && request.token.hostId == hostId) {
            pending = null
            request.token
        } else {
            null
        }
    }

    /** The currently tracked prompt, or `null`. */
    public fun pendingRequest(): LocalNetworkPendingRequest? = synchronized(lock) { pending }

    /**
     * Track a prompt for [currentIntent], or explain why no prompt may start.
     *
     * This only prepares the fence; the Android UI adapter launches the system
     * prompt after [LocalNetworkRequestStart.Accepted]. A null intent, a non-foreground
     * epoch, an already pending request, and a permission that is already granted or
     * not required are all rejected without any platform interaction.
     */
    public fun prepareRequest(currentIntent: LocalNetworkRequestToken?): LocalNetworkRequestStart {
        return synchronized(lock) {
            when {
                !inForeground -> LocalNetworkRequestStart.Rejected(
                    LocalNetworkRequestRejectionReason.NOT_IN_FOREGROUND_UI,
                )
                currentIntent == null -> LocalNetworkRequestStart.Rejected(
                    LocalNetworkRequestRejectionReason.NO_CURRENT_EXPLICIT_INTENT,
                )
                pending != null -> LocalNetworkRequestStart.Rejected(
                    LocalNetworkRequestRejectionReason.REQUEST_ALREADY_PENDING,
                )
                else -> {
                    val facts = probe.observe()
                    when (facts.status) {
                        LocalNetworkPermissionStatus.NOT_REQUIRED -> LocalNetworkRequestStart.Rejected(
                            LocalNetworkRequestRejectionReason.PERMISSION_NOT_REQUIRED,
                        )
                        LocalNetworkPermissionStatus.GRANTED -> {
                            lastExplicitRequestDenied = false
                            LocalNetworkRequestStart.Rejected(
                                LocalNetworkRequestRejectionReason.PERMISSION_ALREADY_GRANTED,
                            )
                        }
                        LocalNetworkPermissionStatus.NOT_GRANTED -> {
                            nextRequestId += 1L
                            val request = LocalNetworkPendingRequest(
                                requestId = nextRequestId,
                                token = currentIntent,
                                foregroundEpoch = foregroundEpoch,
                            )
                            pending = request
                            LocalNetworkRequestStart.Accepted(request)
                        }
                    }
                }
            }
        }
    }

    /**
     * Resolve a native permission result against the tracked prompt and the current
     * explicit intent.
     *
     * [currentIntent] must be the caller's current explicit connect target, or
     * `null` when no such intent exists. A result is usable only when the request
     * id, foreground epoch, and token all still match. Stale results retire any
     * leftover prompt and start nothing.
     */
    public fun resolve(
        requestId: Long,
        granted: Boolean,
        currentIntent: LocalNetworkRequestToken?,
    ): LocalNetworkRequestResolution {
        return synchronized(lock) {
            val request = pending
            when {
                !inForeground -> {
                    pending = null
                    LocalNetworkRequestResolution.Stale(
                        requestId,
                        LocalNetworkRequestStaleReason.FOREGROUND_UI_CHANGED,
                    )
                }
                request == null || request.requestId != requestId -> LocalNetworkRequestResolution.Stale(
                    requestId,
                    LocalNetworkRequestStaleReason.NO_MATCHING_REQUEST,
                )
                request.foregroundEpoch != foregroundEpoch -> {
                    pending = null
                    LocalNetworkRequestResolution.Stale(
                        requestId,
                        LocalNetworkRequestStaleReason.FOREGROUND_UI_CHANGED,
                    )
                }
                currentIntent == null || currentIntent != request.token -> {
                    pending = null
                    LocalNetworkRequestResolution.Stale(
                        requestId,
                        LocalNetworkRequestStaleReason.TARGET_NOT_CURRENT,
                    )
                }
                else -> {
                    pending = null
                    if (granted) {
                        lastExplicitRequestDenied = false
                        LocalNetworkRequestResolution.Granted(request.token)
                    } else {
                        lastExplicitRequestDenied = true
                        LocalNetworkRequestResolution.Denied(request.token)
                    }
                }
            }
        }
    }

    private fun observationLocked(
        facts: LocalNetworkPermissionPlatformFacts,
    ): LocalNetworkPermissionObservation {
        if (facts.status != LocalNetworkPermissionStatus.NOT_GRANTED) {
            lastExplicitRequestDenied = false
        }
        return LocalNetworkPermissionObservation(
            status = facts.status,
            shouldShowRationale = facts.shouldShowRationale,
            lastExplicitRequestDenied = lastExplicitRequestDenied,
        )
    }
}
