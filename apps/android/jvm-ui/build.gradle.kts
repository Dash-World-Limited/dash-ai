import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.1.0"
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0"
}

java { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_17) } }

// Compose Multiplatform 1.7.3 ships the same Compose 1.7 APIs as the app's Compose BOM 2024.12.01.
val cmp = "1.7.3"
val appSrc = file("../app/src")

/** The real app sources, minus the files that need Android-only libraries (stubbed in src/main/kotlin/stubs). */
val appSources = tasks.register<Sync>("appSources") {
    from("$appSrc/main/java") {
        exclude(
            "com/dashworldng/ai/MainActivity.kt",
            "com/dashworldng/ai/DashAiApplication.kt",
            "com/dashworldng/ai/data/local/**",
            "com/dashworldng/ai/data/security/TokenStore.kt",
            "com/dashworldng/ai/data/Platform.kt",
            "com/dashworldng/ai/data/share/**",
            "com/dashworldng/ai/data/push/**",
            "com/dashworldng/ai/data/settings/DataStoreSettings.kt",
        )
    }
    into(layout.buildDirectory.dir("app-src"))
}

/** An R class generated from the real res/ directory, so a missing resource fails here too. */
val rClass = tasks.register("rClass") {
    val res = file("$appSrc/main/res")
    val outDir = layout.buildDirectory.dir("r-src")
    inputs.dir(res)
    outputs.dir(outDir)
    doLast {
        val drawables = res.listFiles { f -> f.name.startsWith("drawable") }.orEmpty().flatMap { it.listFiles().orEmpty().toList() }
            .map { it.name.substringBefore('.') }.toSortedSet()
        val strings = res.listFiles { f -> f.name.startsWith("values") }.orEmpty().mapNotNull { File(it, "strings.xml").takeIf(File::exists) }
            .flatMap { Regex("<string name=\"([a-z_0-9]+)\"").findAll(it.readText()).map { m -> m.groupValues[1] }.toList() }.toSortedSet()
        // Drawables get distinct ids and a name table, so the desktop painterResource stub can load
        // the real vector XML (see src/main/kotlin/stubs/Resources.kt).
        val ids = drawables.withIndex().associate { (i, name) -> name to i + 1 }
        File(outDir.get().asFile, "com/dashworldng/ai/R.kt").apply { parentFile.mkdirs() }.writeText(
            "package com.dashworldng.ai\nobject R {\n  object drawable {\n" + ids.entries.joinToString("") { "    const val ${it.key} = ${it.value}\n" } +
                "  }\n  object string {\n" + strings.joinToString("") { "    const val $it = 0\n" } + "  }\n}\n" +
                "object DesktopResources {\n  val drawableDir = \"" + File(res, "drawable").absolutePath.replace("\\", "/") + "\"\n" +
                "  val drawables = mapOf(" + ids.entries.joinToString(", ") { "${it.value} to \"${it.key}\"" } + ")\n}\n",
        )
    }
}

/** The app's Compose UI tests (Robolectric on Android), run here on the desktop test runtime. */
val appTests = tasks.register<Sync>("appTests") {
    // PushUiTest runs under Robolectric only: it starts on Home, which this software renderer draws too slowly.
    from("$appSrc/test/java") { include("com/dashworldng/ai/DashAiUiTest.kt") }
    into(layout.buildDirectory.dir("app-test-src"))
}

sourceSets {
    main { kotlin.srcDirs(appSources, rClass, "src/main/kotlin") }
    test { kotlin.srcDirs(appTests, "src/test/kotlin") }
}

dependencies {
    implementation("com.dashworldng.ai:core:1.0")
    implementation("org.jetbrains.compose.ui:ui-desktop:$cmp")
    implementation("org.jetbrains.compose.foundation:foundation-desktop:$cmp")
    implementation("org.jetbrains.compose.material3:material3-desktop:$cmp")
    implementation("org.jetbrains.compose.material:material-icons-extended-desktop:$cmp")
    implementation("org.jetbrains.compose.animation:animation-desktop:$cmp")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    testImplementation("org.jetbrains.compose.ui:ui-test-junit4-desktop:$cmp")
    testImplementation("org.jetbrains.skiko:skiko-awt-runtime-linux-x64:0.8.18")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-swing:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.1.0")
    // androidx.collection (Google Maven only) backs the Compose runtime; JetBrains published the same classes here.
    testRuntimeOnly("org.jetbrains.compose.collection-internal:collection-desktop:1.6.0-beta02") { isTransitive = false }
}

// The JetBrains artifacts relocate a few small JVM libraries to Google Maven (unreachable here);
// the app's use of lifecycle/navigation is covered by the stubs instead.
configurations.all {
    exclude(group = "androidx.collection")
    exclude(group = "androidx.annotation")
    exclude(group = "androidx.arch.core")
    exclude(group = "androidx.lifecycle")
}

tasks.test {
    systemProperty("java.awt.headless", "true")
    systemProperty("skiko.renderApi", "SOFTWARE")
    systemProperty("shots.dir", layout.buildDirectory.dir("screenshots").get().asFile.path)
    testLogging { events("failed"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}
