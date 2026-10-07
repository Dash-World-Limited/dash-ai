# DASH Automates

A person gives DASH AI a task and a schedule. The **server** runs it at the scheduled time (the phone
does not need to be awake or online), DASH AI generates the result through the
[Intelligence Router](intelligence-router.md), the result is stored encrypted, and the person is
notified. They can then **view, edit, regenerate, copy, download or share** it.

```
define task + schedule → stored → server scheduler → router picks the path → result stored → notice → review / share
```

**Nothing is ever posted anywhere automatically.** This milestone deliberately has no social
publishing (no Instagram, Facebook, X, WhatsApp Status or LinkedIn posting, and no platform tokens
or permissions). "Share" hands the text to the device's own share sheet (Android) or the browser's
share/copy (Web); the person chooses where it goes.

## What people can do

| Action | API | Web | Android |
| --- | --- | --- | --- |
| Create, edit, delete | `POST /v1/automations`, `PATCH`/`DELETE /v1/automations/:id` | ✓ | ✓ |
| Pause, resume | `POST /v1/automations/:id/pause`, `/resume` | ✓ | ✓ |
| Run now | `POST /v1/automations/:id/run` (202; 409 while a run is in flight) | ✓ | ✓ |
| See state, next run, last run | `GET /v1/automations[/:id]` | ✓ | ✓ |
| View, edit a result | `GET`/`PATCH /v1/automations/:id/runs/:runId` | ✓ | ✓ |
| Regenerate | `POST /v1/automations/:id/runs/:runId/regenerate` (a new run; the old one is kept) | ✓ | ✓ |
| Copy, download (`.md`), share | client-side | ✓ | ✓ |
| Notices | `GET /v1/notifications`, `POST /v1/notifications/read` | toast, browser notification while a tab is open, unread count | unread dot on the menu, count on Automates, "New results" card |

States shown to people: **Scheduled, Running, Ready, Failed, Paused, Completed** (a one-time
automation that has run). Schedule wording is identical on Web and Android ("Weekdays at 08:00",
"Monthly on day 31 at 07:00 (or the last day)", "Once on 1 Dec 2026 at 09:00").

Run now and Regenerate share the chat rate limit. Each person can keep `AUTOMATIONS_MAX_PER_USER`
automations (default 25) and the latest 30 results per automation.

## Schedules and time zones

Schedules are **local wall-clock times in the automation's own IANA zone** (`Africa/Lagos`,
`Europe/London`…), so "every day at 08:00" stays at 08:00 across daylight-saving changes. The
server computes the next run as a UTC instant (`src/automations/schedule.ts`, using `Intl`):

- `once` (date + time), `daily`, `weekly` (any set of days), `monthly` (day 1–31; 29–31 run on the
  last day of shorter months).
- A time that does not exist (spring-forward gap) runs just after the gap; a time that happens twice
  (fall-back) runs once, at the first occurrence.
- Changing the schedule or zone recomputes the next run; saving other fields leaves it alone. A
  one-time time in the past is refused. Resuming continues from the next occurrence (missed runs
  while paused are not replayed).
- Clients default the zone to the device's or browser's zone and let people pick another.

## Scheduler and queue

Reuses the API's own PostgreSQL (no new infrastructure); `automation_runs` doubles as the work queue.
`AutomationService` (`src/automations/service.ts`) runs in every API instance, ticking every
`AUTOMATIONS_TICK_MS` (15 s):

1. **Recover**: `running` runs whose lease expired (their instance stopped) are marked failed
   ("This run was interrupted before it finished.").
2. **Schedule**: due active automations get a `queued` run, and `next_run_at` advances by
   compare-and-set, so with several instances each occurrence is queued exactly once. After downtime a
   missed occurrence runs **once**, then the schedule continues from the next future time.
3. **Execute**: queued runs are claimed with `FOR UPDATE SKIP LOCKED` (up to
   `AUTOMATIONS_CONCURRENCY`, default 2 per instance), leased, and generated through the router
   (`task: "automation"`) with bounded retries and failover across healthy providers.
   A unique partial index allows at most one queued or running run per automation.
4. **Finish**: the result is stored (AES-GCM, bound to its row), usage is recorded, and a notice is
   written. Failures store a neutral message; provider names never reach people.

Run now and Regenerate queue a run and wake the scheduler immediately. `AUTOMATIONS_ENABLED=false`
turns execution off (API calls to run return 503; data is kept). Shutdown aborts runs in progress;
they are marked interrupted.

## Storage

Migration 7 adds `automations` (encrypted name and prompt, schedule JSON, zone, status,
`next_run_at`), `automation_runs` (encrypted result, status, lease, internal provider/model
diagnostics) and `notifications` (ids and timestamps only; titles are built when read). All cascade
from the user, are included in `GET /v1/me/export`, removed by `DELETE /v1/me`, and covered by the
encryption backfill and key rotation. See [persistence.md](persistence.md) and
[data-inventory.md](data-inventory.md).

Migration 8 adds Android push: device registrations (`push_devices`, bound to the session) and a
delivery queue (`push_deliveries`) filled in the same transaction that stores the result. Push never
affects the run. See [push-notifications.md](push-notifications.md).

## Known gaps (first version)

- **Push on Android only.** A finished or failed run sends an Android push ("DASH AI / Your scheduled
  result is ready." or "… needs your attention."); see [push-notifications.md](push-notifications.md).
  Web notices still appear only while a tab is open; Web Push is deferred.
- Automations do not use tools, web search or documents yet; the prompt is the whole input.
- Router health (EWMA, circuit breaker) is per API instance, not shared.
- The run list decrypts each result to build its one-line preview.
- No per-account cost budget for automations beyond the per-user limit and the chat rate limit.
