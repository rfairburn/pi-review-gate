package io.github.rfairburn.pireviewgate.acceptance

import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import io.github.rfairburn.pireviewgate.core.client.roster.RosterUiProof
import io.github.rfairburn.pireviewgate.core.client.runtime.TerminalTarget
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.atomic.AtomicReference

/** Native test fixture pane, NOT a terminal renderer or committed-frame proof. */
class FixtureActivity : ComponentActivity() {
    data class PermissionObservation(val status: String, val requestedNow: Boolean)
    val connect = CompletableDeferred<PermissionObservation>()
    val measurement = CompletableDeferred<Pair<Int, Int>>()
    private class SelectionToken(val target: TerminalTarget)
    private val selection = AtomicReference<SelectionToken?>()
    private lateinit var pane: TextView
    private var requestedNow = false
    private val launcher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        // A callback boolean is not the grant: consult the actual UID grant again.
        settlePermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // One inset owner on both API 33 and edge-to-edge-enforced API 37.
        window.setDecorFitsSystemWindows(false)
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
                WindowInsets.CONSUMED
            }
        }
        val button = Button(this).apply {
            text = "Connect"
            setOnClickListener {
                isEnabled = false
                if (Build.VERSION.SDK_INT >= 37 && !hasNetworkGrant()) {
                    requestedNow = true
                    launcher.launch(LOCAL_NETWORK)
                } else settlePermission()
            }
        }
        pane = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 6f
            text = "Fixture protocol pane — no rendered-terminal receipts"
        }
        layout.addView(button)
        layout.addView(pane, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(layout)
        pane.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            val cell = pane.paint.measureText("M")
            val line = pane.paint.fontSpacing
            if (cell > 0 && line > 0 && pane.width > 0 && pane.height > 0) {
                val cols = ((pane.width - pane.paddingLeft - pane.paddingRight) / cell).toInt()
                val rows = ((pane.height - pane.paddingTop - pane.paddingBottom) / line).toInt()
                if (cols > 0 && rows > 0) measurement.complete(cols to rows)
            }
        }
        layout.requestApplyInsets()
    }

    fun hasNetworkGrant(): Boolean = Build.VERSION.SDK_INT < 37 ||
        checkSelfPermission(LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED

    private fun settlePermission() {
        when {
            Build.VERSION.SDK_INT < 37 -> connect.complete(PermissionObservation("NOT_REQUIRED", false))
            hasNetworkGrant() -> connect.complete(PermissionObservation("GRANTED", requestedNow))
            else -> connect.completeExceptionally(IllegalStateException("local network permission denied"))
        }
    }

    /** Only a fixture selection-lifetime token; never authorizes input/copy/commits. */
    fun select(target: TerminalTarget): RosterUiProof {
        val token = SelectionToken(target)
        selection.set(token)
        return RosterUiProof { selection.get() === token && !isFinishing && !isDestroyed }
    }
    fun clearSelection() { selection.set(null) }
    override fun onStop() { clearSelection(); super.onStop() }
    override fun onDestroy() { clearSelection(); super.onDestroy() }

    companion object { const val LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK" }
}
