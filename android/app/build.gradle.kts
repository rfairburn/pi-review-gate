// Android application shell: Compose UI and platform adapters only.
//
// Protocol and client state come from :client-core; nothing here may
// re-implement them. Built-in Kotlin (AGP 9) compiles this module, so no
// Kotlin Android plugin is applied.
import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The numbered CI release supplies the authoritative first-parent distance.
// Debug builds retain their existing 1 / 0.1.0 defaults.
val releaseNumberText = providers.gradleProperty("releaseNumber").orNull
val releaseNumber = releaseNumberText?.let {
    require(it.matches(Regex("[1-9][0-9]*"))) { "releaseNumber must be a positive canonical integer" }
    val number = it.toLongOrNull()
    require(number != null && number in 1..2100000000L) { "releaseNumber must be in 1..2100000000" }
    number.toInt()
}
gradle.taskGraph.whenReady {
    if (System.getenv("CI") == "true" && allTasks.any { it.project.path == ":app" && it.name.contains("release", ignoreCase = true) }) {
        require(releaseNumber != null) { "CI release requires explicit -PreleaseNumber=N" }
    }
}

android {
    namespace = "io.github.rfairburn.pireviewgate"
    compileSdk = 37

    // Only SDK Build Tools 37.0.0 is installed locally; pin it so the build
    // never reaches for another SDK package.
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "io.github.rfairburn.pireviewgate"
        minSdk = 33
        targetSdk = 37
        versionCode = releaseNumber ?: 1
        versionName = releaseNumber?.let { "0.1.0+$it" } ?: "0.1.0"
        // Android-instrumented verification only. The runner and its dependencies
        // stay in the test APK; the production app ships neither.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    buildFeatures {
        compose = true
    }
}

// ---------------------------------------------------------------------------
// Test-only clipboard-write meter (JVMTI agent).
//
// The agent source lives under src/androidTest and the compiled library is
// packaged into the instrumented test APK only — never into the app APK, never
// into a release, never into a shipped file. It counts entries of the exact SDK
// setter android.content.ClipboardManager.setPrimaryClip, so an acceptance run
// can tell real clipboard writes apart from the listener notifications those
// writes cause.
//
// Native compilation and library wiring are configured only when the operator
// names an exact NDK directory, so ordinary production, release, unit, and CI
// builds gain no NDK requirement and no native step:
//
//   ./gradlew -PclipMeterNdkDir=/absolute/path/to/ndk/<version> \
//       :app:assembleDebugAndroidTest
//
// A test APK built without it simply carries no meter, and every test that needs
// one fails closed naming this flag instead of reporting a zero count.
// ---------------------------------------------------------------------------
val clipMeterLibraryBaseName = "prg_clipwrite_meter_agent"
val clipMeterNdkDir = providers.gradleProperty("clipMeterNdkDir").orNull
if (clipMeterNdkDir != null) {
    val ndkDir = file(clipMeterNdkDir)
    val hostTag = when {
        System.getProperty("os.name").contains("Mac", ignoreCase = true) -> "darwin-x86_64"
        System.getProperty("os.name").contains("Linux", ignoreCase = true) -> "linux-x86_64"
        else -> error(
            "the clipboard-write meter build has no toolchain path for os.name=" +
                System.getProperty("os.name"),
        )
    }
    val meterClang = File(ndkDir, "toolchains/llvm/prebuilt/$hostTag/bin/clang++")
    if (!meterClang.isFile) {
        error(
            "no NDK C++ compiler at ${meterClang.path}: -PclipMeterNdkDir must name one exact NDK " +
                "directory containing source.properties and toolchains/llvm/prebuilt/<host>/bin",
        )
    }
    val meterJvmtiInclude = File(
        System.getenv("JAVA_HOME")
            ?: error("JAVA_HOME must name the JDK whose include/jvmti.h the meter builds against"),
        "include",
    )
    if (!File(meterJvmtiInclude, "jvmti.h").isFile) {
        error("no jvmti.h under ${meterJvmtiInclude.path}: the NDK ships none, so JAVA_HOME must name a JDK that does")
    }
    val meterSource = file("src/androidTest/native/$clipMeterLibraryBaseName.cpp")
    if (!meterSource.isFile) error("missing meter source ${meterSource.path}")
    // Only ABIs this task actually compiles are listed; an emulator on any other
    // ABI fails closed in ClipWriteMeter rather than measuring nothing.
    val meterAbis = mapOf(
        "arm64-v8a" to "aarch64-linux-android",
        "x86_64" to "x86_64-linux-android",
    )
    // A plain directory, not a Provider: the Android source-set API refuses
    // Providers because it cannot tell generated from static content. The task
    // dependency is wired explicitly below instead.
    val meterJniLibsDir = File(layout.buildDirectory.get().asFile, "clipMeter/jniLibs")
    val meterTargetApi: Int = android.defaultConfig.minSdk
        ?: error("the clipboard-write meter needs an explicit minSdk to target")
    // One compile task per ABI, so each library carries its own inputs and
    // outputs and a stale object cannot be reused for another target.
    val meterCompileTasks = meterAbis.map { (abi, triple) ->
        val outDir = File(meterJniLibsDir, abi)
        val out = File(outDir, "lib$clipMeterLibraryBaseName.so")
        tasks.register<Exec>("compileClipWriteMeterAgentFor${abi.replace("-", "")}") {
            group = "verification"
            description = "Compile the test-only clipboard-write JVMTI agent for $abi."
            workingDir = projectDir
            inputs.file(meterSource)
            inputs.property("ndkDir", ndkDir.absolutePath)
            inputs.property("jvmtiInclude", meterJvmtiInclude.absolutePath)
            inputs.property("abi", abi)
            inputs.property("targetApi", meterTargetApi)
            outputs.dir(outDir)
            commandLine(
                meterClang.absolutePath,
                "--target=$triple$meterTargetApi",
                "-fPIC",
                "-shared",
                "-std=c++17",
                "-O2",
                "-Wall",
                "-Wextra",
                "-fno-exceptions",
                "-fno-rtti",
                // Statically link the C++ runtime: the test APK carries no
                // libc++_shared.so, and a shared dependency here would only be
                // satisfiable by shipping another library nobody asked for.
                "-static-libstdc++",
                // The NDK's own <jni.h> is the JNI ABI here. OpenJDK's jvmti.h starts
                // with `#include "jni.h"`, which would otherwise find the OpenJDK copy
                // sitting next to it and then a host jni_md.h that does not exist for an
                // Android target: defining that copy's include guard keeps the platform
                // header in charge. No third-party header is copied into this repository.
                "-D_JAVASOFT_JNI_H_",
                // Searched only after the NDK sysroot, so <jvmti.h> resolves while
                // <jni.h> still comes from the NDK.
                "-idirafter",
                meterJvmtiInclude.absolutePath,
                "-o",
                out.absolutePath,
                meterSource.absolutePath,
                "-llog",
            )
            doLast {
                if (!out.isFile) error("the meter compile for $abi produced no ${out.path}")
            }
        }
    }
    @Suppress("DEPRECATION")
    android.sourceSets.getByName("androidTest").jniLibs.srcDir(meterJniLibsDir)
    tasks.configureEach {
        if (name == "mergeDebugAndroidTestJniLibFolders") dependsOn(meterCompileTasks)
    }
}

// Only the test APK extracts native libraries for the agent's absolute-path attach.
// Keep this consistent with its manifest even when the optional meter is absent;
// ordinary Android test builds must still package without an NDK. The variant API
// exposes a mutable Property for this test component, leaving app packaging alone.
androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.androidTest?.packaging?.jniLibs?.useLegacyPackaging?.set(true)
    }
}

dependencies {
    implementation(project(":client-core"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    implementation(platform("androidx.compose:compose-bom:2026.09.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")

    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("androidx.core:core-ktx:1.19.1")

    // Instrumented checks for the landed platform storage/identity adapters and
    // the real transport against a synthetic peer host. Test-only, exact stable
    // versions.
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    // Align Espresso with runner 1.7 instead of
    // Compose's transitive 3.5.0, which reflects a removed API on Android 17.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation(platform("androidx.compose:compose-bom:2026.09.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
}
