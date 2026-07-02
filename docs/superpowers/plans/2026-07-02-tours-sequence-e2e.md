# Tours Sequence — feature gaps + e2e scenario suite (Plan)

> **For agentic workers:** implement task-by-task with TDD (backend first). Steps use `- [ ]`.
> Source of truth: `documentation/tours-sequence.mermaid` + `documentation/tours-sequence-writeup.md`
> (founder-approved 2026-07-02). The code moves toward the diagram, never the reverse.

**Goal:** close the tours feature gaps the diagram documents, then encode the sequence as
`e2e/tests/scenarios/tours.spec.ts` per `documentation/sequence-diagram-to-test.md`.

**Worktree:** `w:/tmp/tours-seq`, branch `feat/tours-sequence`. e2e is lane-isolated
(this worktree prefers lane 7: app :9701 / dashboard :9711 / fake :9721, `hc-local-7-*`);
**127.0.0.1 everywhere, never localhost**; specs resolve lanes automatically via
`e2e/support/lane.mjs` — never hardcode ports (import `e2e/support/urls.ts` / use env).

## Conformance-audit findings (live, lane 7, 2026-07-02)

Confirmed against the running hermetic stack + a 5-reader code sweep:

1. **Timeless create missing (gap 1).** `POST /api/tours` requires all of
   `{tenantId, unitId, scheduledAt, tourType}` (400 `scheduledAt must be a valid ISO 8601
   datetime` observed live) and arms the reminder ladder at create (`tours.ts:167-168`).
   No pre-`scheduled` status exists (`TOUR_STATUSES` = scheduled|confirmed|toured|no_show|
   canceled|closed). The `byScheduledAt` GSI is sparse, so storage tolerates a missing
   `scheduledAt`; only types/validation block it. Seam found: `PATCH {status:'scheduled'}`
   alone never re-arms (re-arm keys only on `scheduledAt` presence, `tours.ts:327-330`).
2. **Reminders are 1:1-only (gap 2).** `processReminderRow` resolves the tenant's
   `tenant_1to1|unknown_1to1` conversation by phone and sends via `sendMessageService`
   (`tourReminders.ts:229-265`); `tour.groupThreadId`/`tourType` are never consulted.
   Two hard constraints for the fix: `sendMessage.ts:223` **throws on relay_group**
   conversations (`RelaySendNotSupportedError`), and **the worker process cannot enqueue
   jobs** (no OutboundQueueAdapter configured in `worker.ts` — `jobs.enqueue` throws), so
   the group path must use **direct per-member adapter sends from the pool number**,
   mirroring the `relay.intro` handler (`relayFanOut.ts:458-504`). Claim-before-send
   (`claimSend`, condition on `sentAt`/`canceledAt` absent) must be preserved.
3. **Status controls missing in UI (gap 3).** `PATCH {status}` for
   `confirmed`/`toured`/`no_show` verified live (200s). TourDetail has only
   Reschedule / 'Cancel tour' / exit gate — so **the exit gate is unreachable through the
   UI alone** today (it gates on `status==='toured'`).
4. **No open-group affordance (gap 4) — and the create dialog doesn't exist at all.**
   `createTourRelay` (dashboard `endpoints.ts:1045`) has zero callers. Bigger than briefed:
   `TenantFile`'s `onScheduleTour`/'+ Schedule' CardAction is **never wired**
   (`ContactDetail` doesn't pass it) and no ScheduleTourForm component exists — the tours
   diagram's very first [MANUAL] step has no UI. Also verified live: **a second
   `POST /api/tours/:id/relay` silently provisions a new pool number and overwrites
   `groupThreadId`**, orphaning the first thread ("one thread per tour" is unenforced).
5. **Relay backbone works (no gap).** Live: relay 201 → pool `+15550190001`,
   `groupThreadId` stamped, `[AUTO]` intros naming both members delivered to each member's
   fake thread FROM the pool number. Member→group fan-out via `send-as-party` to the pool
   number; staff→group via `POST /api/conversations/:id/messages`. Inbox **excludes**
   relay_group conversations — there is no dashboard surface to view/post into a group
   (TourDetail's 'View group thread' link goes to bare `/inbox`, a dead end): out of scope
   here, noted as a follow-up issue.
6. **No deterministic reminder firing for e2e.** Worker polls `runDueTourReminders(now,
   deps)` on a 60s wall-clock `setInterval`; the function is stateless + fully injectable —
   a `/__dev` tick endpoint is the missing seam. Time compares are **lexicographic ISO
   string** compares: an injected `now` MUST be full `toISOString()` format (with `.000`
   milliseconds). Firing many rungs into one 1:1 thread counts against the send breaker
   (`SEND_BREAKER_MAX_PER_MINUTE` default 10) — specs tick rungs individually.
7. **Exit gate is placement-free (verified).** `{outcome, moveForward}` →
   `convertible = (moveForward===true)`; no placement, no tenant-status change (existing
   app tests assert this). `expectHandoffToTours` in steps.ts is a placeholder (asserts
   listing_send + still-searching only) with a stale "Tours is NOT built" comment; the
   playbook has the same stale line.
8. Misc: stale `TourOutcome` type in `toursRepo.ts:46` (`'completed'|'no_show'|'cancelled'`)
   contradicts `toursModel.ts` (`move_forward|not_a_fit`) — fix in passing. Tour relay
   members require explicit `{phone}` (no auto-resolution, no name lookup from contactId).

## Global constraints (binding)

- Tours are SEPARATE from placements: nothing here creates a placement or changes tenant
  status — tenant stays `searching` throughout; exit gate records outcome/moveForward/
  convertible only.
- Masked groups are **Team-created by hand** (a button click), never auto-created.
- "Team", never a founder name. Staff copy says "property"; tenant copy says "home";
  code says `unit`. PII: never log phone numbers (ids only — match tourReminders idiom).
- e2e: self-clean isolation (fresh timestamped contacts; NO per-test `/__dev/reseed`);
  mostly-UI for Team actions, API/fake seam for tenant+landlord inbound; assert what Team
  SEES scoped to its card/section; accessibility-first selectors; assert rendered LABELS
  ('Requested', 'No show'), not raw enums. Em dashes in exit-gate labels.
- TDD everywhere: failing test first. Frequent small commits, conventional messages.

## Decisions (locked for this build)

- **`requested`** is the new pre-scheduled status (first in `TOUR_STATUSES`, label
  `'Requested'`). POST: `scheduledAt` now optional — absent → status `requested`, no
  arming; present → status `scheduled` + arm (unchanged back-compat).
- **Booking** = PATCH carrying `scheduledAt` on a `requested` tour → status auto-advances
  `requested→scheduled` (when no explicit `status` in the patch) + cancel/arm ladder (cancel
  no-ops on empty). `requested` joins `RESCHEDULABLE` (booking rides the same guard); new
  guard: target `scheduled` with no `scheduledAt` (patch or stored) → 400
  `scheduledAt is required to schedule this tour`.
- **Reminder routing:** group path iff `tourType !== 'self_guided'` AND `groupThreadId`
  set AND that conversation exists, is `relay_group`, and not closed → claim once, then
  direct adapter sends from `pool_number` to every non-suppressed member (same `[AUTO]`
  bodies, NOT persisted as app messages — the relay.intro precedent). Anything else →
  existing tenant-1:1 path. `self_guided` stays 1:1 even when a group exists (founder).
- **Tour relay route:** `members` becomes optional — when absent/empty, auto-resolve
  `[tenant contact, unit's landlord contact]` (phones + names from contacts; skip a member
  with no phone with a 400 naming the problem). Explicit members still honored; resolve
  missing `name` from `contactId` when given. New guard: existing `groupThreadId` → 409
  `{error:'relay_already_provisioned'}`.
- **Dev seam:** `POST /__dev/tour-reminders/tick {now?}` in `createDevRouter` (same triple
  gate; OFF in every deployed env) → `runDueTourReminders(now ?? nowIso, deps)` with deps
  built exactly as `worker.ts` builds them → `{ok:true}`.
- **Proof-of-send in e2e:** primary = fake `/control/threads` (extend e2e `FakeThread` with
  `from` — already on the wire) — group reminders = same body in EACH member's thread from
  the pool number (`/^\+1555019\d{4}$/`); `/__dev/outbox` only where its `?to=` filter helps.

---

## Task 1 — Backend: `requested` status + timeless create + booking arms the ladder

**Files:** `app/src/lib/toursModel.ts`, `app/src/repos/toursRepo.ts`,
`app/src/routes/tours.ts`; tests `app/test/toursModel.test.ts`, `app/test/toursApi.test.ts`
(+ `toursRepo.integration.test.ts` if it asserts required scheduledAt).
- [ ] RED: route tests — POST without `scheduledAt` → 201 `{tour}` with `status:'requested'`,
  no `scheduledAt`, and NO reminder rows armed; POST with `scheduledAt` unchanged
  (`scheduled` + armed); PATCH `{scheduledAt}` on a `requested` tour → 200, status
  `scheduled`, ladder armed with dueAts off the injected clock; PATCH
  `{status:'scheduled'}` on a `requested` tour with no time → 400; `requested` tour
  PATCH `{status:'canceled'}` → 200; model tests for the new enum/label/canReschedule.
- [ ] GREEN: add `requested` (+ label, first in array); `scheduledAt` optional in
  `TourItem`/`CreateTourInput` (sparse GSI already tolerates absence); route create branch
  (arm only when scheduledAt present; status default by presence); booking auto-advance +
  the no-time→scheduled 400 guard; add `requested` to `RESCHEDULABLE`; fix the stale
  `TourOutcome` type in toursRepo.
- [ ] Full app suite green + typecheck (app AND dashboard — dashboard `Tour.scheduledAt`
  type must go optional in **Task 4**, so if dashboard typecheck breaks here, coordinate:
  make ONLY the `types.ts` type change here, UI rendering in Task 4). Commit.

## Task 2 — Backend: group-thread reminder routing

**Files:** `app/src/jobs/tourReminders.ts` (+ deps type), `app/src/worker.ts` (wire the
adapter dep), tests `app/test/tourReminders.test.ts`.
- [ ] RED: landlord_led tour with groupThreadId → tick sends the rung body to EVERY group
  member from the pool number via the adapter, exactly once (claim), nothing via
  sendMessageService; self_guided with a groupThreadId → 1:1 path (founder rule);
  landlord_led with NO group / missing conversation / closed conversation → 1:1 fallback;
  suppressed (sms_opt_out) member skipped; claim-race still exactly-once.
- [ ] GREEN: extend `RunDueTourRemindersDeps` with the messaging adapter (mirror how the
  relay.intro handler gets one) + `unitsRepo`-free member source = the relay_group
  conversation's `participants`; group branch per the Decisions above; logging ids-only,
  matching existing vocabulary (`tour reminder sent` + a routing discriminator field).
- [ ] Full app suite green. Commit.

## Task 3 — Backend: relay auto-membership + one-thread-per-tour + dev tick

**Files:** `app/src/routes/tours.ts` (relay route), `app/src/routes/dev.ts`,
`app/src/lib/devRoutes.ts`/`app/src/index.ts` only if dep threading requires it;
tests `app/test/toursApi.test.ts`, dev-route test file (mirror existing dev tests).
- [ ] RED: relay POST with no body/members on a tour whose tenant+landlord have phones →
  201 with both members (names resolved) — assert intro roster; second POST → 409
  `relay_already_provisioned`; explicit-members path still works; member with contactId
  and no name gets the contact's name; tick endpoint: POST `/__dev/tour-reminders/tick`
  `{now}` fires due rows (assert via outbox/adapter double), rejects malformed `now` (400),
  and is absent when dev gating is off.
- [ ] GREEN per Decisions. NOTE: the existing test asserting 400 for missing members must be
  UPDATED to the new auto-resolve contract (it is superseded by the founder flow, not a
  regression). Commit.

## Task 4 — Dashboard: Schedule-a-tour dialog + timeless rendering + Book control

**Files:** new `dashboard/src/routes/tours/ScheduleTourForm.tsx` (+ test),
`dashboard/src/routes/contact/ContactDetail.tsx` (wire `onScheduleTour`),
`dashboard/src/routes/contact/TenantFile.tsx` + `LandlordFile.tsx` (row date rendering),
`dashboard/src/routes/tours/TourDetail.tsx` (+ test), `dashboard/src/api/types.ts`
(`'requested'` + label + `scheduledAt?`), `dashboard/src/api/endpoints.ts`
(`createTour` scheduledAt optional).
- [ ] RED (component tests, mirror PlacementCreateForm + TourDetail idioms): dialog
  'Schedule a tour' with Unit combobox, 'Tour type' select (3 labels), OPTIONAL
  'Date and time' input + helper copy "Leave empty to create the tour without a time —
  book it later."; submit 'Schedule' → createTour called WITHOUT scheduledAt when empty;
  onCreated → caller navigates `/tours/:tourId`. TenantFile '+ Schedule' renders now that
  ContactDetail wires it. Tours-card rows render 'Not booked' when no scheduledAt (no
  'Invalid Date'). TourDetail: `requested` tour shows Status 'Requested', Scheduled dd
  'Not yet booked', a 'Book tour' control (form label 'Date and time', submit
  'Confirm booking') → `patchTour {scheduledAt, status:'scheduled'}`; Reschedule hidden for
  `requested`; 'Cancel tour' visible for `requested`.
- [ ] GREEN; full dashboard suite + typecheck. Commit.

## Task 5 — Dashboard: status controls + open-group affordance

**Files:** `dashboard/src/routes/tours/TourDetail.tsx` (+ test), `endpoints.ts` if
createTourRelay needs an optional-members signature.
- [ ] RED: 'Confirm tour' (shown status==='scheduled') → patch `{status:'confirmed'}`;
  'Mark toured' (scheduled|confirmed) → `{status:'toured'}` — making the exit gate
  reachable; 'Mark no-show' (scheduled|confirmed) → `{status:'no_show'}`;
  'Open group thread' button (shown when `!groupThreadId`) → `createTourRelay(tourId, {})`
  → on 201 the tour refreshes and the 'Group thread' row appears (keep the existing
  /inbox link as-is).
- [ ] GREEN; dashboard suite + typecheck. Commit.

## Task 6 — e2e: tour verbs + `tours.spec.ts` + handoff upgrade

**Files:** `e2e/scenarios/steps.ts`, `e2e/fixtures/fakeTwilio.ts` (FakeThread `from`),
new `e2e/tests/scenarios/tours.spec.ts`, `e2e/tests/scenarios/sending-unit.spec.ts` (tail).
Fresh stack etiquette: `npm run e2e:stop` first; iterate uncommitted (freshness guard);
`npm run e2e:restart` after backend edits.
- [ ] Verbs (audit selectors live before finalizing): `tenantAsksToTour`,
  `teamCreatesTourFromInterest` (the new dialog, NO time → asserts 'Requested'),
  `teamOpensTourGroup` (TourDetail button; capture pool number via API),
  `expectGroupIntros`, `partyProposesTimeInGroup`/`expectRelayedInGroup` (both directions,
  masked: from=pool, `Name: body` prefix), `teamBooksTour` (Book control) +
  `expectBookingConfirmed` (confirmation rung after tick), `tickTourReminders(now)`
  (full-ms ISO!), `expectReminderInGroup(kind)` / `expectReminderTo1to1(kind)`,
  `tenantSendsOnMyWay` + `expectOnMyWayRelayedToGroup`, `teamConfirmsTour`,
  `teamMarksToured`, `teamMarksNoShow`, `teamOffersTourWindows`/`tenantPicksWindow`
  (1:1, self-guided), ID gate: `teamRequestsPhotoId`, `tenantSendsPhotoId` (MMS with a
  fake-host media URL if the live check shows clean logs — else text-only with a comment;
  the ASSERTED invariant is gate ordering), `expectNoLockboxCodeYet` (assert the code
  string absent from the tenant thread BEFORE the send), `teamSendsLockboxCode`,
  `teamRecordsExitGate(yes|no)` (em-dash radio labels), `expectTourConvertible`,
  `expectTourClosedNotAFit`, `expectTenantStillSearching`, `expectNoPlacement` (GET
  /api/placements?tenantId → none). Upgrade `expectHandoffToTours(unit)`: tour record
  exists for tenant+unit (`GET /api/tours?tenantId=`), status 'Requested' rendered on the
  Tours card, tenant still `searching`; fix its stale doc-comment.
- [ ] `tours.spec.ts` — one test per branch: (1) landlord-led happy path through exit gate
  YES → convertible=true + NO placement + still searching; (2) PM-team path → exit NO →
  not_a_fit + closed + still searching; (3) self-guided: windows 1:1 (assert NO group
  created), ID gate ordering, lockbox code, toured; (4) no-show: booked, no on-my-way,
  tick past +30m → no_show_checkin fires, team reschedules → ladder re-arms (fresh
  confirmation after tick) and/or mark no-show → still reschedulable. Extend the
  sending-unit spec tail: tenant texts tour interest → `teamCreatesTourFromInterest` →
  upgraded `expectHandoffToTours`.
- [ ] Green in isolation, then commit.

## Task 7 — Gates, docs, hygiene

- [ ] Playbook: add "Audit-surfaced realities — tours (the fourth diagram)" (incl. the
  worker-can't-enqueue + relay_group-send-refusal constraints, lexicographic-ISO tick trap,
  breaker cap, pool-number regex, FakeThread.from extension) and FIX the stale
  "Tours is a SEPARATE, unbuilt workflow… don't invent a Tours feature" lines; add the
  fourth worked example to Files.
- [ ] Issues: file `relay-group-no-dashboard-surface` (view/post into a masked group —
  inbox excludes relay_group; TourDetail link is a dead end) unless already covered;
  cross-check `group-threads-across-multiple-tours.md`, `tour-took-place-milestone.md`.
- [ ] `npm test` all workspaces green; FULL `npm run e2e` green (fresh stack).
- [ ] Merge latest `main` (check more than once if long); resolve keeping both sides;
  re-run both suites green. NEVER merge into main. Report.
