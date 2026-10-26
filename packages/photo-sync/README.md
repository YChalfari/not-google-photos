# @ngp/photo-sync

Android backup engine for Not Google Photos, packaged as a Capacitor plugin. The phone scans MediaStore, keeps a Room queue, and uploads originals to the self-hosted server. iOS is the same TypeScript contract with no native implementation yet.

The Capacitor app that bundles this plugin is `apps/mobile`.

## Develop

From the repo root (pnpm workspace):

```bash
pnpm install
pnpm --filter @ngp/photo-sync build
pnpm --filter @ngp/photo-sync test:android
```

Unit tests need Android SDK 36 and Java 21 (`ANDROID_HOME`). They run on the JVM with Robolectric and a mock server. `pnpm --filter @ngp/photo-sync build:android-tests` builds the on-device tests in `android/src/androidTest`.

`pnpm build` writes `dist/` and an API dump at `dist/docs.json`. The public contract is `src/definitions.ts`.

## What the phone does

- Reads photos and videos (including Android 14 selected-photos mode) and the original GPS via `ACCESS_MEDIA_LOCATION` and `setRequireOriginal`.
- Scans incrementally with MediaStore generation numbers. Folder ids such as `DCIM/` include their subfolders.
- Hashes each file once (SHA-1), asks the server which checksums it already has, and streams the missing originals with OkHttp. There is no retry loop: an unreachable server waits for the next natural moment, and a mid-upload failure pauses uploads from 30 minutes up to 6 hours.
- Schedules backup with WorkManager: new media (debounce and a max delay), an interval, times of day, a daily reconcile, a manual run, and the first full backup as a foreground job on unmetered Wi-Fi while charging.
- Shows one end-of-day reminder and schedules memory notifications. Taps open `ngphotos://app/backup` or `ngphotos://app/memories/<id>`.

Plain HTTP is accepted only for private-network hosts. The app's network security config has to allow cleartext; the plugin does not force that on every consumer.

Free up space (`getFreeableSummary`, `freeUpSpace`) is not implemented yet.
