// JVM check of the Android app's UI code (see README.md). Uses only Maven Central and the Gradle
// plugin portal, so it runs where Google Maven is unreachable.
pluginManagement { repositories { mavenCentral(); gradlePluginPortal() } }
dependencyResolutionManagement { repositories { mavenCentral() } }
rootProject.name = "jvm-ui"
includeBuild("../core")
