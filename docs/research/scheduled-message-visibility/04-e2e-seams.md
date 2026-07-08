# E2E test seams & harness patterns for scheduled-message visibility

Research for the `scheduled-message-visibility` planner. Maps the deterministic
seams that let an e2e spec (a) see a scheduled reminder/nudge as a future timeline
item, (b) tick it to a sent message, (c) reschedule a tour and verify old ladder
canceled + new armed, (d) verify an opted-out contact's scheduled item reads as
suppressed.

All citations are `file:line` against the `feat/scheduled-message-visibility`
worktree (`w:/tmp/sched-msg-visibility`).

---

## 0. TL;DR for the planner

The harness ALREADY has everything needed to drive scheduled sends deterministically:

- **A controllable clock is passed as a request-body `now`** to two tick endpoints
  (`POST /__dev/tour-reminders/tick`, `POST /__dev/placement-nudges/tick`). There is
  no injectable global clock; instead each tick RUNS ONE POLL PASS with `now` = the
  ISO instant you supply. `dueAt <= now` rows fire. This is how a spec advances time.
- **The scheduled-send rows already exist at the data layer** (`tourReminders` table
  via `tourRemindersRepo`, `placementNudges` via `placementNudgesRepo`), each with
  `dueAt` / `kind` / `sentAt?` / `canceledAt?`. Part A/B of the issue is about
  *exposing* these over HTTP + timeline; a spec can arm them today through the real
  UI (book a tour / move a placement stage).
- **Proof-of-send is asserted via fake-twilio `listThreads()`** (both directions +
  `from`/`body`/`state`), NOT the deprecated `/__dev/outbox`.
- **Opt-out** is set either by an inbound `STOP` webhook (`postInboundSms`) or the
  dashboard "Mark Do-Not-Contact" menu — both set `contact.sms_opt_out`, which
  `sendMessageService` gates on at send time (a ticked reminder to that contact
  claims `sentAt` but never delivers → the future item must read as suppressed).
- **The `Scenario` verb vocabulary** in `e2e/scenarios/steps.ts` already has
  `tickTourReminders(nowIso?)`, `devPlacementNudgeTick(nowIso?)`, `teamBooksTour`,
  `teamReschedulesTour`, `expectReminderTo1to1`, `expectReminderInGroup`,
  `tourSchedule()`, `justAfter()`, `hoursFromNow()`. New specs extend this class.

---

## 1. Dev seams / control endpoints

All dev endpoints live in `app/src/routes/dev.ts` (`createDevRouter`) and are mounted
ONLY behind a triple gate (see §6 for the gate). PII note: bodies are canned `[AUTO]`
templates, so the outbox/thread stores hold them, but logs never carry phone/body.

### 1a. `GET /__dev/ping` — stack-identity probe
`app/src/routes/dev.ts:79-90`. Returns
`{ dev:true, recordOutbox, messagingDriver, smsSendingEnabled, tablePrefix, appCommit }`.
Used by preflight to catch a stale reused backend. Confirm hermetic stack before driving.

### 1b. `POST /auth/dev-login` — mint a real session, no Google
`app/src/routes/dev.ts:104-124`. Body `{ email? }` (default `va@example.com` → role
`va`; `founder@example.com` → `admin`; any other → `admin`). Auto-provisions a missing
user. Returns `{ userId, email, role }` and sets the session cookie. This is what the
`vaPage` fixture uses (via `auth.setup.ts`).

### 1c. `GET /__dev/outbox?to=&since=` — DEPRECATED proof-of-send log
`app/src/routes/dev.ts:131-147`. Scans the `${TABLE_PREFIX}dev-outbox` table
(`OUTBOX_TABLE_BASE = 'dev-outbox'`, `app/src/adapters/recordingMessaging.ts:19`).
Returns `{ messages: OutboxRecord[] }` sorted `createdAt` ascending, filterable by
`to` / `since`. **Record shape** (`recordingMessaging.ts:21-31`):
`{ id, to, from?, body?, mediaUrls?, idempotencyKey?, providerSid, status, createdAt }`.
Only OUTBOUND, and the driver only records on a SUCCESSFUL inner send
(`recordingMessaging.ts:78-99`) — so a **suppressed send never reaches the outbox**,
and neither does a group per-member adapter send that is opt-out-skipped.
**The dev router explicitly marks this deprecated** (`dev.ts:126-130`,
`TODO(remove-dev-outbox-proof-of-send)`): new tests should assert against fake-twilio
`listThreads` (§3), which captures BOTH directions + delivery-status progression.

### 1d. `POST /__dev/reseed` — wipe + reseed local tables
`app/src/routes/dev.ts:150-157` → `resetLocalData` (`app/src/lib/devReset.ts`). Also
clears the session-epoch cache so a post-reseed dev-login isn't rejected. Guarded to
hermetic-local only (`devReset.ts:53`).

### 1e. `POST /__dev/tour-reminders/tick { now? }` — THE tour-reminder seam
`app/src/routes/dev.ts:159-199`. **This is the deterministic replacement for the
worker's 60s `setInterval` poll** — one POST runs exactly ONE
`runDueTourReminders(nowIso)` pass (`dev.ts:196`).

- **Request:** JSON body `{ now? }`. `now` optional; if present must be a parseable
  ISO 8601 datetime (else `400 { error: 'now must be a valid ISO 8601 datetime' }`,
  `dev.ts:190-193`). It is **normalized** via `new Date(body.now).toISOString()`
  (`dev.ts:194`) because the ladder compares ISO strings LEXICOGRAPHICALLY. Omitting
  `now` defaults to the wall clock (`dev.ts:188`) — fires the just-armed `confirmation`
  rung immediately.
- **Response:** `200 { ok:true, now: nowIso }`.
- **What it advances:** `runDueTourReminders` (`app/src/jobs/tourReminders.ts:207-230`)
  → `tourRemindersRepo.listDue(now)` (rows with `dueAt <= now`, no `sentAt`, no
  `canceledAt`, `tourRemindersRepo.ts:113-147`) → per row: resolve tour, route to the
  masked GROUP thread (landlord_led/pm_team with a usable group) or the tenant 1:1
  (self_guided always, or fallback), **claim `sentAt` BEFORE the send** (`claimSend`,
  `tourReminders.ts:298`), then `sendMessageService(...)` (`tourReminders.ts:310-315`).
- **Deps injection:** `tourReminderDeps` (`DevRouterDeps.tourReminderDeps`,
  `dev.ts:44-46`) can be injected for unit tests; in the running stack they are lazily
  built to MIRROR `worker.ts` exactly (`dev.ts:170-185`) so hermetic sends stay
  outbox-visible.

### 1f. `POST /__dev/placement-nudges/tick { now? }` — THE placement-nudge seam
`app/src/routes/dev.ts:201-240`. Same shape/contract as the tour tick: one POST runs
one `runDuePlacementNudges(nowIso)` pass (`dev.ts:237`). Same `now` validation +
normalization (`dev.ts:230-235`). Response `200 { ok:true, now }`.

- **What it advances:** `runDuePlacementNudges` (`app/src/jobs/placementNudges.ts:183-206`)
  → `placementNudgesRepo.listDue(now)` → per row: resolve placement; **STALE-STAGE
  GUARD** — if the placement already LEFT the rung's stage, claim-to-retire and DO NOT
  send (`placementNudges.ts:239-246`); else resolve recipient (tenant =
  `placement.tenantId`; landlord = `unit.landlordId`), find/**create-on-demand** the
  1:1 conversation (`placementNudges.ts:294-330`), claim, then `sendMessageService`.
- The nudge ladder is stage-keyed (`NUDGE_RUNGS`, `placementNudges.ts:56-81`): one
  durable row armed on stage entry, canceled on stage leave (`armNudgeForStage`,
  `placementNudges.ts:121-152`).

### 1g. `POST /api/placements/:id/deadline { type, at }` — NOT a dev seam, but the clock trick for board deadlines
Used by `devBlowRtaWindow` (`steps.ts:2075-2083`). The Today board compares
`next_deadline_at` to the SERVER WALL CLOCK (it can't be ticked), so to make a
deadline overdue a spec overwrites it to a PAST instant. Relevant only for the
`next_deadline` / `rta_window` deadline surface, not the reminder/nudge rows.

---

## 2. Clock control — how a spec makes a `dueAt` "past"

**There is no injectable global clock and no time-freeze endpoint.** The model is:
the poller is stateless and takes `now` as an argument; the tick endpoint lets a spec
CHOOSE that `now`. So a spec makes a `dueAt` due by ticking with a `now >= dueAt`.

Two clock helpers in `e2e/scenarios/steps.ts` compute the right `now`:

- **`tourSchedule(hoursFromNow = 48)`** (`steps.ts:149-164`) — picks a booking time
  and PRE-COMPUTES every rung's `dueAt` EXACTLY as the backend `computeDueAt` does
  (`tourReminders.ts:65-84`): `{ scheduledAtLocal, dayBefore, morningOf, enRoute,
  noShowCheckin }`. The dashboard form sends the raw `datetime-local` value and the
  app parses it host-local, so parsing the same string in the test yields
  byte-identical `dueAt` ISO strings. `confirmation` is not precomputed — its `dueAt`
  is arm-time "now", so a tick WITHOUT `now` fires it.
- **`justAfter(iso)`** (`steps.ts:167-169`) — `iso + 1s`; a tick `now` that fires
  exactly the rungs due `<= it`. Usage: `tickTourReminders(justAfter(times.dayBefore))`.
- **`hoursFromNow(hours)`** (`steps.ts:178-180`) — an ISO `now` `hours` past the REAL
  wall clock, the placement-nudge tick's clock. Nudge `dueAt = transitionMoment +
  delayMs` (armed at PATCH time on the server's wall clock), so to fire a rung with a
  D-hour delay, tick `devPlacementNudgeTick(hoursFromNow(D + 1))`. Recomputed at call
  time so it always sits ahead of the just-made transition.

> **Tick discipline (important for spec authors, `steps.ts:1322-1324`,
> `tours.spec.ts:23-27`):** the tick is GLOBAL — it fires EVERY due row in the DB, and
> the worker ALSO polls the real clock. So arrival assertions must scope to THIS
> test's phones, and `now`s should ride the pre-computed rung `dueAt`s so you don't
> accidentally fire a future rung early. 1:1 rungs must stay within the send breaker's
> 10/min/conversation budget.

For scheduled-message-visibility Part B specs, the natural pattern is:
1. Arm the ladder (book a tour / move a placement stage) → the future rows exist.
2. Read the timeline → assert the FUTURE (`scheduled`) item(s) render with body +
   `dueAt`, before any tick.
3. `tickTourReminders(justAfter(rungDueAt))` (or `devPlacementNudgeTick(hoursFromNow(D+1))`).
4. Re-read the timeline → assert the item TRANSITIONED to a normal sent message.

---

## 3. Outbox / proof-of-send assertion

**Preferred: fake-twilio `listThreads()`** (`e2e/fixtures/fakeTwilio.ts:141-145`) →
`GET {fake}/control/threads` → `FakeThread[]`. Shape (`fakeTwilio.ts:95-110`):
```ts
interface FakeThread {
  partyNumber: string;
  messages: Array<{
    sid: string;
    direction: 'inbound' | 'outbound';
    from: string;   // app/pool number for outbound; the party for inbound
    to: string;
    body?: string;
    state: string;  // e.g. 'delivered'
    mediaUrls?: string[];
  }>;
}
```
Specs `find(x => x.partyNumber === contact.phone)` then assert a message with
`direction:'outbound'`, a `from` (APP_NUMBER `+15550009999` for 1:1, or the pool
`+1555019xxxx` for a masked group), and `body` equal/containing the rung body.

Existing verbs that wrap this (all in `steps.ts`):
- `expectReminderTo1to1(kind, tenant, atLeast=1)` (`steps.ts:1591-1609`) — counts
  outbound `from === APP_NUMBER` messages with `body === TOUR_REMINDER_BODIES[kind]`;
  `atLeast=2` proves a re-armed ladder's 2nd confirmation.
- `expectReminderInGroup(kind, members[])` (`steps.ts:1565-1586`) — each member's
  thread has an outbound `from === pool` with the rung body.
- `expectOutboxMessageContaining(recipient, text)` (`steps.ts:1990-2008`) — a 1:1
  nudge outbound `from === APP_NUMBER` whose body includes `text` (the nudge-body
  substrings pinned at `post-tour-application.spec.ts:38-41`).
- `expectNoOutboxMessageContaining(recipient, text)` (`steps.ts:2016-2026`) — the
  suppression / canceled-nudge assertion. **Single check, not a poll** — the tick
  awaits every due-row send before returning, and a canceled/suppressed row can never
  fire on the wall-clock poll either. This is the exact shape a
  scheduled-message-visibility "suppressed item never delivers" spec reuses.

`TOUR_REMINDER_BODIES` (test-pinned copy of the backend `REMINDER_BODIES`) is at
`steps.ts:114-120`; the nudge bodies are inlined at
`post-tour-application.spec.ts:38-41` (pinned so a body reword breaks loudly).

**Deprecated: `getOutbox`** (`e2e/fixtures/outbox.ts:20`) → `GET /__dev/outbox` (§1c).
The fixture file itself points callers at `listThreads` (`outbox.ts:15`). Only the
three legacy specs (`outbox.spec.ts`, intake-to-reply, boards) still use it.

---

## 4. Existing e2e patterns to mirror

### 4a. The `Scenario` verb class + support files
- **`e2e/scenarios/steps.ts`** (2467 lines) — the diagram-vocabulary `Scenario` class.
  New scheduled-message specs add verbs here. Key infra already present: dev-login
  (`login()`, `steps.ts:207-213`), the two tick helpers, tour/placement drivers,
  thread assertions, `activeTour`/`activePlacementId` state.
- **`e2e/support/selectors.md`** — accessibility-first selector conventions
  (`getByRole`/`getByLabel`); the CLAUDE.md-mandated selector guide.
- **`e2e/support/urls.ts`** — central lane-URL module (`fakeUrl`, dashboard URL). The
  dashboard base is `process.env.E2E_DASHBOARD_URL` (`steps.ts:29`, the `NEXT` const).
- **`e2e/support/preflight.ts`** — globalSetup, asserts hermetic flags via `/__dev/ping`.
- **`e2e/fixtures/`** — `fakeTwilio.ts` (`listThreads`/`sendAsParty`/`registerParty`/
  `postInboundSms`), `outbox.ts`, `auth`, `reseed`.

### 4b. Tour-reminder ladder exercise — `e2e/tests/scenarios/tours.spec.ts`
The reference for arming + ticking + asserting a tour ladder AND for reschedule.
- Book → tick → assert confirmation in group: `tours.spec.ts:123-128`.
- Book → tick → assert confirmation 1:1 (self-guided / fallback): `tours.spec.ts:217-218`,
  `254`.
- Fire a future rung by ticking `justAfter(times.<rung>)`: `tours.spec.ts:128`
  (`day_before`), `229` (`en_route`), `258` (`no_show_checkin`).
- **Reschedule re-arms the ladder (deliverable c):** `tours.spec.ts:236-269` — the
  no-show test books, fires `no_show_checkin`, `teamMarksNoShow()`, then
  `teamReschedulesTour(newTimes)` and `tickTourReminders()` and asserts a **2nd**
  confirmation (`expectReminderTo1to1('confirmation', tenant, 2)`, `tours.spec.ts:268`).
  This proves old ladder canceled + new armed at the SEND layer. A visibility spec can
  additionally read the tour's reminders panel / timeline before & after reschedule.
  Reschedule verb: `steps.ts:1647-1658` (drives the real "Reschedule this tour" form).

### 4c. Placement-nudge exercise — `e2e/tests/scenarios/post-tour-application.spec.ts`
- Move stage → `devPlacementNudgeTick(hoursFromNow(25))` → assert nudge in outbox:
  `post-tour-application.spec.ts:130-132` (receipt), `137-139` (completion),
  `143-145` (approval, LANDLORD), `158-161` (rta_window_closing, LANDLORD).
- **Canceled nudge fires nothing** (the suppression-style negative assert): after
  `Lost`, `devPlacementNudgeTick(hoursFromNow(48))` +
  `expectNoOutboxMessageContaining(...)`: `post-tour-application.spec.ts:198-201`,
  `261-263`.
- Create-on-demand landlord 1:1 (no prior landlord thread): `.spec.ts:209-213, 228-229`.

### 4d. Navigating to a contact's 1:1 comms timeline
The timeline region has an accessible name **"Communications and activity"**:
```
this.page.getByRole('region', { name: 'Communications and activity' })
```
Used by `expectPreferencesRelayed` (`steps.ts:702-711`), `tenantAsksToTour`
(`steps.ts:1355-1356`). Navigate with `page.goto(`${NEXT}/contacts/${id}`)` then scope
assertions to that region. **This is the exact surface Part B adds a `scheduled`
timeline member to** — a visibility spec asserts the future item renders inside this
region, ordered by `dueAt`, before the tick.

### 4e. Navigating to a tour detail (Part A reminders panel)
`page.goto(`${NEXT}/tours/${tourId}`)`. The `activeTour.tourId` is captured on create
(`teamCreatesTourFromInterest`, `steps.ts:1367-1397`) from the `/tours/:tourId` URL.
TourDetail controls already driven by verbs: "Book tour" (`steps.ts:1533-1546`),
"Reschedule this tour" (`steps.ts:1647-1658`), "Open group thread"
(`steps.ts:1406-1435`), status actions. A Part A spec adds a "Reminders" panel
assertion here.

### 4f. Seeding a tour WITH reminders (the arm path)
There's no "seed a reminder row" API verb — reminders are armed by the real flow:
`teamCreatesTourFromInterest(unit, type)` (timeless, ZERO rows) →
`teamBooksTour(tourSchedule())` (arms the 5-rung ladder server-side; rows whose
computed `dueAt < now` are skipped, so book ≥ ~48h out to get the full ladder). See
`armTourReminders` skip logic (`tourReminders.ts:123-137`).

### 4g. Opting a contact out (deliverable d)
Two proven mechanisms, both set `contact.sms_opt_out` which `sendMessageService` gates:
1. **Inbound STOP webhook** — `postInboundSms(request, { from: phone, body: 'STOP',
   messageSid })` (`fakeTwilio.ts:50-74`); sets `sms_opt_out=true` (asserted
   `a2p-compliance.spec.ts:496-528`). All opt-out keywords listed
   `a2p-compliance.spec.ts:39`. Reversible with an opt-in keyword (`START`, etc.).
2. **Dashboard "Mark Do-Not-Contact"** — More actions menu → "Mark Do-Not-Contact"
   toggles `sms_opt_out`; "Allow SMS (clear opt-out)" reverts
   (`contact-detail.spec.ts:170-186`).

For a "scheduled item reads as suppressed" spec: opt the recipient out, arm/tick the
rung, then assert (a) the send never reached the thread
(`expectNoOutboxMessageContaining` shape) and (b) the future timeline item rendered as
suppressed/skipped rather than delivered. Note the send-side behavior the visibility UI
must reflect: on a `SendRefusedError` the poller STILL stamps `sentAt` (claim already
made) and does NOT retry — tour path `tourReminders.ts:326-340`, nudge path
`placementNudges.ts:366-380`. So a suppressed row ends up with `sentAt` set but NO
delivered message — the visibility feature must not read bare `sentAt` as "delivered".

---

## 5. Seed data — pre-armed ladders/nudges a spec could target

Seed lives in `app/src/lib/seed/`. Two profiles: **lean** (byte-stable; the default
`reseed`/e2e world) and **full** (`--seeded=full`; ~286 items, now-relative). The
scenario specs deliberately DON'T rely on seeded reminder rows — they self-seed fresh
timestamped contacts and arm via the UI (see §4f) — but pre-armed rows exist for
UI-only / read-endpoint specs:

### 5a. Live seed (FULL profile only) — REAL armed ladders
`app/src/lib/seed/live.ts` (`buildLiveStaticItems` + `armTourReminders` import at
`live.ts:29`). NOT byte-stable (dates depend on `now`). Header spec (`live.ts:5-24`):
- **TOUR-A** `tour-live-today` (`LIVE_IDS.tourToday`) — self-guided, scheduled TODAY
  14:00 UTC; reminders armed via the REAL `armTourReminders` → surfaces in Today's
  `tours_today`.
- **TOUR-B** `tour-live-tomorrow` (`LIVE_IDS.tourTomorrow`) — landlord-led, TOMORROW
  14:00 UTC, + a relay group conversation (`conv-live-relay-group`) + pool number
  (`+15550160001`). **Full 5-rung ladder armed** via `armTourReminders` — the richest
  target for a Part A reminders-panel / Part B timeline read (has PENDING future rows).
- **TOUR-C** `tour-live-upcoming` (was `tour-live-confirmed`; the confirmed
  status was removed 2026-07-08) — scheduled tour +2 days.
- **PLACEMENT-A** `placement-live-overdue-rta` — overdue `rta_window` deadline (past
  `next_deadline_at`) → Today `needs_you_now`.
- **PLACEMENT-B** `placement-live-follow-up` — due `follow_up` deadline.
- IDs enumerated at `live.ts:39-65` (`LIVE_IDS`), phones `+15550170001..3`.

Note: the live seed arms tour reminders but I found **no armed placement-*nudge* rows**
in the live seed (placement nudges are armed by stage transitions; the live placements
carry deadlines, not `placementNudges` rows). A nudge-visibility spec should arm via the
UI (move a placement into `awaiting_receipt` etc.) rather than expect a seeded nudge row.

### 5b. Matrix seed (coverage matrix) — mostly ARCHIVE (sent/canceled) reminder rows
`app/src/lib/seed/matrix.ts:622-742`. Reminder invariant (`matrix.ts:12-14, 973-974`):
- `requested` tours → ZERO reminder rows.
- `no_show` tours → a `no_show_checkin` row with `sentAt` set (archive).
- Scheduled/confirmed tours → pending rows written with future `dueAt` relative to a
  PAST creation (`matrix.ts:681-700`) — these CAN be pending, but their `dueAt` is a
  hand-written offset, not the live `armTourReminders` output.
- Other terminal/past tours → sent `confirmation` rows.
Rows flattened into the seed at `matrix.ts:1012-1019` (`tourReminders`).

Because matrix rows are mostly archival and lean has none, **the `live.ts` TOUR-B full
ladder is the best pre-seeded target** for a read-only visibility spec; otherwise
arm-via-UI in a self-clean scenario spec is the robust path.

---

## 6. Prod gating (how the seams are structurally absent in prod)

Three layers, all must pass or the dev router never even loads:
- **Config fail-fast** — `app/src/lib/config.ts:318-334`: if `devAuthEnabled` is set in
  production the app refuses to boot (the outbox "persists PII, must never run in prod").
- **Structural gate** — `app/src/lib/devRoutes.ts:11-24` (`maybeLoadDevRouter`): the
  dev router module is `import()`-ed ONLY when
  `devAuthEnabled && nodeEnv !== 'production' && dynamodbEndpoint` (a `DYNAMODB_ENDPOINT`
  is only set for DynamoDB Local; cloud stacks leave it unset). A prod process never
  loads `routes/dev.ts`.
- **Origin-secret exemption is deliberate** — `app/src/middleware/originSecret.ts:37-41`
  exempts the whole `/__dev/` prefix, relying SOLELY on the structural absent-in-prod
  gate above.
- Harness enablement: the e2e launcher sets `DEV_AUTH_ENABLED=1` and
  `MESSAGING_RECORD_OUTBOX=1` (`e2e/README.md:145-146, 166-169`).

---

## 7. Concrete recipe for the four target specs

| Deliverable | Recipe |
|---|---|
| (a) see reminder as FUTURE timeline item | `login` → self-seed searching tenant + owner + unit → `teamCreatesTourFromInterest` → `teamBooksTour(tourSchedule())` (arms 5 rungs) → `goto /contacts/:id` → assert `region "Communications and activity"` shows a `scheduled` item with the rung body + a future `dueAt`, BEFORE any tick. (New timeline `kind` per the issue.) |
| (b) tick → transition to sent | from (a), `tickTourReminders()` (confirmation) or `tickTourReminders(justAfter(times.dayBefore))` → re-read timeline; the same item now renders as a delivered message; cross-check via `expectReminderTo1to1('confirmation', tenant)`. |
| (c) reschedule cancels old + arms new | mirror `tours.spec.ts:236-269`: book → tick a rung → `teamReschedulesTour(tourSchedule(72))` → assert on the reminders panel/timeline the old rungs read canceled and a fresh future ladder is armed; confirm at send layer with `expectReminderTo1to1('confirmation', tenant, 2)`. |
| (d) opted-out item reads suppressed | self-seed tenant → opt out (`postInboundSms {body:'STOP'}` OR the Do-Not-Contact menu) → book + tick the rung → assert the future item rendered SUPPRESSED (not delivered) and `expectNoOutboxMessageContaining(tenant, TOUR_REMINDER_BODIES.confirmation)`. Remember the poller stamps `sentAt` on refusal but never delivers — visibility must not equate `sentAt` with delivered. |

---

## 8. Key files index (all `w:/tmp/sched-msg-visibility`)

- `app/src/routes/dev.ts` — all dev/tick endpoints.
- `app/src/lib/devRoutes.ts`, `app/src/lib/config.ts`, `app/src/middleware/originSecret.ts` — prod gating.
- `app/src/adapters/recordingMessaging.ts` — `/__dev/outbox` record shape (deprecated).
- `app/src/jobs/tourReminders.ts`, `app/src/repos/tourRemindersRepo.ts` — tour ladder + rows.
- `app/src/jobs/placementNudges.ts`, `app/src/repos/placementNudgesRepo.ts` — nudge ladder + rows.
- `e2e/scenarios/steps.ts` — the `Scenario` verb class (ticks, clock helpers, assertions).
- `e2e/tests/scenarios/tours.spec.ts` — reminder arm/tick/reschedule reference.
- `e2e/tests/scenarios/post-tour-application.spec.ts` — placement-nudge reference.
- `e2e/fixtures/fakeTwilio.ts` — `listThreads`/`sendAsParty`/`registerParty`/`postInboundSms`.
- `e2e/tests/dashboard-next/a2p-compliance.spec.ts`, `e2e/tests/dashboard-next/contact-detail.spec.ts` — opt-out mechanisms.
- `app/src/lib/seed/live.ts` (full-profile armed ladders), `app/src/lib/seed/matrix.ts` (archive rows).
- `e2e/README.md` — harness modes, lanes, dev-surface gating.
