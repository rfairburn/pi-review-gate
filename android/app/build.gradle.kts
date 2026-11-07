// Android application shell: Compose UI and platform adapters only.
//
// Protocol and client state come from :client-core; nothing here may
// re-implement them. Built-in Kotlin (AGP 9) compiles this module, so no
// Kotlin Android plugin is applied.
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
