<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-04).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). Kept only as a point-in-time record of intent.

# Quiet Hours for Automated Sends + Send Now - Design

- Date: 2026-08-03
- Status: approved by Cameron (brainstorm session); ready for implementation planning
- Scope: backend send scheduling + gating, org settings, dashboard Settings UI,
  Send-now controls on tour reminders and placement nudges

## 1. Problem

Automated outbound messages can fire in the middle of the night. The concrete
trigger: the `morning_of` tour reminder is hardcoded to 08:00 UTC
(`app/src/jobs/tourReminders.ts`, `computeDueAt`), which is 3-4am Eastern, so
"your tour is today" texts land at 4am. More broadly there is no quiet-hours
concept anywhere in the send paths (confirmed by prior research:
`docs/research/scheduled-message-visibility/03-send-gates.md`), and the backend
is deliberately timezone-agnostic - no org timezone exists server-side. This
feature introduces both.

## 2. Decisions (locked during brainstorm)

1. **Behavior: defer, never drop.** An automated message that would send during
   quiet hours sends when the window ends instead. Nothing is silently lost.
2. **Exempt (always send immediately):**
   - STOP/HELP keyword confirmations (compliance-locked, TCPA)
   - Cell-verification codes (transactional)
   - Missed-call auto-text (the person just called us; they are awake)
   - Relay fan-out of a member's own text (relaying a human's message)
   - Public-intake welcome SMS (they just submitted the form)
3. **Not gated because human-triggered:** staff composer sends, manual no-show
   check-in, broadcasts (staff clicks Send), relay announcements (group intro /
   member-added / group-closed - all fire from a staff action), staff retry of
   a failed message.
4. **Window: 21:00 - 08:00, org timezone America/New_York**, admin-editable.
5. **Mechanism: arm-time clamping as primary, fire-time backstop as safety
   net.** Chosen over pure fire-time checking so the stored `dueAt` (and
   everything the dashboard shows) is the honest, real send time, with no
   nightly re-polling; and over pure arm-time so rows armed before this ships
   (including every existing 4am row) and worker-downtime catch-up are still
   covered. Settings changes after arming intentionally do NOT re-clamp
   existing rows (accepted; the backstop still prevents in-window sends).
6. **Send now:** staff can force-send any pending reminder/nudge immediately,
   bypassing quiet hours. Folded into this feature because quiet hours creates
   the need, it touches the same files, and `claimSend` already provides the
   concurrency safety.

## 3. Settings and timezone

Four new fields on the existing `OrgSettings` singleton
(`app/src/repos/settingsRepo.ts`, item `settingId = 'org'`; schemaless, no
migration):

| Field | Type | Default |
|---|---|---|
| `quietHoursEnabled` | boolean | `true` |
| `quietHoursStart` | string `"HH:MM"` 24h | `"21:00"` |
| `quietHoursEnd` | string `"HH:MM"` 24h | `"08:00"` |
| `timezone` | string, IANA zone id | `"America/New_York"` |

- Validation in the existing `parsePatch` (`app/src/routes/settings.ts`):
  HH:MM must match `^([01]\d|2[0-3]):[0-5]\d$`; timezone must be resolvable by
  `Intl.DateTimeFormat` (construct-and-catch). Reject `quietHoursStart ===
  quietHoursEnd` (a zero-length window; use `quietHoursEnabled: false` to turn
  the feature off).
- `GET /api/settings` (any authed user), `PUT /api/settings` (admin only),
  existing `settings_updated` audit event. Defaults added to
  `DEFAULT_ORG_SETTINGS` and defensive parsing in `toOrgSettings()`.
- The dashboard's hand-mirrored types (`dashboard/src/api/types.ts`,
  `OrgSettings` / `SettingsPatch`) get the same fields - both sides must stay
  in sync.

## 4. Core module: `app/src/lib/quietHours.ts`

Pure functions, injected time, no inline `Date.now()` (repo discipline). All
functions take the IANA timezone as an argument - never read from a global.

- `isQuietTime(now: Date, window): boolean` - is this instant inside the
  quiet window, evaluated in the window's timezone?
- `clampOutOfQuietHours(due: Date, window): Date` - identity if outside the
  window; otherwise the end of the window containing `due` (e.g. 08:00 local
  that morning).
- Window semantics: start-inclusive, end-exclusive (`[21:00, 08:00)`); a send
  clamped to exactly 08:00 is legal. The window wraps midnight; wrapping is
  local-time wrapping, never UTC.
- Timezone math via `Intl.DateTimeFormat` with `timeZone` +
  `formatToParts` - no new dependency. DST handled with a two-pass offset
  correction when materializing "08:00 local on day D" as a UTC instant.
- Disabled (`quietHoursEnabled: false`) means `isQuietTime` is always false
  and `clampOutOfQuietHours` is identity.
- Failure posture: if settings cannot be read at a call site, fall back to
  `DEFAULT_ORG_SETTINGS` values rather than failing the send path (same
  posture as `resolveWithSettings` in `app/src/messages/resolve.ts`).

### Timezone resolver seam (future: per-recipient)

One helper, `resolveQuietHoursTimezone(contact?) -> string`, used by every
call site. Today it always returns the org setting; the signature and a
comment document the extension point: when the org scales beyond one timezone,
a contact-level (or future client-org-level) `timezone` field overrides here,
making quiet hours - and eventually `morning_of` - recipient-local by touching
only this resolver. No contact field or UI is built now.

## 5. Arm-time clamping (primary mechanism)

`computeDueAt` (tour reminders) and `armNudgeForStage` (placement nudges)
clamp every computed `dueAt` with `clampOutOfQuietHours` BEFORE writing the
row. Stored times are real send times; dashboard display stays honest; no
re-polling in normal operation. Both armers gain a `settingsRepo` dependency
(worker wiring in `app/src/worker.ts` and dev-tick wiring in
`app/src/routes/dev.ts` updated to match).

- `morning_of` is redefined from 08:00 UTC to **08:00 org-local** (then
  clamped like everything else, which matters if quiet-end is later than
  08:00). This kills the 4am text at its source.
- Storage and comparison stay pure UTC ISO strings compared
  lexicographically - unchanged. Only window evaluation converts to local
  wall-clock.

### Supersession rule (same-slot collisions)

The tour ladder is ordered by proximity to the event: `confirmation` <
`day_before` < `morning_of` < `en_route`. Clamping can only push an EARLIER
rung forward into a LATER rung's slot, and when that happens the earlier
rung's copy is stale ("tour is tomorrow" on tour day). General rule, no
manual pair list:

1. **Same-slot collision:** when clamping lands multiple rungs of one tour's
   ladder on the same clamped instant, only the latest rung (closest to the
   event) sends. Earlier ones are retired with skip reason
   `quiet_hours_superseded` (following the existing skip-row precedent used
   for past `day_before` rungs).
2. **Past-event clamp:** if clamping would move a rung to at-or-past the
   tour's start time, the rung is skipped (extends the existing "skip
   `day_before` when already past" behavior).
3. **Copy-validity clamp:** a rung whose copy is only valid before a semantic
   boundary is superseded if clamping moves it across that boundary even
   without an exact slot collision. Concretely: `day_before` ("your tour is
   tomorrow") is superseded by `morning_of` if clamping moves it onto the
   tour's LOCAL date, regardless of exact times. (With default settings the
   same-slot rule already covers this - it matters only if quiet-end is set
   earlier than 08:00, where `day_before` could otherwise clamp to e.g.
   07:00 on tour day and send "tomorrow" on the wrong day.)

Worked examples (accepted behavior):
- Tour tomorrow 22:00: `day_before` (21:00 tonight) clamps to 08:00 tour day,
  colliding with `morning_of` -> `day_before` superseded; only "your tour is
  today" sends.
- Tour at 08:30: `en_route` (06:30) clamps to 08:00, colliding with
  `morning_of` -> only `en_route` sends.
- Tour scheduled at 23:00 for tomorrow: `confirmation` clamps to 08:00; if
  that collides with `morning_of`, confirmation is superseded (morning-of
  copy carries the tour details).
- Tour at 07:30: every same-day rung clamps past the start and is skipped;
  the tenant's last reminder was `day_before` the prior morning. Accepted.

Applied at arm time (all rungs armed together, collisions resolved before
rows are written) AND in the fire-time backstop (so legacy rows released
together at quiet-end do not double-fire: before sending rung A, if a later
unclaimed rung for the same tour is also due, A is skipped as superseded).

Placement nudges arm one rung per stage and cannot self-collide; no
supersession logic there. Cross-entity coincidences (a nudge and a tour
reminder both at 08:00 for the same person) are different messages about
different things and stay allowed.

Accepted edge cases (by design, not bugs):
- A tour scheduled late in the evening gets its confirmation at 08:00 next
  morning - automated sends defer by policy; staff can use Send now.
- `day_before` and `morning_of` merging into one 08:00 message per the
  supersession rule.

## 6. Fire-time backstop + honest dashboard

One pre-claim check in `processReminderRow` and `processNudgeRow`: if
`isQuietTime(now)` (and the row is not exempt), return WITHOUT claiming - the
row stays live in `listDue` and re-fires on a later tick, sending within one
poll interval of quiet-end. Critically this check runs BEFORE `claimSend`;
it must never be implemented as a `SendRefusedError` after claiming, because
refusals keep the claim and would permanently destroy the message.

- Never triggers in normal operation (dueAts are pre-clamped). Exists for:
  rows armed before this feature ships (including existing 4am `morning_of`
  rows), worker-downtime catch-up releasing stale rows at night, and as the
  guarantee that a DST edge-case miscomputation in clamping can never
  actually send inside the window.
- `'quiet_hours'` is added to `ScheduledSuppressionReason`
  (`app/src/services/scheduledSendSuppression.ts`) - last in the precedence
  order (least severe; kill-switch / opt-out / manual-mode all outrank it) -
  so the tour-reminder and placement-nudge panels show WHY a row is waiting.
- The backstop also applies the supersession check for legacy rows (section 5).
- Exempt and human-triggered paths (section 2) are simply untouched - no gate
  is added to their code.

## 7. Send now (force-send a pending reminder/nudge)

A **Send now** action on every pending (not sent / canceled / skipped)
tour reminder and placement nudge, shown in the tour detail reminders panel
and the placement detail nudges panel next to the existing suppression chip.
Headline use case: "confirmation says 8:00am, I want it out now."

- **Endpoints:** `POST /api/tours/:tourId/reminders/:reminderId/send-now` and
  the placement-nudge equivalent. Auth: any staff role (admin and VA) - staff
  can already send equivalent messages via the composer, so no new privilege
  is implied.
- **Mechanics:** the endpoint atomically claims the row with the same
  `claimSend` the poller uses, then runs the same resolve-and-send path the
  poller runs (body, target resolution, group routing stay single-sourced).
  If the poller wins the race, the endpoint reports the row as already sent;
  exactly one send ever happens.
- **Gating:** human-triggered, so it bypasses quiet hours and the
  automated-only gates (manual mode, per-conversation circuit breaker). It
  still respects the absolute gates - kill switch and opt-out - and the
  staleness checks (a nudge whose placement stage has moved refuses rather
  than sending stale copy). Refusals return a visible, honest error to the
  UI; never a silent no-op. On refusal the row must NOT be left claimed-but-
  unsent (check gates before claiming, mirroring the backstop's
  check-before-claim ordering).
- **Ladder semantics:** force-sending one rung does not reschedule or cancel
  the others; their dueAts stand and the supersession rule applies to them
  normally at their own fire time.
- **Audit:** the existing audit-event pattern records who clicked; the
  message lands in the conversation like any other sent reminder.

## 8. Settings UI

A "Quiet hours" section on the admin-only **System** tab
(`dashboard/src/routes/settings/`), following the `useSettings` +
`TemplatesSection` pattern (GET on mount, PATCH only changed fields):

- On/off toggle (`quietHoursEnabled`), start and end time inputs.
- Timezone displayed as fixed text ("Eastern - America/New_York"), not
  editable in this phase.
- VAs see the section read-only (PUT is admin-only), per the existing
  pattern.

## 9. Testing

Unit (Vitest, `app/test/`):
- `quietHours` module: wrap-around window, start-inclusive/end-exclusive
  boundaries, disabled state, clamping identity outside the window,
  DST spring-forward and fall-back nights (including the repeated fall-back
  hour), and explicit UTC/local rollover seams - 23:00 ET (already tomorrow
  in UTC) counts as tonight's window; 19:00 vs 20:01 ET on the same UTC
  date; clamps that cross a UTC date boundary but not a local one and vice
  versa.
- Arm-time: `computeDueAt` clamps every rung; `morning_of` is 08:00
  org-local (existing UTC expectations in `app/test/tourReminders.test.ts`
  updated); `armNudgeForStage` clamps; supersession - collided rungs retired
  with `quiet_hours_superseded`, past-event rungs skipped; settings-read
  failure falls back to defaults.
- Backstop: in-window row is NOT claimed and survives for the next tick;
  out-of-window row sends; legacy same-tour supersession at release time;
  `quiet_hours` suppression reason surfaces in the reminder/nudge API views
  (`tourRemindersApi` / `placementNudgesApi` view tests) with correct
  precedence (`scheduledSendSuppression` precedence test extended).
- Send now: claim race (endpoint vs poller - exactly one send), quiet-hours
  bypass, kill-switch and opt-out refusals surface as errors without
  claiming, stale-stage refusal, already-sent reporting.
- Settings: `parsePatch` accepts valid HH:MM/timezone, rejects malformed
  values and start==end; admin-only enforcement; audit event.

E2e (Playwright, `e2e/`):
- Settings page: admin edits quiet hours, saves, values persist; VA sees
  read-only.
- Defer behavior via the dev seams: `POST /__dev/tour-reminders/tick {now}`
  with an in-window `now` -> dev outbox empty, row still pending with the
  quiet-hours suppression chip visible; tick again past quiet-end -> message
  in outbox, row sent.
- Send now: click the button on a deferred reminder -> message appears in
  the outbox immediately, row shows sent.

Both dashboards' existing suites (`TemplatesSection.test.tsx` etc.) extended
for the new Settings section.

## 10. Out of scope (explicitly)

- Per-contact / per-client-org timezones (seam only, section 4).
- Quiet-hours gating for email or voice originate paths (no automated
  night-time senders exist there today).
- Re-clamping already-armed rows when settings change (backstop covers the
  safety property).
- Any hold-for-review queue (defer is automatic).
- Multi-unit "building/parcel" concerns - none touched.
