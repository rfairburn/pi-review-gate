package io.github.rfairburn.pireviewgate.permissions

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermission
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionPlatformFacts
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionProbe
import io.github.rfairburn.pireviewgate.core.permissions.LocalNetworkPermissionStatus

/**
 * Android implementation of the side-effect-free local-network permission probe.
 *
 * Below API 37 the permission does not apply to this client and neither the grant
 * check nor the rationale check touches it. On API 37 and later the probe reads the
 * current grant and `shouldShowRequestPermissionRationale`; it never requests the
 * permission or presents UI.
 */
internal class AndroidLocalNetworkPermissionProbe(
    private val activity: Activity,
) : LocalNetworkPermissionProbe {
    override fun observe(): LocalNetworkPermissionPlatformFacts {
        val sdkInt = Build.VERSION.SDK_INT
        if (sdkInt < LocalNetworkPermission.REQUIRED_SDK_INT) {
            return LocalNetworkPermissionPlatformFacts(
                status = LocalNetworkPermissionStatus.NOT_REQUIRED,
            )
        }

        val granted = ContextCompat.checkSelfPermission(
            activity,
            Manifest.permission.ACCESS_LOCAL_NETWORK,
        ) == PackageManager.PERMISSION_GRANTED
        val status = LocalNetworkPermission.statusFor(sdkInt = sdkInt, granted = granted)
        val shouldShowRationale = status == LocalNetworkPermissionStatus.NOT_GRANTED &&
            ActivityCompat.shouldShowRequestPermissionRationale(
                activity,
                Manifest.permission.ACCESS_LOCAL_NETWORK,
            )
        return LocalNetworkPermissionPlatformFacts(
            status = status,
            shouldShowRationale = shouldShowRationale,
        )
    }
}

/**
 * Open this app's system settings page. Only an explicit user action may call this;
 * nothing in the permission flow opens Settings automatically.
 */
internal fun openAppPermissionSettings(activity: Activity) {
    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.fromParts("package", activity.packageName, null)
    }
    activity.startActivity(intent)
}
