# Push notifications (DASH Automates)

When a scheduled automation finishes or fails, DASH AI tells the person on their Android phone, even
when the app is closed:

| Event | Title | Text | Tapping opens |
| --- | --- | --- | --- |
| Result ready (`automation.ready`) | DASH AI | Your scheduled result is ready. | the result |
| Run failed (`automation.failed`) | DASH AI | A scheduled task needs your attention. | the automation and its run status |

These words are fixed (`PUSH_TEXT` in `packages/contracts/src/push.ts`, `PushText` on Android). A push
never carries or shows a prompt, a result, a document, a provider or model name, or an error detail.
Every run that queues a notice also keeps the in-app notice, so nothing is lost when a push is not
delivered.

Scope of this version: **Android through Firebase Cloud Messaging (FCM)**. Web Push is deferred (see
[Web](#web)); the web app behaves exactly as before.

## Architecture

```
run finishes ─┬─ result stored (encrypted)                       ┐
              ├─ in-app notification row                          │ one transaction (finishRun)
              └─ one push_deliveries row per live registered device ┘
                                   │
                    PushService (every API instance)
            claim due rows (FOR UPDATE SKIP LOCKED, 60 s lease)
                  re-check: session valid, preference on,
                  notice not read yet, not older than the TTL
                                   │
                    PushTransport (by platform)
                  fcm → FCM HTTP v1 · fake → recorded · none
                                   │
          sent · retry later (backoff) · failed · device removed (token invalid)
```

- `apps/api/src/push/types.ts`: `PushTransport` (`send(target, payload, {ttlSeconds, signal})`) returns a
  normalized result: `ok`, or `invalid_token` / `retryable` (with optional `retryAfterMs`) / `permanent`
  with a short code. Nothing provider-specific leaves the transport.
- `push/fcm.ts`: FCM HTTP v1 without the Firebase SDK. A service-account JWT (RS256) is exchanged for
  an OAuth token (cached until shortly before expiry, dropped on 401). Messages are **data-only**,
  priority high, with the configured TTL and `collapse_key` = notification id.
- `push/fake.ts`: records sends and can script failures (tests and local development).
- `push/service.ts`: the delivery loop. Started on every instance; a finished run also "pokes" it so a
  push goes out at once rather than on the next tick.

Delivery order is fixed by design: **execute → store the result → store the notice and its deliveries
→ attempt the push**. Push runs after the run is committed and never touches runs or results, so a
push failure can never fail, repeat or regenerate a run.

### Retries and duplicates

| Situation | What happens |
| --- | --- |
| FCM 5xx, `UNAVAILABLE`, `INTERNAL`, timeout, network error, 401 | retried: `PUSH_RETRY_BASE_MS` × 2^(attempt−1) ±20 % jitter, capped at 1 h, at most `PUSH_MAX_ATTEMPTS` attempts |
| 429 / `QUOTA_EXCEEDED` | retried, waiting at least the `Retry-After` |
| `UNREGISTERED`, `SENDER_ID_MISMATCH`, 404 | the device registration is deleted (with its other pending pushes) |
| any other error | failed, not retried |
| signed out, preference off, notice already read, older than `PUSH_TTL_SECONDS` | skipped (`failed` with that reason), nothing sent |
| instance dies mid-send | the lease expires and another instance claims the delivery again |

Duplicates are prevented at every layer: one delivery per (notification, device) (unique index,
inserted in the run's own transaction, so a retried or recovered run cannot fan out twice); claims use
`SKIP LOCKED`; finishing a delivery is compare-and-set on its status; FCM collapses on the notification
id; the phone keeps the last 100 notification ids it showed and posts each with the notification id as
its tag, so a repeated delivery replaces rather than adds. The only remaining case is the narrow window
where FCM accepted a message but the instance died before recording it; the phone's duplicate guard
covers that.

Observability: `dash_push_deliveries_total{outcome}` (`sent`, `retry`, `failed`, `invalid_token`,
`signed_out`, `disabled`, `already_read`, `expired`, `no_transport`) on `/metrics`, and log lines with
delivery or device ids and normalized codes only.

## Device registration

| Endpoint | Purpose |
| --- | --- |
| `PUT /v1/push/devices/current` `{platform:"android", token, appVersion?}` | register or refresh this device for the signed-in session (idempotent) |
| `GET` / `DELETE /v1/push/devices/current` | this session's device / stop pushes to it |
| `GET /v1/push/devices`, `DELETE /v1/push/devices/:id` | the account's devices (never their tokens); remove one |
| `GET` / `PUT /v1/push/preferences` `{automates}` | Automates notifications on or off for the account; `available` says whether this server sends pushes |

- A registration belongs to the **session** that made it (`push_devices.session_hash` references
  `sessions` with `ON DELETE CASCADE`). Signing out, signing out everywhere, session expiry and account
  deletion all remove it in the database, whatever the app does.
- The user is always the authenticated one; no id is read from the body. Another account's device id
  is "not found".
- A token is unique by its SHA-256 hash. When a phone signs in to a different account, registering
  moves the token: the previous account's row (and its queued pushes) is deleted first.
- The token is stored encrypted (AES-GCM, bound to the row) and only decrypted to send. It is never
  logged, never returned by any endpoint and **not part of `GET /v1/me/export`**.

Storage (migration 8, `push_notifications`): `users.push_automates` (default on), `push_devices` and
`push_deliveries`. The existing `notifications` table stays the single record of what happened; a
delivery row only tracks sending.

## Android

- **Setup without `google-services.json`.** Firebase is initialised from `BuildConfig` values set at build
  time: Gradle properties `dashFirebaseProjectId`, `dashFirebaseAppId`, `dashFirebaseApiKey`,
  `dashFirebaseSenderId`, or environment variables `DASH_FIREBASE_PROJECT_ID`, `DASH_FIREBASE_APP_ID`,
  `DASH_FIREBASE_API_KEY`, `DASH_FIREBASE_SENDER_ID`. Without them (CI, local builds) push is simply
  unavailable and everything else works. Messaging auto-init and Analytics collection are off.
- **Permission UX.** Nothing is asked at first launch. On Automates, a signed-in person who has not
  allowed notifications sees one card, "Know when results are ready", explaining what DASH AI notifies
  about. "Turn on notifications" shows Android's prompt (Android 13+) or opens DASH AI's notification
  settings; "Not now" hides it. Either answer is remembered and Automates work the same either way.
- **Settings → Notifications → Automates notifications.** The account's on/off switch (kept on the
  server, applies to every device) and the phone's real state: if Android blocks DASH AI's
  notifications (permission or the "Automates" channel), the row says so and offers "Allow
  notifications on this phone". Automations run regardless.
- **Registration.** While a real account is signed in and notifications are allowed on the phone, the
  app registers its token (again when FCM rotates it). If notifications are turned off on the phone, it
  unregisters. Demo Mode never registers.
- **Receiving** (`DashMessagingService`): the data message is validated (version, ids, type), dropped if
  no real account is signed in, if it is for another account (a 16-character hash of the account id,
  compared on the phone), if notifications are not allowed, or if it was already shown. The text comes
  from `PushText`, never from the payload. Lock-screen visibility is public because the text is generic.
- **Opening.** The notification opens `MainActivity` with the ids as extras (immutable
  `PendingIntent`). The app navigates once its UI is ready: Automates, then the result or the
  automation on top, so Back returns to Automates. This works on cold start, from the background and
  while open. It is ignored when signed out. The screens load through the normal API, so another
  account's ids are "not found" on the server. Opening marks the notice read.
- **Signing out** unregisters the device on the server (best effort; the server also removes it with
  the session), deletes the FCM token, clears shown notifications, the duplicate guard and any pending
  open.

## Web

Deferred. The web app has no service worker; it keeps showing notices while a tab is open
([automates.md](automates.md)). Web Push would add a `web` platform, a service worker, VAPID keys and a
transport behind the same `PushTransport` interface and delivery queue; no schema change beyond the
platform value is expected.

## Configuration and secrets

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUSH_TRANSPORT` | `none` | `none`: no pushes (in-app notices only). `fcm`: send through FCM. `fake`: record, never send (local development; production warns). |
| `FCM_SERVICE_ACCOUNT` | — | **Secret.** Firebase service-account JSON (raw or base64) with permission to send messages. Required with `fcm`; start-up fails if it is missing or malformed. |
| `PUSH_TICK_MS` | `5000` | How often each instance looks for due pushes. |
| `PUSH_MAX_ATTEMPTS` | `5` | Attempts per push before giving up. |
| `PUSH_RETRY_BASE_MS` | `30000` | First retry delay. |
| `PUSH_TTL_SECONDS` | `86400` | A push older than this is not sent (also the FCM TTL). |

What the Director supplies to turn pushes on (none of it is committed, and CI needs none of it):

1. A Firebase project with an Android app for package `com.dashworldng.ai`.
2. For the API: a service-account key allowed to send FCM messages, stored in the secret manager as
   `FCM_SERVICE_ACCOUNT`, plus `PUSH_TRANSPORT=fcm`.
3. For release builds of the app: the Firebase project id, app id, API key and sender id as the Gradle
   properties or environment variables above (these identify the app; they are not server secrets, but
   are kept out of the repository with the other build settings).

## Local development and tests

- `PUSH_TRANSPORT=fake` queues and "sends" pushes without Firebase.
- API: `apps/api/test/push.test.ts` (in-memory and PostgreSQL stores) covers registration, isolation,
  payload neutrality, preference, retries, invalid tokens, leases with two instances, sign-out, account
  deletion, export, logs and the FCM transport against a local server.
- Android: `core` `PushTest` (payload parsing, account check, duplicate guard, registrar) and app
  `PushUiTest` (offer, Settings, registration, deep links, receiving, sign-out).
- A live FCM smoke test is not part of CI; with real credentials, register a phone and use Run now.

## Known limitations

- Android only; no Web Push yet.
- Notification grouping is per notice; there is no summary when many arrive together.
- If FCM accepts a message and the instance dies before recording it, the delivery may be sent once
  more after the lease; the phone's duplicate guard hides it.
- Failed and skipped delivery rows are kept with their notice (removed with it or the account).
