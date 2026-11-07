// Platform-independent client core.
//
// Host protocol wire metadata and client-side session/host state belong here so
// they stay free of Android types and testable off-device. Coroutines drive the
// concurrent host connections; kotlinx.serialization backs the strict DTOs.
// This module must never depend on :app or on any Android artifact.
plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.kotlin.plugin.serialization")
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

dependencies {
    api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")

    // Off-device unit verification of the durable configuration and trust seams.
    // JUnit 4 is the framework the JVM test task resolves by default.
    testImplementation(kotlin("test-junit"))
    testImplementation("junit:junit:4.13.2")

    // Virtual time for the bounded automatic-reconnect schedule, so a finite
    // six-step ladder is checked in microseconds instead of real minutes.
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
}

val testIoScheduling by tasks.registering(Test::class) {
    testClassesDirs = sourceSets["test"].output.classesDirs
    classpath = sourceSets["test"].runtimeClasspath
    dependsOn(tasks.named("testClasses"))
    filter {
        includeTestsMatching("io.github.rfairburn.pireviewgate.core.transport.PeerIoSchedulingTest")
    }
    // Set only in this child JVM, before coroutine dispatchers initialize.
    systemProperty("kotlinx.coroutines.io.parallelism", "4")
}

tasks.named<Test>("test") {
    dependsOn(testIoScheduling)
    filter {
        excludeTestsMatching("io.github.rfairburn.pireviewgate.core.transport.PeerIoSchedulingTest")
    }
}
