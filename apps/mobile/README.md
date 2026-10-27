# Not Google Photos for Android

Capacitor shell around the web app. The page is the production build of `@ngp/web`. Backup stays native: the Backup screen talks to `@ngp/photo-sync`, which scans the camera roll and uploads in the background.

In a browser, the same UI signs in with the session cookie. Inside the installed app the page is `http://localhost`, so it calls the server with the device token from pairing instead. The scheme is http because the WebView blocks photos and video from an https page to an http home server.

## Debug build

```bash
pnpm --filter @ngp/web build
pnpm --filter @ngp/mobile exec cap sync android
cd apps/mobile/android && ./gradlew assembleDebug
```

The APK is `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

The app id is `com.notgooglephotos.app`. Notification taps use `ngphotos://app/<web route>`. Cleartext to a home server is allowed; an away-from-home address still has to be HTTPS.

To work on the UI without rebuilding the web bundle, point the WebView at the Vite server. That address is copied into the Android project by `cap sync`, so run sync again without the variable before a release build. GitHub Actions sets `CI`, which ignores the variable.

```bash
pnpm --filter @ngp/web dev
CAP_SERVER_URL=http://<this-computer-on-wifi>:4811 pnpm --filter @ngp/mobile exec cap sync android
```

A WebView loaded that way uses the dev server's proxied `/api` and the browser sign-in. The installed release uses the device token.

## Updates on the phone

Pushes to `main` that touch the web app, the shell, or the backup engine build a signed APK and attach it to a GitHub Release as `app-release.apk`. Android will update in place only when every build is signed with the same key and each `versionCode` is higher than the one installed. The workflow takes the code from the GitHub run number.

Create the key once, on your computer, and do not commit it:

```bash
keytool -genkeypair -v \
  -keystore ngp-release.keystore \
  -alias ngp \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -i ngp-release.keystore | pbcopy
```

Add these repository secrets (Settings → Secrets and variables → Actions):

| Secret                      | Value                                            |
| --------------------------- | ------------------------------------------------ |
| `ANDROID_KEYSTORE_BASE64`   | The keystore from the command above              |
| `ANDROID_KEYSTORE_PASSWORD` | The store password you chose                     |
| `ANDROID_KEY_ALIAS`         | `ngp`, or whatever alias you passed to `keytool` |
| `ANDROID_KEY_PASSWORD`      | The key password you chose                       |

The next push to `main` publishes the release. Until the secrets exist, the workflow stops before it builds an unsigned APK.

On the phone:

1. Install [Obtainium](https://github.com/ImranR98/Obtainium).
2. Open Obtainium's settings, then GitHub, and add a fine-grained personal access token that can read this private repository's contents.
3. Add an app with the repository URL `https://github.com/<owner>/<repo>`.
4. Set the APK filter to `app-release\.apk` if Obtainium does not select that asset on its own.
5. Install, and leave Obtainium's background checks on.

Each new release shows the system install dialog. Stock Android does not install it silently. Keep the same keystore: a new one makes Android treat the APK as a different app.
