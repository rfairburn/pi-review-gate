// Android workspace for the Pi Review Gate phone client.
//
// :client-core is a plain Kotlin/JVM module holding the host protocol wire types
// and client state, with no Android dependency. :app is the Android/Compose
// shell that adapts that core to the platform. The phone is a client only: it
// hosts no Pi process, worker, server, or gateway.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    @Suppress("UnstableApiUsage")
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "pi-review-gate-android"

include(":app")
include(":client-core")

// Isolated test-only UID and graph; absent from normal app/release composition.
if (providers.gradleProperty("peerAcceptance").orNull == "true") {
    include(":peer-acceptance")
}
