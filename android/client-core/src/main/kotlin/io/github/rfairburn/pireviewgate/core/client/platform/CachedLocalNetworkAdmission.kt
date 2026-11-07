package io.github.rfairburn.pireviewgate.core.client.platform

import io.github.rfairburn.pireviewgate.core.client.connection.NetworkAccessAdmission
import io.github.rfairburn.pireviewgate.core.hosts.Endpoint
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionStatus
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkTargetHints

/** Cached grant plus NONEXHAUSTIVE syntactic hints, not routing or LAN detection. */
public class CachedLocalNetworkAdmission(private val sdkInt: Int) : NetworkAccessAdmission {
    @Volatile
    private var cachedStatus = LocalNetworkPermission.statusFor(sdkInt, granted = false)

    /** Permission is reported separately; a timeout is never evidence about it. */
    public val permissionStatus: LocalNetworkPermissionStatus get() = cachedStatus

    /** Refresh on the platform thread, never on a transport writer. Read refusal revokes LAN. */
    public fun refresh(read: () -> LocalNetworkPermissionStatus): LocalNetworkPermissionStatus {
        cachedStatus = if (sdkInt < LocalNetworkPermission.REQUIRED_SDK_INT) {
            LocalNetworkPermissionStatus.NOT_REQUIRED
        } else {
            // NOT_REQUIRED is not a valid platform answer on a device requiring the grant.
            when (runCatching(read).getOrNull()) {
                LocalNetworkPermissionStatus.GRANTED -> LocalNetworkPermissionStatus.GRANTED
                else -> LocalNetworkPermissionStatus.NOT_GRANTED
            }
        }
        return cachedStatus
    }

    /** False does NOT establish that this host is on the public Internet. No DNS or IO. */
    public fun requiresLocalNetworkGrant(endpoint: Endpoint): Boolean =
        sdkInt >= LocalNetworkPermission.REQUIRED_SDK_INT &&
            LocalNetworkTargetHints.endpointHasExplicitLocalHint(endpoint)

    /** Any-thread, cache-only admission. Unknown names/public traffic are not blanket blocked. */
    override fun allows(endpoint: Endpoint): Boolean =
        !requiresLocalNetworkGrant(endpoint) || cachedStatus != LocalNetworkPermissionStatus.NOT_GRANTED
}
