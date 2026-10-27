# Not Google Photos for Android

Capacitor shell for the phone. The web UI here is a stand-in that exercises `@ngp/photo-sync` until the main app is bundled in its place. Backup itself is native: the page only shows status and sends commands.

## Run the page

```bash
pnpm --filter @ngp/mobile dev
```

Opens at <http://127.0.0.1:43123>. In a browser the queue stays empty and actions that need the phone report that backup runs in the Android app.

## Debug APK

```bash
pnpm --filter @ngp/photo-sync build
pnpm --filter @ngp/mobile build
pnpm --filter @ngp/mobile exec cap sync android
cd apps/mobile/android && ./gradlew assembleDebug
```

The APK is `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

The app id is `com.notgooglephotos.app`. Notification taps use `ngphotos://app/<web route>`. Cleartext to a home server is allowed; an away-from-home address still has to be HTTPS.
