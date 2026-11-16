package io.github.rfairburn.pireviewgate.androidtest

import android.content.pm.ApplicationInfo
import android.os.Debug
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.nio.file.Files

/**
 * Test-only handle on the exact clipboard-write meter.
 *
 * WHAT THIS MEASURES.  One JVMTI breakpoint, installed at the ENTRY of exactly
 * `android.content.ClipboardManager.setPrimaryClip(Landroid/content/ClipData;)V`
 * — the public Android SDK setter the production copy path calls — and one
 * monotonic 64-bit counter incremented once per entry, on every thread.  It says
 * nothing about what was written, by whom, or how often the framework then
 * notified a listener: notifications are not writes, and this counter never
 * counts one.  Two identical writes in the same millisecond count two.
 *
 * HOW IT IS LOADED.  The agent lives in the instrumented test APK only. This
 * process is the app's own debuggable test process, so the library is loaded by
 * absolute path from the TEST APK's native library directory and attached with
 * the public [android.os.Debug.attachJvmtiAgent] API. Nothing is injected into,
 * proxied in, replaced in, or reflected on the app: the app keeps calling the
 * real ClipboardManager, which keeps talking to the real system service over the
 * real binder. No permission is requested, pre-granted, or needed.
 *
 * FAIL CLOSED.  A meter that is not ready has no count: [total] throws rather
 * than reporting 0, so "the meter was broken" can never look like "no clipboard
 * write happened". The same holds for the library itself — a test APK built
 * without the meter fails here with the exact missing path and the build flag
 * that produces it, never as a skipped or zero-count pass.
 *
 * ONE SHOT, NO RESET.  The counter is cumulative for the life of the process and
 * deliberately exposes no reset: a phase is measured as the difference between
 * two reads of one uninterrupted count, so there is no window in which a write
 * could hide. A second attach is refused by the agent for the same reason.
 */
internal class ClipWriteMeter private constructor(
    /** Absolute path of the agent library inside the TEST APK's native library dir. */
    val agentPath: String,
    /** The agent's own status line, read immediately after the attach attempt. */
    val attachStatus: String,
) {

    /** The agent's current one-line description: readiness, count, breakpoint, errors. */
    fun status(): String = nativeStatus()

    /** Entries of the exact target method since attach. Throws when not measuring. */
    fun total(): Long {
        val value = nativeReadTotal()
        if (value < 0L) {
            throw AssertionError("the clipboard write meter is not measuring: ${nativeStatus()}")
        }
        return value
    }

    /** True while the breakpoint still stands. */
    fun breakpointInstalled(): Boolean = nativeBreakpointInstalled()

    /**
     * Close the meter and return its final count as a closed snapshot.
     *
     * Closing is real teardown, not a flag: it uses the original installation
     * JVMTI environment to disable this agent's breakpoint events and clear its
     * breakpoint, drains in-flight callbacks, and then withdraws readiness. Afterwards [total]
     * throws and [breakpointInstalled] is false, so nothing can read a "live" count
     * from a meter that is no longer installed. A write that races the close is
     * inside the returned number rather than missing from it.
     *
     * Fails closed: if the breakpoint could not be removed or events disabled, the
     * status carries the reason and this throws rather than returning a number the
     * caller might trust.
     */
    fun requestStop(): Long {
        val finalTotal = nativeRequestStop()
        if (finalTotal < 0L) {
            throw AssertionError("the clipboard write meter did not close cleanly: ${nativeStatus()}")
        }
        return finalTotal
    }

    private external fun nativeIsReady(): Boolean
    private external fun nativeReadTotal(): Long
    private external fun nativeBreakpointInstalled(): Boolean
    private external fun nativeStatus(): String
    private external fun nativeRequestStop(): Long

    companion object {

        /** Base name of the agent library, without the `lib` prefix or `.so` suffix. */
        const val AGENT_BASE_NAME: String = "prg_clipwrite_meter_agent"

        /** The one method this meter counts entries of, named for run reports. */
        const val TARGET_METHOD: String =
            "android.content.ClipboardManager.setPrimaryClip(Landroid/content/ClipData;)V"

        /** How this meter is built; named in the failure message when it is absent. */
        const val BUILD_HINT: String =
            "./gradlew -PclipMeterNdkDir=<exact-ndk-directory> :app:assembleDebugAndroidTest"

        /**
         * Attach the meter to this process.
         *
         * Every step that could make a later count untrustworthy fails here, with
         * the reason the agent itself reported: the library must exist in the TEST
         * APK's own native library directory and must not exist in the app's, the
         * process must be debuggable, the attach must not throw, and the agent must
         * say it installed its breakpoint on the exact target.
         */
        fun attach(): ClipWriteMeter {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val libraryName = System.mapLibraryName(AGENT_BASE_NAME)
            val testNativeDir = instrumentation.context.applicationInfo.nativeLibraryDir
                ?: throw AssertionError("the test APK reported no native library directory")
            val appNativeDir = instrumentation.targetContext.applicationInfo.nativeLibraryDir
            val agent = File(testNativeDir, libraryName)
            val productionCopy =
                if (appNativeDir != null && appNativeDir != testNativeDir) File(appNativeDir, libraryName) else null

            val appFlags = instrumentation.targetContext.applicationInfo.flags
            if (appFlags and ApplicationInfo.FLAG_DEBUGGABLE == 0) {
                throw AssertionError(
                    "the meter needs the debuggable test build of ${instrumentation.targetContext.packageName}; " +
                        "JVMTI attach is unavailable without it",
                )
            }
            if (productionCopy?.isFile == true) {
                throw AssertionError(
                    "the test-only meter is present in the production app's native library directory " +
                        "($productionCopy): it must be packaged into the test APK only",
                )
            }
            if (!agent.isFile) {
                throw AssertionError(
                    "missing the test-only clipboard write meter $libraryName at ${agent.absolutePath}; " +
                        "build it with $BUILD_HINT",
                )
            }

            // The framework's own precondition: Debug.attachJvmtiAgent rejects any
            // library path containing '=', because it hands ART `path + "=" + options`
            // and ART splits at the first '='. Every modern install directory is
            // base64-suffixed with '==' (`/data/app/~~<random>==/…`), so the packaged
            // path can never be passed directly. The agent therefore gets a path of
            // this test's own, with no '=', that resolves to that same file: one
            // symbolic link in the app's cache directory, removed again once the
            // agent is attached. Nothing is copied, so the counted library stays the
            // one byte for byte that the test APK ships.
            val agentSource = agent
            val link = File(instrumentation.targetContext.cacheDir, libraryName)
            try {
                Files.deleteIfExists(link.toPath())
                Files.createSymbolicLink(link.toPath(), agentSource.toPath())
            } catch (failure: Throwable) {
                throw AssertionError(
                    "could not create the '='-free agent link ${link.path} -> ${agentSource.path} " +
                        "(Debug.attachJvmtiAgent rejects install paths containing '='): $failure",
                    failure,
                )
            }
            val agentPath = link.absolutePath

            // Both the JNI library and the JVMTI agent are opened through this one
            // path, so the counter the test reads is the one the breakpoint lives in.
            try {
                System.load(agentPath)
                val meter = ClipWriteMeter(agentPath, "")
                if (meter.nativeIsReady()) {
                    // One meter per process, on purpose: a second breakpoint on the same
                    // method would count every entry twice. A second attach therefore
                    // reuses the live cumulative counter instead of arming another one.
                    return ClipWriteMeter(agentPath, "reused: ${meter.status()}")
                }
                // The framework requires the agent's class loader: this process' own,
                // which is the one that can see both the app and the test APK.
                val attachFailure = try {
                    Debug.attachJvmtiAgent(agentPath, "", ClipWriteMeter::class.java.classLoader)
                    null
                } catch (failure: Throwable) {
                    failure
                }
                val status = meter.status()
                if (attachFailure != null) {
                    throw AssertionError(
                        "Debug.attachJvmtiAgent rejected $agentPath: $attachFailure; meter status: $status",
                        attachFailure,
                    )
                }
                if (!meter.nativeIsReady()) {
                    throw AssertionError("the clipboard write meter did not become ready: $status")
                }
                return ClipWriteMeter(agentPath, status)
            } finally {
                // The mapping is established (or the attempt failed); either way the
                // link this test made is removed again.
                runCatching { Files.deleteIfExists(link.toPath()) }
            }
        }
    }
}
