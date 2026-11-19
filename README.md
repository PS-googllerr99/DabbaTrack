# DabbaTrack

A subscription and delivery manager for home tiffin (dabba) kitchens. One provider runs the kitchen; customers on monthly meal plans confirm or skip each meal, pause for vacations, and prove delivery by scanning a QR code.

DabbaTrack has three parts that share one API:

- **Backend:** a Python REST API built only on the standard library (`http.server`, `sqlite3`), with no web framework.
- **Web app:** an installable PWA with offline caching, served by the same server.
- **Mobile app:** React Native + Expo (TypeScript), one app with separate provider and customer flows.

```
Android app / PWA  ──HTTPS──▶  Caddy (TLS)  ──▶  Python API (:8080)  ──▶  SQLite (WAL)
                                                       │
                                                       └──▶  Expo Push API ──▶ FCM / APNs
```

## Features

**For customers**
- Plan card showing meals left and the projected end date.
- Daily menu prompt: confirm **Yes** or **Cancel** for lunch and dinner before the cutoff.
- Pause the plan for a date range (vacations). The end date moves automatically.
- Scan the provider's QR code to confirm a delivery, which logs the time and deducts a meal.
- Meal history.

**For the provider**
- Delivery queue for each meal, with manual "mark delivered".
- Customer management, payments and renewals, and PIN resets.
- Daily menus, meal cutoff times and kitchen holidays.
- Push the day's menu prompt to every customer, or let the server send it automatically before each cutoff.
- Show and rotate the delivery QR code.

**Plan logic.** Each subscription's end date is recalculated whenever a meal is cancelled, a pause is added or removed, or a holiday is declared. Cutoffs follow the kitchen's time zone (`TZ`), so "today" and "too late to cancel" mean the same thing on every device.

## Engineering highlights

- **Auth:** phone + PIN login issues a random bearer token. Only its SHA-256 hash is stored. Customer tokens last 30 days, provider tokens 7. Provider-only routes reject customer tokens (403), and customers can only act on their own data.
- **PIN storage:** salted `scrypt` hashes with constant-time comparison. Legacy plain-text PINs are migrated in place on startup.
- **Brute-force protection:** after 5 wrong PINs, that phone (or IP, for the provider) is locked for 15 minutes; after 20, the IP is locked for every login (HTTP 429).
- **Concurrency:** SQLite runs in WAL mode, and every write runs in a `BEGIN IMMEDIATE` transaction. A stress test showed the earlier read-then-write code lost updates (200 concurrent "+1" requests recorded about 20). If the database stays locked, the API returns 503 with `Retry-After`.
- **Validation:** strict type and range checks on every endpoint. For example, the string `"false"` is never read as true, and `NaN`/`Infinity` are rejected.
- **QR delivery:** random, rotatable codes compared in constant time, with duplicate-scan prevention. The QR image is generated as SVG by a small pure-Python encoder (`qr.py`).
- **Push notifications:** sent in batches of 100 through the Expo Push API. If one batch fails the others still go out, and tokens Expo reports as dead are removed.
- **Operations:** Docker image (non-root, healthcheck), Caddy for automatic HTTPS, security headers, and an online, integrity-checked SQLite backup script with retention.

## Tech stack

| Part | Technology |
|---|---|
| API | Python 3.13+ standard library: `http.server.ThreadingHTTPServer`, `sqlite3`, `hashlib`, `secrets`, `urllib` |
| Database | SQLite (WAL), 7 tables, idempotent migrations |
| Web client | Vanilla JavaScript, HTML, CSS, service worker (PWA) |
| Mobile client | React Native, Expo, TypeScript, `expo-secure-store`, `expo-notifications`, `expo-camera` |
| Tests | `unittest`: 46 tests covering plan logic, auth, concurrency, validation and backups |
| Deployment | Docker, Docker Compose, Caddy, EAS Build |

## Run it locally

You need Python 3.13 or newer. The backend has no dependencies to install.

**Demo mode** seeds three demo customers (PINs 1111, 2222, 3333; provider PIN 0000):

```bash
DEMO_MODE=1 python server.py
```

On Windows PowerShell:

```powershell
$env:DEMO_MODE="1"; python server.py
```

Then open http://localhost:8080 for the web app.

**Normal mode** requires a provider PIN of 4–8 digits (not `0000`):

```bash
PROVIDER_PIN=CHOOSE_A_PIN python server.py
```

Never use demo mode with real customers: it publishes the demo PINs at `/api/demo`.

### Mobile app

```bash
cd mobile
npm install
npx expo start
```

In development the app connects to `http://<your computer's LAN IP>:8080`, so a phone on the same Wi-Fi works with Expo Go. Push notifications need a development or preview build. See [`mobile/README.md`](mobile/README.md) for push setup and EAS builds.

### Tests

```bash
python -m unittest discover -s tests
```

## Deploy

[`DEPLOY.md`](DEPLOY.md) covers running the API behind Caddy with Docker Compose, the first-day security checklist, daily backups and restore, and building the Android app against your HTTPS API. All server settings are documented in [`.env.example`](.env.example).

## Project layout

```
server.py        HTTP server, routing, auth gate, input validation
db.py            schema, migrations, plan logic, sessions, PIN hashing
qr.py            pure-Python QR code → SVG
push.py          Expo Push API client
backup.py        online SQLite backup with integrity check and retention
static/          PWA (index.html, app.js, styles.css, sw.js)
mobile/          Expo app (TypeScript)
tests/           unittest suite
Dockerfile, docker-compose.yml, Caddyfile
```
