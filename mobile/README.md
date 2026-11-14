# DabbaTrack Mobile (Expo + TypeScript)

One app for both roles, talking to the Python API in the repo root (`server.py`).

| Role | Sign in with | Tabs |
|---|---|---|
| Customer | Phone + 4-digit PIN (`POST /api/customer/login`) | Home (plan card), Menu (Yes / Cancel), Scan QR, Pause, History |
| Provider | Provider PIN (`POST /api/provider/login`) | Deliveries, QR & Prompt, Customers, Menus & More |
| Demo Mode | One tap on the launch screen (only when the server runs with `DEMO_MODE=1`) | Adds a **Demo** pill in the header to jump between provider and any demo customer |

Login returns a bearer token (customers: 30 days, provider: 7 days). The app stores it with `expo-secure-store` (localStorage on web) and sends it as `Authorization: Bearer …` on every request. If the server rejects it (expired, signed out, or PIN reset), the app returns to the sign-in screen. The Base URL can be changed any time from the ⚙ Settings screen, including before signing in.

## 1. Run the backend so phones can reach it

The server refuses to start without a provider PIN, unless it's in demo mode. Replace `CHOOSE_A_PIN` with your own 4–8 digits (not `0000`). For a production server, follow [`../DEPLOY.md`](../DEPLOY.md) instead.

```bash
HOST=0.0.0.0 PORT=8080 PROVIDER_PIN=CHOOSE_A_PIN python server.py   # macOS / Linux / Git Bash
HOST=0.0.0.0 DEMO_MODE=1 python server.py                     # local demo: seeds demo customers, provider PIN 0000
```
```powershell
$env:HOST="0.0.0.0"; $env:PROVIDER_PIN="CHOOSE_A_PIN"; python server.py   # PowerShell
```

Env vars:

| Var | Purpose |
|---|---|
| `PROVIDER_PIN` | Initial provider PIN, 4–8 digits, not `0000`. Required unless a PIN was already saved from the app. Once changed in the app, the saved (hashed) PIN wins. |
| `DEMO_MODE` | `1` seeds 3 demo customers (PINs 1111/2222/3333) and publishes them at `/api/demo`. **Never with real customers.** |
| `TRUST_PROXY` | `1` only when behind your own reverse proxy, so login rate limits use the real client IP from `X-Forwarded-For` |
| `AUTO_PROMPT_LEAD_MINUTES` | e.g. `60` → automatically push the meal prompt 60 min before each cutoff |
| `EXPO_ACCESS_TOKEN` | Only if you enabled "enhanced push security" in your Expo account |
| `CORS_ALLOW_ORIGIN` | Defaults to `*` |

## 2. Run the app in development

```bash
cd mobile
npm install
npx expo start
```

In dev the app defaults to `http://<your computer's LAN IP>:8080` (taken from the Expo dev server), so a phone on the same Wi-Fi just works. Override with `EXPO_PUBLIC_API_URL` (see `.env.example`) or in Settings.

> **Push notifications need a real build.** Expo Go on Android no longer supports remote push (SDK 53+). Everything else (QR scanning, menus, in-app pop-up via provider broadcast) works in Expo Go; use the preview APK below to test pushes.

## 3. Push notifications setup (one-time)

```bash
npm install -g eas-cli
eas login
eas init            # writes extra.eas.projectId into app.json — required for Expo push tokens
```

For Android pushes, upload your FCM V1 service-account key: `eas credentials` → Android → Google Service Account → FCM V1 ([Expo guide](https://docs.expo.dev/push-notifications/fcm-credentials/)).

Flow: customer signs in → app requests permission → registers its Expo token via `POST /api/customers/push-token` → provider taps **Send Lunch/Dinner** (or the server's auto-prompt fires) → `POST /api/push/send-meal-prompt` sends today's menu → tapping the notification opens the Yes / Cancel pop-up.

## 4. Build installable apps (EAS)

```bash
eas build -p android --profile preview      # .apk for direct install (share the link / QR)
eas build -p android --profile production   # .aab for Google Play
```

Set the default backend for a build with `eas env:create --name EXPO_PUBLIC_API_URL --value https://your-api.example.com` (or an `env` block in `eas.json`).

The `preview` profile allows plain `http://` so the APK can talk to a LAN server during pilots. The `production` profile sets `APP_ENV=production`, and `app.config.js` then blocks plain HTTP (Android `usesCleartextTraffic: false`, no iOS ATS exceptions). **Production builds need an `https://` API URL.**

## 5. Checks

```bash
npx tsc --noEmit
npx expo-doctor
npx expo install --check     # align native module versions with the installed Expo SDK
```

## Project layout

```
App.tsx                     role router (launch / customer / provider)
src/api/                    typed API client + response types
src/state/session.tsx       session + base URL (SecureStore)
src/lib/notifications.ts    permission, Android channel, Expo push token, payload parsing
src/components/             UI kit, tab shell, meal pop-up, demo switcher
src/screens/customer/       Home, Menu, Scan, Pause, History
src/screens/provider/       Queue, QR & Broadcast, Customers, Manage (menus/cutoffs/holidays)
```

## Security model

- Every `/api/*` route except health, login and `/api/demo` needs a bearer token.
  - Provider-only routes reject customer tokens with 403.
  - Customer routes only accept the customer's own `customer_id`.
- PINs are stored as salted scrypt hashes and are never returned by the API. Providers use **Reset PIN** to issue a new one, which also signs the customer out.
- After 5 wrong PINs, a phone number (or, for the provider PIN, a client IP) is locked for 15 minutes. After 20 wrong PINs, the IP is locked for all logins. Limits are in memory, per server process.
- The delivery QR code is random. Rotate it from the provider app if you think it has leaked: a customer who has scanned it once knows it until it's rotated.
