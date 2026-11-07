package io.github.rfairburn.pireviewgate.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.Composable

/** Non-launcher debug host. Only instrumentation supplies its content. */
class UiVerificationActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Match ClientActivity's real edge-to-edge root on both API baselines.
        enableEdgeToEdge()
        contentForRecreation?.let { content -> setContent { content() } }
    }

    companion object {
        // Explicit opt-in for orientation tests. A recreated Activity receives a
        // NEW composition/View/window; no configChanges exemption masks teardown.
        var contentForRecreation: (@Composable () -> Unit)? = null
    }
}
