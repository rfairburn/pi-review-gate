package io.github.rfairburn.pireviewgate

import android.app.Application
import io.github.rfairburn.pireviewgate.client.application.ClientApplicationController
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

    override fun onCreate() {
        super.onCreate()
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
