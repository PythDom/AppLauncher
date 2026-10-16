# AppLauncher

A light Android launcher.

- On first run it lists every installed app, unsorted. No predefined categories.
- Swipe left/right: a second screen for rarely used apps.
- Optional AI sorting: Claude API or any OpenAI-compatible server (Ollama, LM Studio...). Only app names and package names are sent.
- Manage everything by hand: long-press an app or a category header (rename, move, merge, delete, change category, move to the other screen, hide). `＋` adds categories and web shortcuts.
- Works offline: the UI is bundled in the APK. State is a private file in the app's storage.

## Layout

- `web/` — the whole UI (HTML/JS, no dependencies). `mock.js` fakes the phone so `web/` also runs in a desktop browser.
- `android/` — thin Java WebView shell (app list, launch, icons, storage, AI HTTP calls, home-screen role).
- `.github/workflows/android.yml` — builds and signs the APK and publishes it to the `latest` release.

## Install

Download `applauncher.apk` from the Releases page, allow "install unknown apps", install. Optionally set it as the home app in Android Settings.
