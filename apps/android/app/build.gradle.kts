import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.ksp)
}

// Optional default server for release (e.g. staging) builds, never committed:
//   ./gradlew :app:assembleRelease -PdashServerUrl=https://<your staging API host>/
// Only an https:// URL ending in "/" is accepted (release builds refuse cleartext). When it is not
// given, release builds have no default and users enter the server address in Settings.
val releaseServerUrl: String = (findProperty("dashServerUrl") as String?)?.trim().orEmpty()
require(releaseServerUrl.isEmpty() || Regex("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/([A-Za-z0-9._~-]+/)*$").matches(releaseServerUrl)) {
    "dashServerUrl must be an https:// URL ending with / (got a value that is not)"
}

// Optional Firebase Cloud Messaging client configuration for Automates push notifications, never
// committed (see docs/push-notifications.md). From -P properties or environment variables:
//   -PdashFirebaseProjectId=… -PdashFirebaseAppId=… -PdashFirebaseApiKey=… -PdashFirebaseSenderId=…
// When they are not given, the app builds and works without push: results still appear in DASH AI.
fun firebaseSetting(property: String, env: String, pattern: Regex): String {
    val value = ((findProperty(property) as String?) ?: System.getenv(env)).orEmpty().trim()
    require(value.isEmpty() || pattern.matches(value)) { "$property has an unexpected format" }
    return value
}
val firebaseProjectId = firebaseSetting("dashFirebaseProjectId", "DASH_FIREBASE_PROJECT_ID", Regex("^[a-z0-9-]{4,40}$"))
val firebaseAppId = firebaseSetting("dashFirebaseAppId", "DASH_FIREBASE_APP_ID", Regex("^1:[0-9]+:android:[0-9a-f]+$"))
val firebaseApiKey = firebaseSetting("dashFirebaseApiKey", "DASH_FIREBASE_API_KEY", Regex("^[A-Za-z0-9_-]{20,60}$"))
val firebaseSenderId = firebaseSetting("dashFirebaseSenderId", "DASH_FIREBASE_SENDER_ID", Regex("^[0-9]{6,20}$"))

android {
    namespace = "com.dashworldng.ai"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.dashworldng.ai"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Development default: the Android emulator's alias for the host machine. On a phone
        // (e.g. the Samsung A55) set your computer's LAN address in Settings → Server.
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"http://10.0.2.2:8787/\"")
        buildConfigField("String", "FIREBASE_PROJECT_ID", "\"$firebaseProjectId\"")
        buildConfigField("String", "FIREBASE_APP_ID", "\"$firebaseAppId\"")
        buildConfigField("String", "FIREBASE_API_KEY", "\"$firebaseApiKey\"")
        buildConfigField("String", "FIREBASE_SENDER_ID", "\"$firebaseSenderId\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Release builds have no default server unless -PdashServerUrl gives an HTTPS one.
            buildConfigField("String", "DEFAULT_SERVER_URL", "\"$releaseServerUrl\"")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
            // Robolectric keeps every native text layout it creates for the whole run; the UI
            // suite (Automates editor included) outgrows Gradle's 512 MB default test heap.
            all { it.maxHeapSize = "2g" }
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/previous-compilation-data.bin")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("com.dashworldng.ai:core:1.0")

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.coroutines.android)
    // Push delivery for Automates (FCM). Initialised from BuildConfig only when configured; no analytics.
    implementation(libs.firebase.messaging)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.extended)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
}

tasks.withType<Test>().configureEach {
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
        showStackTraces = true
    }
}
