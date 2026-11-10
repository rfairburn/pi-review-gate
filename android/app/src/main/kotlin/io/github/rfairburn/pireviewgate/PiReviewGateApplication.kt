package io.github.rfairburn.pireviewgate

import android.app.Application
import io.github.rfairburn.pireviewgate.client.application.ClientApplicationController
import io.github.rfairburn.pireviewgate.core.client.ui.placement.TerminalOverlayPlacementHolder
import io.github.rfairburn.pireviewgate.storage.AndroidClientStorage
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** One graph per process; Activity recreation never owns the registry or its readers. */
class PiReviewGateApplication : Application() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val graph = MutableStateFlow<ClientApplicationController?>(null)
    val controller = graph.asStateFlow()
    private val failure = MutableStateFlow(false)
    val startupFailed = failure.asStateFlow()

    /**
     * UI-only overlay placement is independent of the client graph and its storage.
     * Its IO load, warning, and later completed-drag saves can never fail startup,
     * block composition, or touch host settings, trust, identity, or order state.
     */
    val overlayPlacements = TerminalOverlayPlacementHolder(
        openStore = { AndroidClientStorage.overlayPlacementStore(this@PiReviewGateApplication) },
    )

    override fun onCreate() {
        super.onCreate()
        // Start separately from the client graph so a defaulted cosmetic layout and a
        // refused client graph are reported independently rather than coupled.
        overlayPlacements.start()
        scope.launch {
            try {
                graph.value = withContext(Dispatchers.IO) { ClientApplicationController.create(this@PiReviewGateApplication) }
                graph.value!!.start()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Unreadable initialized state is not a fresh client and is never repaired.
                failure.value = true
            }
        }
    }
}
