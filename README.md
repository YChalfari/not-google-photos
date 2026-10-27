# Not Google Photos

A self-hosted photo library for one household. Photos stay on a machine you control. Each person has their own account. Phones sign in by scanning a pairing code, and identical files are stored once even when two people both have them.

Accounts, invites, sessions, device tokens, content-addressed storage, uploads, thumbnails, and the timeline are in place. Face grouping, albums, search, and memories are described in `GET /api/openapi.json` and answer **501** until their handlers exist.

## Run it on this computer

You need Node.js 22 and pnpm 10. Postgres is provided by Docker.

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm seed
pnpm dev
```

- App: http://127.0.0.1:4811
- API: http://127.0.0.1:4810
- Sample accounts after `pnpm seed`: `alex@example.com` (admin) and `sam@example.com` (member), password `seed-library`. They share an album called Weekends together. `pnpm seed --reset` rebuilds that library.

`pnpm dev` runs the API and the web app with reload. The web dev server proxies `/api` so the session cookie stays on one origin.

The library folder defaults to `data/library`. The server claims it by writing `.ngp-library.json`. If that file disappears (the external drive is unplugged, or `LIBRARY_DIR` points at the wrong place), uploads stop instead of filling the internal disk.

## Run it on a MacBook with Docker

Images are multi-arch. Docker Desktop on Apple Silicon pulls the arm64 builds. In Docker Desktop, turn on **Start Docker Desktop when you sign in**.

```bash
cp .env.example .env
# Set HOME_URL=http://<this-mac-on-wifi>:4810 so phones can find the server.
./infra/mac/setup.sh
```

`setup.sh` creates the library folder (by default `~/Pictures/NotGooglePhotos`), starts Postgres, the API, and the web app, and installs two launchd agents:

- **Bonjour.** Docker on a Mac cannot broadcast on the home network. `infra/mac/announce.sh` registers `_ngp._tcp` from the host with the server id, name, and port. Phones match the id after the Mac's IP changes. Reserving the Mac's address in the router is the fallback.
- **Backup.** Every day at 03:15, `infra/mac/backup-db.sh` writes a gzipped `pg_dump` into `<library>/backups` and keeps 14 days. Point Time Machine at the library folder and both the photos and the database are covered.

Without the Mac helpers:

```bash
./infra/compose.sh up -d --build
./infra/compose.sh logs -f
./infra/compose.sh down
```

`compose.sh` refuses to start when `LIBRARY_DIR` is an absolute path that does not exist, so an unplugged drive does not become a new folder on the internal disk.

The ML service is off unless you ask for it. It is a FastAPI process with a model cache and no models yet:

```bash
./infra/compose.sh --profile ml up -d --build
```

Set `ML_URL=http://ml:8090` in `.env` when the server should talk to that container. On a Mac, the first backlog is faster outside Docker with ONNX Runtime's CoreML provider. See the comment at the top of `apps/ml/app/main.py`.

## Away from home

The app stores two addresses and prefers the home one when it answers.

**Tailscale.** Install Tailscale on the Mac and on each phone. The Mac gets a stable address such as `http://100.x.y.z:4810` or a MagicDNS name. Put that in **Admin → Remote address** (or `REMOTE_URL`). Traffic stays inside your tailnet. Nothing is published on the internet. Phones need the Tailscale app.

**Cloudflare Tunnel.** `cloudflared` on the Mac publishes `https://photos.example.com` with no port forwarding and nothing to install on the phones. Set that as the remote address and set `TRUST_PROXY=true` so the server honors `X-Forwarded-*`. The server is then reachable from the whole internet, so keep it updated, leave the default session cookie and device-token auth in place, and do not turn on public share links until that exists as its own piece. Prefer Tailscale unless phones that cannot install Tailscale need access.

Either way, pairing codes include both addresses. On the home network the phone uses the home one, including after it learns a new IP from Bonjour.

## The phone

The Android app is the web app in a Capacitor shell, plus the native backup engine. Browsers sign in with the session cookie. The installed app is served from `http://localhost`, so it uses the device token from pairing instead.

A push to `main` publishes a signed APK to a GitHub Release. Install and update it with Obtainium. The one-time keystore and phone setup are in `apps/mobile/README.md`.

## Checks

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Server tests run against Postgres with pgvector (`pnpm db:up`). Each test file gets its own database cloned from a migrated template.

## Layout

| Path              | What it is                                             |
| ----------------- | ------------------------------------------------------ |
| `apps/server`     | Hono API, Drizzle migrations, pg-boss, storage         |
| `apps/web`        | The React app, in a browser and inside the Android app |
| `apps/mobile`     | Capacitor shell that bundles the web app and backup    |
| `apps/ml`         | Python ML service skeleton                             |
| `packages/shared` | Zod API contract used by the server and the web app    |
| `infra`           | Docker Compose and the Mac launchd helpers             |

Add an endpoint by defining it in `packages/shared` and implementing it in `apps/server/src/routes`. Until a handler is registered, the route returns 501. The contract is the source for OpenAPI.
