# Deploying DabbaTrack

This guide puts the API and web app on a server with HTTPS, then builds the Android app pointing at it.

```
phones (Android app, PWA)  --HTTPS-->  Caddy (TLS, :443)  --HTTP-->  DabbaTrack API (:8080)  -->  SQLite file in /data
```

- **Server:** one Linux VPS with Docker (1 vCPU, 1 GB RAM is plenty for one kitchen).
- **Domain:** e.g. `tiffin.example.com`, with an `A` record pointing at the server's IP.
- **Run one API container only.** SQLite and the login rate limiter live in that one process.

---

## 1. First deploy

On the server:

```bash
git clone <your repo> /opt/dabbatrack && cd /opt/dabbatrack
cp .env.example .env
nano .env        # set PROVIDER_PIN (4-8 digits, not 0000) and DOMAIN; keep TZ=Asia/Kolkata
docker compose up -d --build
docker compose logs -f api
```

The log should show these lines:

```
INFO dabbatrack: DabbaTrack API + PWA listening on 0.0.0.0:8080 ...
INFO dabbatrack: Database: /data/tiffin.db
INFO dabbatrack: Server time zone: IST +0530 ...
```

If you see `Server clock is UTC and TZ is not set`, fix `TZ` in `.env`. Otherwise every meal cutoff fires 5½ hours late.

Then open `https://<DOMAIN>/api/health`. It should return `{"ok": true, ...}`, and `https://<DOMAIN>` should show the provider login.

### Moving your existing `tiffin.db` onto the server (optional)

Only do this if you want to keep the data you already have. **Your current file contains the 3 demo customers, whose PINs are public**, so starting fresh is usually better.

```bash
python backup.py                        # on your PC: makes a clean single-file copy in backups/
scp backups/tiffin-*.db server:/opt/dabbatrack/import.db
docker compose stop api
docker compose cp import.db api:/data/tiffin.db
docker compose start api
```

---

## 2. First-day checklist

- [ ] **Provider PIN.** Sign in with the `PROVIDER_PIN` from `.env`, then change it under **Settings → Change provider PIN**. Use 6–8 digits. The saved PIN takes over from `.env`.
- [ ] **Customer PINs.** If you imported old data, tap **Reset PIN** for every customer and share the new PINs. Old PINs were readable before the security fixes.
- [ ] **New QR.** Tap **New QR** once and print or show the new code.
- [ ] **No demo data.** `DEMO_MODE=0`, and no demo customers (Aarav / Priya / Rohan, phones 98765 43210, 98765 01234, 98111 22233) are in the customer list.
- [ ] **Backups.** Set up section 3 now, not later.
- [ ] **CORS.** Optionally set `CORS_ALLOW_ORIGIN=https://<DOMAIN>` in `.env`, then run `docker compose up -d`.

---

## 3. Backups (do not skip)

`backup.py` takes a consistent snapshot while the server is running. It checks the copy, keeps the newest `BACKUP_KEEP` (default 14), and only deletes files it created itself.

**Daily at 02:00** (`crontab -e` on the server):

```cron
0 2 * * * cd /opt/dabbatrack && docker compose exec -T api python backup.py >> /var/log/dabbatrack-backup.log 2>&1
```

**Copy backups off the server.** A backup on the same disk doesn't survive losing the server. For example, with rclone to any cloud drive:

```cron
30 2 * * * docker run --rm -v dabbatrack_dabba-data:/data:ro -v /root/.config/rclone:/config/rclone rclone/rclone copy /data/backups remote:dabbatrack-backups
```

The volume name may differ; check `docker volume ls`.

**Test a restore once:**

```bash
docker compose exec api ls /data/backups
docker compose stop api
docker compose run --rm --entrypoint sh api -c "cp /data/backups/tiffin-YYYYmmdd-HHMMSS.db /data/tiffin.db && rm -f /data/tiffin.db-wal /data/tiffin.db-shm"
docker compose start api
```

Never copy `tiffin.db` with `cp` while the server is running. In WAL mode, recent writes live in `tiffin.db-wal`, and a plain copy can miss them or be corrupt. Always use `backup.py`.

---

## 4. Updating

```bash
cd /opt/dabbatrack && git pull
python backup.py   # or: docker compose exec api python backup.py
docker compose up -d --build
```

`docker stop` sends SIGTERM. The server stops accepting new requests, finishes the ones in flight (up to 30 s; compose allows 40 s), then exits. Database upgrades run automatically at startup.

**Logs:** `docker compose logs -f api`. Errors come with full tracebacks. Clients only ever see "Something went wrong on the server".

---

## 5. Android app

One-time setup, on your PC in `mobile/`:

```bash
npm install -g eas-cli
eas login
eas init                                   # adds the EAS projectId (needed for push)
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://<DOMAIN> --visibility plaintext
eas env:create --environment preview    --name EXPO_PUBLIC_API_URL --value https://<DOMAIN> --visibility plaintext
eas credentials                            # Android → Google Service Account → FCM V1 key (for push)
```

Build:

```bash
eas build -p android --profile preview      # APK to install directly / test with real users
eas build -p android --profile production   # AAB for Google Play (blocks plain http://)
eas submit -p android --profile production  # uploads to the Play "internal" track
```

**A production build fails on purpose** if `EXPO_PUBLIC_API_URL` isn't an `https://` URL.

**Before release, test on a real phone:**
1. Sign in as provider and as a customer.
2. Scan the QR.
3. Send a meal prompt and tap the notification.
4. Turn on airplane mode and check the error message.
5. Reset a customer's PIN and confirm their phone is signed out.

---

## 6. Without Docker (systemd)

Python 3.13+ (tested on 3.13 and 3.15) with no packages to install. You still need an HTTPS reverse proxy in front: Caddy, nginx, or your host's load balancer.

```ini
# /etc/systemd/system/dabbatrack.service
[Service]
WorkingDirectory=/opt/dabbatrack
EnvironmentFile=/opt/dabbatrack/.env
ExecStart=/usr/bin/python3 server.py
User=dabbatrack
Restart=on-failure
KillSignal=SIGTERM
TimeoutStopSec=40

[Install]
WantedBy=multi-user.target
```

Set `HOST=127.0.0.1` so only the proxy can reach the server. Set `TRUST_PROXY=1` only when a proxy is in front. Point `DB_PATH` and `BACKUP_DIR` at a data folder outside the code.

---

## 7. Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PROVIDER_PIN` | (none) | **Required** until a PIN is saved in the app. 4–8 digits, not 0000. |
| `TZ` | system | Business time zone. `Asia/Kolkata` in Docker. |
| `DB_PATH` | `./tiffin.db` | `/data/tiffin.db` in Docker. |
| `BACKUP_DIR` / `BACKUP_KEEP` | `backups` / `14` | Used by `backup.py`. |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | `0.0.0.0` in Docker. |
| `TRUST_PROXY` | `0` | `1` only behind your own reverse proxy (it reads `X-Forwarded-For`). |
| `CORS_ALLOW_ORIGIN` | `*` | Can be your own `https://` origin. |
| `AUTO_PROMPT_LEAD_MINUTES` | `0` | Send meal prompts automatically N minutes before each cutoff. |
| `EXPO_ACCESS_TOKEN` | (none) | **Secret.** Only for Expo "enhanced push security". |
| `LOG_LEVEL` | `INFO` | `DEBUG` / `INFO` / `WARNING`. |
| `DEMO_MODE` | `0` | Never `1` with real customers. |

**Secrets:** `.env` (the provider PIN, plus `EXPO_ACCESS_TOKEN` if you use it). `.env` is git-ignored; never commit it. Nothing secret is built into the app or the code.
