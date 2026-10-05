# jvm-ui: the Android UI, compiled and tested on the JVM

The Android app module needs Google Maven (Android Gradle plugin, AndroidX). Where that repository is
unreachable, this project still checks the app's **real UI source**:

- `appSources` syncs `../app/src/main/java` into the build (minus `MainActivity`, the Application,
  Room, Keystore, DataStore and platform connectivity files) and compiles it against
  **Compose Multiplatform 1.7.3** — the same Compose 1.7 / Material 3 APIs as the app's Compose BOM.
- Android-only APIs the screens use (`LocalContext`, activity-result launchers, lifecycle,
  ViewModel factories, navigation) are replaced by small stubs in `src/main/kotlin/stubs` that keep
  the real signatures. Navigation and the ViewModel factory are minimal working implementations, so
  screens can run.
- `appTests` runs the app's Compose UI tests (`app/src/test/.../DashAiUiTest.kt`, written for
  Robolectric) on the desktop Compose test runtime.
- `shots.Screenshots` renders the main screens to PNG with the desktop Skia renderer
  (`build/screenshots`).

```bash
cd apps/android/jvm-ui
../gradlew test            # compile + UI tests + screenshots
```

What this does **not** prove: Android-specific behaviour (Room, DataStore, the Keystore, the file
picker, system back, insets on real devices, TalkBack, font rendering on Android), and anything the
stubs simplify (navigation transitions, lifecycle). Only `android.yml` (Android Gradle plugin,
Robolectric, lint, APK) and a device test cover those.
