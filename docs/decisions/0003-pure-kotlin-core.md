# ADR 0003 — Pure-Kotlin core as an included build

**Status:** accepted

**Context.** Google's Android repositories may be unavailable in some build environments, but the
chat logic must be tested thoroughly.

**Decision.** Everything that does not need Android lives in `apps/android/core`, a separate Gradle
build (Kotlin JVM, Maven Central only) included by the Android build. The full Android build,
Robolectric Compose UI tests and lint run in GitHub Actions, which also produces the APK.

**Consequences.** Core logic is fast to test anywhere; the Android module stays thin.
