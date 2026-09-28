pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "dash-ai-android"

// Pure-Kotlin domain, networking and demo logic. It is a separate build so it can be compiled and
// tested without Google's Android repositories: `cd core && ../gradlew test`.
includeBuild("core")

include(":app")
