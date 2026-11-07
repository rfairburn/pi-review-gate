// Durable build foundation for the Android client.
//
// Stable toolchain set, resolved against official plugin metadata:
//   Gradle 9.6.1           wrapper distribution, SHA-256 pinned in
//                          gradle/wrapper/gradle-wrapper.properties
//   Android Gradle plugin 9.3.1  stable; supports compileSdk/API 37; requires
//                          Gradle >= 9.5.0, SDK Build Tools >= 36.0.0, JDK >= 17
//   Kotlin 2.4.21          stable Kotlin Gradle plugin; documented range
//                          Gradle 7.6.3-9.7.0 and AGP 8.5.2-9.3.1
//   Compose BOM 2026.09.00 Material 3 1.4.0, Compose UI 1.12.1
//
// AGP 9 supplies built-in Kotlin support, so the Android module does not apply
// org.jetbrains.kotlin.android (incompatible with the AGP 9 DSL). The Compose
// compiler and serialization plugins are the Kotlin version, so a single Kotlin
// Gradle plugin version serves both modules.
plugins {
    id("com.android.application") version "9.3.1" apply false
    id("org.jetbrains.kotlin.jvm") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21" apply false
}
