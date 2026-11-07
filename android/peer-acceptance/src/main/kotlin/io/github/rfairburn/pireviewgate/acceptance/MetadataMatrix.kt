package io.github.rfairburn.pireviewgate.acceptance

import io.github.rfairburn.pireviewgate.core.protocol.roster.*

/** Expected values only. Actual assertions compare every received DTO field. */
object MetadataMatrix {
    fun expected(index: Int, host: AcceptanceHost): List<RemoteSessionMetadata> {
        require(index in 0..63)
        val k = index + 1
        val even = index % 2 == 0
        return listOf(
            RemoteSessionMetadata(
                id = "shared-live", label = "fixture-live-$k", workspace = "/synthetic/host-$k",
                lifecycle = RosterLifecycle.ALIVE, hasLiveProcess = true, inputSurface = true,
                rosterSlotId = if (even) host.hostId.value else null,
                nativeSession = if (even) RemoteNativeSession(
                    host.hostRunId, 1, "Native $k", RemoteNativePersistence.SAVED,
                ) else null,
                busy = listOf(true, false, null)[index % 3],
                pendingInput = listOf(false, null, true)[index % 3],
                activity = listOf("synthetic activity $k", "synthetic detail"),
                backgroundTasks = if (even) 0L else null,
                backgroundShells = if (even) 3L else null,
                activeTasks = if (even) 2L else null,
                activeShells = if (even) 0L else null,
            ),
            RemoteSessionMetadata(
                id = "shared-exited", label = "fixture-exited-$k", workspace = "/synthetic/host-$k",
                lifecycle = RosterLifecycle.EXITED, hasLiveProcess = false, inputSurface = false,
                exitCode = 0.0, error = "Synthetic exit",
            ),
        )
    }

    fun assertReceived(index: Int, host: AcceptanceHost, actual: List<RemoteSessionMetadata>) {
        check(actual == expected(index, host)) { "received metadata matrix mismatch" }
    }
}
