# Android screens (desktop renders)

These images are the app's **real Compose code** rendered by Compose Multiplatform's desktop Skia
renderer (`apps/android/jvm-ui`, test `shots.Screenshots`) at 411 × 891 dp, density 2.625, with
sample data. They are **not** screenshots from an Android device or emulator: fonts are the JVM's
default sans-serif and serif (Android uses Roboto / Noto Serif), and system bars are not drawn.
Regenerate with `cd apps/android/jvm-ui && ../gradlew test` (output in `build/screenshots`).
