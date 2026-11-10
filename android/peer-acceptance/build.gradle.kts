// Opt-in instrumentation fixture, never part of :app or its release graph.
// AGP 9 built-in Kotlin compiles the existing adapters directly, unchanged.
plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.rfairburn.pireviewgate.acceptance"
    compileSdk = 37
    buildToolsVersion = "37.0.0"
    defaultConfig {
        applicationId = "io.github.rfairburn.pireviewgate.acceptance"
        minSdk = 33
        targetSdk = 37
        versionCode = 1
        versionName = "1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    sourceSets.getByName("main").kotlin.directories.add(
        project(":app").file("src/main/kotlin/io/github/rfairburn/pireviewgate/storage").path,
    )
}

dependencies {
    implementation(project(":client-core"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")
    implementation("androidx.activity:activity-ktx:1.13.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
}
