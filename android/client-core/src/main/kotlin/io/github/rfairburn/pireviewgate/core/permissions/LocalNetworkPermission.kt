package io.github.rfairburn.pireviewgate.core.permissions

/**
 * Platform-neutral policy for Android's local-network runtime permission.
 *
 * Android 17 (API 37) requires `android.permission.ACCESS_LOCAL_NETWORK` for an
 * app that targets API 37 and uses the local network directly: outbound and inbound
 * TCP, UDP unicast/multicast/broadcast, and `.local` name resolution. Android 13-16
 * (API 33-36) has no equivalent runtime requirement for this client. Public
 * internet traffic is not gated by this permission.
 *
 * This object answers only "what is the permission status?". It does not decide
 * whether a particular endpoint is local, does not open sockets or resolve names,
 * and never blocks a connection by itself. A caller that knows a connection needs
 * local-network access consults the status before dialing; a missing permission is
 * never a reason to block ordinary public-internet connections.
 *
 * A TCP connection blocked by the missing permission can surface as a timeout, and
 * a timeout can have other causes. Report the permission status separately instead
 * of inferring that a timeout proves the permission is missing.
 */
public object LocalNetworkPermission {
    /** First Android API level that requires this runtime permission. */
    public const val REQUIRED_SDK_INT: Int = 37

    /** Platform permission string shared by the Android adapter and its callers. */
    public const val PERMISSION_NAME: String = "android.permission.ACCESS_LOCAL_NETWORK"

    /**
     * Status for one observed `(device SDK level, platform grant)` pair.
     *
     * `granted` is ignored below [REQUIRED_SDK_INT] because the permission does not
     * exist there for this client.
     */
    public fun statusFor(sdkInt: Int, granted: Boolean): LocalNetworkPermissionStatus =
        when {
            sdkInt < REQUIRED_SDK_INT -> LocalNetworkPermissionStatus.NOT_REQUIRED
            granted -> LocalNetworkPermissionStatus.GRANTED
            else -> LocalNetworkPermissionStatus.NOT_GRANTED
        }
}

/** Whether local-network access needs the Android 17 runtime permission. */
public enum class LocalNetworkPermissionStatus {
    /** Device API level is below 37; no runtime permission is needed. */
    NOT_REQUIRED,

    /** The platform reports the permission as granted. */
    GRANTED,

    /** The device requires the permission and the platform reports it as missing. */
    NOT_GRANTED,
}

/**
 * One platform-neutral read of the local-network permission.
 *
 * [shouldShowRationale] is the platform's current answer to
 * `shouldShowRequestPermissionRationale`. `false` is not a permanent-denial claim:
 * it is also the answer before the first request and can be affected by platform
 * and permission-group policy. [lastExplicitRequestDenied] is true only after this
 * app observed an explicit request result of "denied" in the current process; it
 * is not a platform permanence flag either.
 *
 * A settings affordance is suggested only when an explicit denial was observed and
 * no rationale remains. Showing that affordance is a caller choice, and opening
 * Settings must remain an explicit user action. This type never opens anything and
 * never requests permission.
 */
public data class LocalNetworkPermissionObservation(
    public val status: LocalNetworkPermissionStatus,
    public val shouldShowRationale: Boolean = false,
    public val lastExplicitRequestDenied: Boolean = false,
) {
    init {
        require(status == LocalNetworkPermissionStatus.NOT_GRANTED || !shouldShowRationale) {
            "a rationale is only meaningful while local-network permission is not granted"
        }
        require(status == LocalNetworkPermissionStatus.NOT_GRANTED || !lastExplicitRequestDenied) {
            "an explicit denial is only meaningful while local-network permission is not granted"
        }
    }

    /** True only when the device requires the permission and it is not granted. */
    public val needsPermission: Boolean
        get() = status == LocalNetworkPermissionStatus.NOT_GRANTED

    /** True when the platform reports that a rationale should be presented. */
    public val rationaleShouldBeShown: Boolean
        get() = needsPermission && shouldShowRationale

    /**
     * True after an observed explicit denial when the platform no longer offers a
     * rationale. This suggests offering a Settings action to the user; it does not
     * claim that the permission is permanently denied and never opens Settings.
     */
    public val settingsAffordanceSuggested: Boolean
        get() = needsPermission && lastExplicitRequestDenied && !shouldShowRationale
}

/**
 * Raw platform facts supplied by a [LocalNetworkPermissionProbe].
 *
 * Kept separate from [LocalNetworkPermissionObservation] so a platform probe can
 * report only what it directly observed and cannot invent request history.
 */
public data class LocalNetworkPermissionPlatformFacts(
    public val status: LocalNetworkPermissionStatus,
    public val shouldShowRationale: Boolean = false,
) {
    init {
        require(status == LocalNetworkPermissionStatus.NOT_GRANTED || !shouldShowRationale) {
            "a rationale is only meaningful while local-network permission is not granted"
        }
    }
}

/**
 * Injectable, side-effect-free read of the platform permission state.
 *
 * Implementations read the current grant and rationale only. They must never request
 * the permission, present UI, resolve a name, scan the network, or open a socket.
 */
public fun interface LocalNetworkPermissionProbe {
    public fun observe(): LocalNetworkPermissionPlatformFacts
}
