# Implementation plan - tour auto-close and reopen

- Spec (the contract - read it in full before Task 1.1):
  `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`
- Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`, cut from
  main @ae04122d. Mission records:
  `docs/superpowers/reviews/2026-10-01-tour-auto-close/`.
- Status: PLAN v2 (against spec DRAFT 3; adversarial plan review round 1).

## 0. Ground rules for this plan

- Every task is TDD: write the test, run it RED (and confirm it is red for the
  stated reason), implement, run it GREEN, commit. One commit per task unless
  the task says otherwise.
- Commits: `git status` first (a separate read), explicit paths only (never
  `git add -A`), ASCII message ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the authoring
  model's name).
- Every new/touched line in code, comments, tests, copy and docs is ASCII.
  Check: `tr -d '\11\12\15\40-\176' < FILE | wc -c` prints 0 for new files;
  for edited files check the added lines of `git diff`.
- Never rewrite source with PowerShell `Get-Content | -replace | Set-Content`.
  Use the Edit tool. The Edit tool DECODES `\u` escapes - never type a `\u`
  escape through it.
- Run commands with absolute paths (`cd "W:/tmp/tour-auto-close/app"` etc.);
  the shell's working directory resets between calls.
- Setup once: `cd "W:/tmp/tour-auto-close"; npm ci`. DynamoDB Local:
  `npm run db:start` (a START of a stopped container is fine). NEVER restart,
  stop or remove the shared DynamoDB Local container - it holds Cameron's
  local dev data. If it misbehaves, stop and report.
- Unit runs while building: app `cd "W:/tmp/tour-auto-close/app"; npx vitest
  run test/<file>`; dashboard `cd "W:/tmp/tour-auto-close/dashboard"; npx
  vitest run src/<path>`; typecheck `cd "W:/tmp/tour-auto-close"; npm run
  typecheck`. Never pipe a gate command.
- e2e only through `npm run e2e` from the worktree root (or the lane session
  scripts). Never edit dashboard/app source while that worktree's e2e runs
  (the lane serves source live).

## 1. Global constraints (verbatim from the spec)

| name | value |
|---|---|
| new outcome | `'no_outcome'`, label `'No outcome recorded'`, system-only |
| staff outcomes | `['move_forward', 'not_a_fit']` |
| `AUTO_CLOSE_AFTER_MS` | `14 * 24 * 60 * 60 * 1000` (1209600000) |
| `AUTO_CLOSE_STATUSES` | `['scheduled', 'toured', 'no_show']` |
| clock start | latest of `createdAt`, `scheduledAt` (non-empty), and the mark: `lastMarkedAt` when present, otherwise `updatedAt` |
| `TOUR_AUTO_CLOSE_INTERVAL_MS` | `15 * 60 * 1000` (worker poll; code constant, no env var) |
| new attributes | `autoClosedAt`, `autoClosedFrom`, `lastMarkedAt` |
| new activity types | `tour_auto_closed`, `tour_reopened` |
| person-timeline labels | `'Tour closed automatically: no outcome recorded after two weeks'`, `'Tour reopened'` |
| tour-page labels | `'Closed automatically: no outcome recorded after two weeks'`, `'Tour reopened'` |
| property labels | `'Tour closed automatically: no outcome recorded after two weeks'`, `'Tour reopened'` |
| reopen route | `POST /api/tours/:tourId/reopen`, empty body |
| reopen errors | 404 `tour_not_found`; 409 `tour_not_closed`, `tour_converted`, `tour_reopen_unsupported`, `tour_changed`; 400 `unknown field(s): ...` |
| PATCH race error | 409 `{ error: 'tour_changed', detail: 'This tour changed while you were saving - reload and try again.' }` |
| dev tick | `POST /__dev/tour-auto-close/tick` `{ now?, tourIds? }`; `tourIds`: 1..50 non-empty strings |
| dev tick 400s | `'now must be a valid ISO 8601 datetime'`, `'tourIds must be a non-empty array of at most 50 tour ids'` |
| reopen dialog | title `'Reopen tour'`, buttons `'Cancel'` / `'Yes, reopen'` |
| Reopen placement | primary CTA when the ladder has nothing else; kebab item ONLY when `convertible === true` puts "Start placement" in the primary slot; never both |
| Record outcome 409 | an `ApiError` 409 shows `'This tour changed since the page loaded - reload and try again.'` |
| reopen copy (toured) | `'This tour goes back to Toured so you can record a different outcome. Nothing is sent.'` |
| reopen copy (no_show) | `'This tour goes back to No show so you can reschedule it. Nothing is sent.'` |
| reopen copy (scheduled) | `'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.'` |
| reopen errors (UI) | 409: `'This tour changed since the page loaded - reload and try again.'`; other: `"Couldn't reopen the tour - please try again."` |
| outcome card | `'Closed automatically on <shortDate(autoClosedAt)>'` replaces the Moving forward row for `no_outcome` |
| Closed tab intro | `'Tours that ended - converted into a placement, closed as not a fit, closed automatically with no outcome, or canceled.'` |
| Past tab intro (append) | `' Tours with no outcome close on their own two weeks after their date or their last update.'` |

Things this change must NOT do: send any message, arm any reminder on
reopen, change any seed, add an env var, change infra or a GSI, rename the
Today section, add a manual no-show exit, let staff record `no_outcome`.

## 2. Work map

| slice | tasks | area |
|---|---|---|
| S1 model | 1.1 outcomes, 1.2 clock, 1.3 reopen target | `app/src/lib/toursModel.ts` |
| S2 repo | 2.1 types, 2.2 patch precondition, 2.3 autoCloseIf, 2.4 reopenIf | `app/src/repos/toursRepo.ts`, harness fake |
| S3 events | 3.1 activity types, 3.2 shared writer | `activityEventsRepo.ts`, new `lib/tourEvents.ts` |
| S4 PATCH | 4.1 staff outcome, 4.2 precondition + 409, 4.3 lastMarkedAt | `app/src/routes/tours.ts` |
| S5 sweep | 5.1 nag clear helper, 5.2 job, 5.3 worker, 5.4 dev tick | `jobs/tourAutoClose.ts`, `worker.ts`, `dev.ts` |
| S6 reopen | 6.1 route | `app/src/routes/tours.ts` |
| S7 chip | 7.1 listing chip | `app/src/lib/listingSendTour.ts` |
| S8 dashboard | 8.1 api, 8.2 pure module, 8.3 kebab, 8.4 dialog, 8.4b outcome-dialog 409, 8.5 tour page, 8.6 tours page, 8.7 Today, 8.8 labels | `dashboard/src/...` |
| S9 e2e | 9.1 Today spec rewrite, 9.2 new spec | `e2e/tests/dashboard-next/` |
| S10 docs | 10.1 glossary, 10.2 issues, 10.3 runbook | docs |
| S11 gates | main sync + the five gates | - |

Order: S1 -> S2 -> S3 -> S4 -> S5 -> S6 -> S7 -> S8 -> S9 -> S10 -> S11.
S4 changes the PATCH contract before the sweep exists: after S4 every PATCH
already carries the precondition, so nothing in between is left unguarded.
S8 depends on S6's route for its e2e only; its unit tests mock the client.

---

## S1 - model (`app/src/lib/toursModel.ts`, tests `app/test/toursModel.test.ts`)

### Task 1.1 - outcomes and the staff guard

RED: in `app/test/toursModel.test.ts`

- change `'contains exactly the two outcomes'` to expect
  `['move_forward', 'not_a_fit', 'no_outcome']` (rename the test to "the three
  outcomes");
- add `isTourOutcome('no_outcome') === true`;
- add a `TOUR_OUTCOME_LABELS.no_outcome === 'No outcome recorded'` pin;
- add a `STAFF_TOUR_OUTCOMES` block: equals `['move_forward', 'not_a_fit']`;
  `isStaffTourOutcome` true for both, false for `'no_outcome'`, `''`,
  `undefined`, `null`, `'converted'`.

GREEN: replace the "Tour outcomes (exit gate)" block (`toursModel.ts:64-83`)
with:

```ts
// --- Tour outcomes (exit gate + auto-close) ----------------------------------
// Recorded on the tour when it is decided. `move_forward` means the tenant is
// worth pursuing for a placement; `not_a_fit` ends the tour thread;
// `no_outcome` is written ONLY by the auto-close sweep (jobs/tourAutoClose.ts)
// when nobody recorded a decision two weeks after the tour's clock start
// (Sam #18, 2026-10-01). People record only STAFF_TOUR_OUTCOMES.
export const TOUR_OUTCOMES = ['move_forward', 'not_a_fit', 'no_outcome'] as const;

export type TourOutcome = (typeof TOUR_OUTCOMES)[number];

const TOUR_OUTCOME_SET: ReadonlySet<string> = new Set(TOUR_OUTCOMES);

export const TOUR_OUTCOME_LABELS: Readonly<Record<TourOutcome, string>> = {
  move_forward: 'Move forward',
  not_a_fit: 'Not a fit',
  no_outcome: 'No outcome recorded',
};

/** Is `x` a known tour outcome (any writer, including the sweep)? */
export function isTourOutcome(x: unknown): x is TourOutcome {
  return typeof x === 'string' && TOUR_OUTCOME_SET.has(x);
}

/** The outcomes a PERSON may record through PATCH /api/tours/:id. `no_outcome`
 *  is system-only: the auto-close sweep writes it and nothing else may. */
export const STAFF_TOUR_OUTCOMES = ['move_forward', 'not_a_fit'] as const satisfies readonly TourOutcome[];

export type StaffTourOutcome = (typeof STAFF_TOUR_OUTCOMES)[number];

const STAFF_TOUR_OUTCOME_SET: ReadonlySet<string> = new Set(STAFF_TOUR_OUTCOMES);

/** Is `x` an outcome a person may record (the PATCH exit-gate allowlist)? */
export function isStaffTourOutcome(x: unknown): x is StaffTourOutcome {
  return typeof x === 'string' && STAFF_TOUR_OUTCOME_SET.has(x);
}
```

Run `cd "W:/tmp/tour-auto-close/app"; npx vitest run test/toursModel.test.ts`
GREEN, then `npm run typecheck` from the root (an exhaustive `Record<TourOutcome,
...>` elsewhere in `app/` would now fail - fix any such map by adding the
`no_outcome` entry with the label above). Commit.

### Task 1.2 - the two-week clock

RED: new `describe('toursModel - auto-close clock')` in `toursModel.test.ts`
with a base fixture

```ts
const BASE = {
  status: 'scheduled',
  createdAt: '2026-09-01T00:00:00.000Z',
  scheduledAt: '2026-10-01T15:00:00.000Z',
};
const DUE = Date.parse('2026-10-15T15:00:00.000Z'); // scheduledAt + 14 days
```

and these cases (each its own `it`):

1. `AUTO_CLOSE_AFTER_MS === 1209600000`; `AUTO_CLOSE_STATUSES` equals
   `['scheduled', 'toured', 'no_show']`.
2. scheduled / toured / no_show with BASE -> `autoCloseDueAtMs === DUE`.
3. requested, canceled, closed -> null.
4. `outcome` present (`'move_forward'`, `'not_a_fit'`, `'no_outcome'`) -> null.
5. `convertible: true` -> null; `convertible: false` -> DUE.
6. `convertedPlacementId: 'placement-1'` -> null; `'pending:abc'` -> null.
7. `lastMarkedAt` before the date (`'2026-09-20T00:00:00.000Z'`) -> DUE;
   after it (`'2026-10-10T09:00:00.000Z'`) -> that + 14 days.
8. created after the date (`createdAt: '2026-10-05T00:00:00.000Z'`) ->
   `2026-10-19T00:00:00.000Z`.
9. undated (no `scheduledAt`, and `scheduledAt: ''`) toured AND no_show ->
   createdAt + 14 days; with `lastMarkedAt` later -> that + 14 days.
10. unparseable `createdAt`, `scheduledAt`, `lastMarkedAt` or `updatedAt` ->
    null; missing `createdAt` -> null.
11. LEGACY FLOOR: no `lastMarkedAt`, `updatedAt: '2026-10-08T00:00:00.000Z'`
    (after the date) -> `2026-10-22T00:00:00.000Z`; no `lastMarkedAt`,
    `updatedAt` before the date -> DUE; `lastMarkedAt:
    '2026-09-20T00:00:00.000Z'` present AND a later `updatedAt:
    '2026-10-08T00:00:00.000Z'` -> DUE (updatedAt is ignored once a mark
    exists).
12. `isAutoCloseDue(BASE, DUE - 1) === false`, `isAutoCloseDue(BASE, DUE) ===
    true` (the boundary is inclusive), `isAutoCloseDue({ ...BASE, status:
    'requested' }, DUE + 1) === false`, and false for every non-candidate of
    case 3-6 at `Number.MAX_SAFE_INTEGER` (the null guard).

GREEN: append to `toursModel.ts` (after the reschedulability block):

```ts
// --- Auto-close (Sam #18, 2026-10-01) ----------------------------------------
// A tour that still has no outcome two weeks after its CLOCK START is closed by
// the sweep (jobs/tourAutoClose.ts) with outcome `no_outcome`. The clock starts
// at the LATEST of: the tour's creation, its scheduled time (when it has one),
// and its MARK - the last time a person marked / rescheduled / reopened it
// (`lastMarkedAt`), or, for a tour nobody has marked since this shipped, its
// last change (`updatedAt`, never earlier than a pre-deploy mark). So a visit
// recorded late, a reopened tour, or one marked just before the deploy still
// gets its full two weeks. Pure: the job, the dev tick and the tests share it.

/** Two weeks, exactly (336 hours). */
export const AUTO_CLOSE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

/** The statuses the sweep may close. Never `requested` (no date to count
 *  from), `canceled` (already an exit) or `closed`. */
export const AUTO_CLOSE_STATUSES = ['scheduled', 'toured', 'no_show'] as const satisfies readonly TourStatus[];

export type AutoCloseStatus = (typeof AUTO_CLOSE_STATUSES)[number];

const AUTO_CLOSE_STATUS_SET: ReadonlySet<string> = new Set(AUTO_CLOSE_STATUSES);

export function isAutoCloseStatus(x: unknown): x is AutoCloseStatus {
  return typeof x === 'string' && AUTO_CLOSE_STATUS_SET.has(x);
}

/** The fields the clock reads. A stored tour item satisfies it. */
export interface AutoCloseClockInput {
  status: unknown;
  outcome?: unknown;
  convertible?: unknown;
  convertedPlacementId?: unknown;
  scheduledAt?: unknown;
  createdAt?: unknown;
  lastMarkedAt?: unknown;
  updatedAt?: unknown;
}

/** Epoch ms of a non-empty ISO string, or null. */
function parseIsoMs(x: unknown): number | null {
  if (typeof x !== 'string' || x.length === 0) return null;
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The epoch-ms instant this tour becomes due for auto-close, or null when it
 * is not a candidate at all (wrong status, already decided, convertible, or a
 * conversion claimed or finished). A present-but-unparseable instant is null:
 * never close on a date we cannot read.
 */
export function autoCloseDueAtMs(tour: AutoCloseClockInput): number | null {
  if (!isAutoCloseStatus(tour.status)) return null;
  if (tour.outcome !== undefined) return null;
  if (tour.convertible === true) return null;
  if (typeof tour.convertedPlacementId === 'string') return null;
  const created = parseIsoMs(tour.createdAt);
  if (created === null) return null;
  let start = created;
  if (tour.scheduledAt !== undefined && tour.scheduledAt !== '') {
    const at = parseIsoMs(tour.scheduledAt);
    if (at === null) return null;
    start = Math.max(start, at);
  }
  // The mark: lastMarkedAt once a person has marked / rescheduled / reopened
  // the tour since this shipped; before that, updatedAt stands in (no
  // migration - spec 5.3). Once lastMarkedAt exists, unrelated writes that
  // bump updatedAt (a roster edit, a group open) no longer move the clock.
  const mark = tour.lastMarkedAt !== undefined ? tour.lastMarkedAt : tour.updatedAt;
  if (mark !== undefined) {
    const markedMs = parseIsoMs(mark);
    if (markedMs === null) return null;
    start = Math.max(start, markedMs);
  }
  return start + AUTO_CLOSE_AFTER_MS;
}

/** True when the sweep should close this tour at `nowMs` (inclusive). */
export function isAutoCloseDue(tour: AutoCloseClockInput, nowMs: number): boolean {
  const due = autoCloseDueAtMs(tour);
  return due !== null && due <= nowMs;
}
```

GREEN + typecheck. Commit.

### Task 1.3 - reopen target

RED: `describe('toursModel - reopenTargetFor')`:

- not closed (each other status) -> `{ ok: false, error: 'tour_not_closed' }`;
- closed + `convertedPlacementId: 'placement-1'` and `'pending:x'` ->
  `tour_converted` (even with `autoClosedFrom` set);
- closed + `autoClosedFrom` scheduled / toured / no_show (+ outcome
  `no_outcome`) -> `{ ok: true, target: <that status> }`;
- closed + outcome `not_a_fit`, and `move_forward` (no autoClosedFrom) ->
  `{ ok: true, target: 'toured' }`;
- closed + no outcome + no autoClosedFrom -> `tour_reopen_unsupported`;
- closed + `autoClosedFrom: 'canceled'` (not a candidate status) + outcome
  `no_outcome` -> `tour_reopen_unsupported`.

GREEN:

```ts
// --- Reopen (Sam #18, 2026-10-01) --------------------------------------------
// A closed tour may be reopened to record a different outcome or reschedule
// it. It returns to the state it closed from: the sweep stores that state in
// `autoClosedFrom`; a person-decided tour (not a fit / move forward) was
// toured. A converted tour (finished or mid-claim) never reopens - the
// placement owns it. A closed tour carrying neither fact (written directly
// through the API) is refused rather than guessed.
export type ReopenRefusal = 'tour_not_closed' | 'tour_converted' | 'tour_reopen_unsupported';

export interface ReopenTargetInput {
  status: unknown;
  outcome?: unknown;
  convertedPlacementId?: unknown;
  autoClosedFrom?: unknown;
}

export type ReopenTargetResult =
  | { ok: true; target: AutoCloseStatus }
  | { ok: false; error: ReopenRefusal };

export function reopenTargetFor(tour: ReopenTargetInput): ReopenTargetResult {
  if (tour.status !== 'closed') return { ok: false, error: 'tour_not_closed' };
  if (typeof tour.convertedPlacementId === 'string') return { ok: false, error: 'tour_converted' };
  if (isAutoCloseStatus(tour.autoClosedFrom)) return { ok: true, target: tour.autoClosedFrom };
  if (tour.outcome === 'not_a_fit' || tour.outcome === 'move_forward') return { ok: true, target: 'toured' };
  return { ok: false, error: 'tour_reopen_unsupported' };
}
```

Also rewrite the STATUS LIFECYCLE header comment (`toursModel.ts:7-34`): add
the lines `scheduled / toured / no_show -> closed (auto-close, outcome
no_outcome, two weeks after the clock start)` and `closed -> scheduled /
toured / no_show (reopen - see reopenTargetFor)`, and change "`closed` is the
terminal" to "`closed` is terminal for PATCH; only POST /reopen leaves it".
Fix the `canReschedule` comment's "A `closed` tour is terminal." the same way.
GREEN + typecheck. Commit.

---

## S2 - repo (`app/src/repos/toursRepo.ts`, harness fake, integration tests)

The in-memory `toursRepo` in `app/test/helpers/twilioWebhookHarness.ts`
(around `:3457-3613`) must implement every new method with the SAME condition
as the real repo, evaluated synchronously inside one tick (no `await`
between the check and the write). A fake that is looser than the store makes
every route test lie (a known trap in this repo).

### Task 2.1 - types and attribute docs

- Replace `export type TourOutcome = 'move_forward' | 'not_a_fit';`
  (`toursRepo.ts:51-52`) with a re-export from the model:
  change the import to `import type { AutoCloseStatus, TourOutcome, TourType }
  from '../lib/toursModel.js';` and the re-export to `export type {
  TourOutcome, TourType };`. Grep `app/` for other importers of
  `TourOutcome` from the repo; they keep compiling.
- In `TourItem`, after `convertible`, declare with comments:

```ts
  /** Auto-close (spec 5.2): wall-clock ISO instant the sweep closed this tour.
   *  Present only while the tour is closed with outcome `no_outcome`; reopen
   *  removes it. */
  autoClosedAt?: string;
  /** Auto-close: the status the sweep closed the tour FROM (`scheduled`,
   *  `toured` or `no_show`) - reopen returns it there. Removed by reopen. */
  autoClosedFrom?: AutoCloseStatus;
  /** The latest instant a PERSON changed this tour's status or time (PATCH),
   *  or reopened it. The auto-close clock never starts before it. Never
   *  removed. */
  lastMarkedAt?: string;
```

Typecheck. Commit (no test: declarations only).

### Task 2.2 - `patch` with an expected-status precondition

RED (`app/test/toursRepo.integration.test.ts`, inside the existing
`describe.skipIf(!reachable)` block, reusing its table setup):

- create a tour with `scheduledAt`; `patch(id, { status: 'toured' }, {
  expectedStatus: 'scheduled' })` succeeds and returns status toured;
- a second `patch(id, { status: 'no_show' }, { expectedStatus: 'scheduled' })`
  throws `ConditionalCheckFailedException` and the stored status is still
  toured;
- `patch(id, { status: 'no_show' })` with no opts still succeeds (unchanged
  contract);
- `patch('tour-missing', {...}, { expectedStatus: 'scheduled' })` throws
  `ConditionalCheckFailedException`.

Run with DynamoDB Local up (`npm run db:start`), confirm RED.

GREEN:

- interface: `patch(tourId: string, updates: PatchTourInput, opts?:
  PatchTourOptions): Promise<TourItem>;` with

```ts
export interface PatchTourOptions {
  /**
   * Write ONLY while the stored status still equals this - the status the
   * caller read and ran its guards on. A mismatch throws
   * ConditionalCheckFailedException, exactly like a missing tour; a caller
   * that must tell the two apart re-reads (PATCH /api/tours/:id does).
   */
  expectedStatus?: string;
}
```

- real repo: build the condition list:

```ts
      const conditions = ['attribute_exists(tourId)'];
      if (opts?.expectedStatus !== undefined) {
        names['#expectedStatus'] = 'status';
        values[':expectedStatus'] = opts.expectedStatus;
        conditions.push('#expectedStatus = :expectedStatus');
      }
```
  and pass `ConditionExpression: conditions.join(' AND ')`.
- fake: `async patch(tourId, updates, opts) {` and throw the existing
  `TourConditionalCheckFailedException` when `!t ||
  (opts?.expectedStatus !== undefined && t.status !== opts.expectedStatus)`.
- Add the same four cases against the FAKE in a new
  `app/test/toursRepoFakeConditions.test.ts` (build the world with
  `createFakeWorld()` from `./helpers/twilioWebhookHarness.js` and use
  `world.toursRepo`). This file collects every fake-parity case of S2.

GREEN (integration with DynamoDB Local up, and the fake file). Typecheck.
Commit.

### Task 2.3 - `autoCloseIf`

RED, integration AND fake-parity (same cases in both files):

1. wins: create `{ status scheduled, scheduledAt: past }`, read it,
   `autoCloseIf(read, 'rot-1')` returns an item with `status 'closed'`,
   `outcome 'no_outcome'`, `autoClosedFrom 'scheduled'`, `autoClosedAt` a
   parseable ISO string, `currentLadderId 'rot-1'`; the stored row matches.
2. undated toured: create without `scheduledAt`, patch `{ status: 'toured' }`,
   read, `autoCloseIf` wins with `autoClosedFrom 'toured'` and still no
   `scheduledAt` on the row.
3. loses (returns `undefined`, stored row unchanged) after, between the read
   and the call: a patch of `status`; a patch of `outcome: 'not_a_fit'`;
   `claimConversion(id, 'pending:x')`; a patch of `convertible: true`; a patch
   of `scheduledAt`; a patch of `lastMarkedAt`; the tour deleted is not
   needed (no delete API) - instead call it with `{ ...read, tourId:
   'tour-missing' }` -> undefined.
4. it never throws for a condition failure.
5. it refuses a non-candidate status UP FRONT (returns undefined and issues
   no write - spy on `doc.send` is not needed: assert the stored row is
   unchanged) for a `canceled`, a `requested` and a `closed` tour handed to
   it as read.

GREEN - interface:

```ts
  /**
   * The auto-close sweep's ONE write (jobs/tourAutoClose.ts, spec 6.3): closes
   * `tour` with outcome `no_outcome` ONLY while every field the due decision
   * read is unchanged - status, no outcome, no conversion claim, not
   * convertible, the same scheduledAt and lastMarkedAt (FIELD equality: two
   * writes in one millisecond carry the same updatedAt, so updatedAt equality
   * cannot detect a change). Rotates the reminder-ladder pointer to `rotation`
   * in the same write. Stamps autoClosedAt / updatedAt with the WALL clock.
   * Returns the post-write item, or undefined when the condition failed (or
   * the tour is missing) - never throws for that.
   */
  autoCloseIf(tour: TourItem, rotation: string): Promise<TourItem | undefined>;
```

real repo:

```ts
    async autoCloseIf(tour, rotation) {
      // Defense in depth (spec 6.3): only a candidate status may ever be
      // closed as no_outcome, whatever the caller's due filter did.
      if (!isAutoCloseStatus(tour.status)) return undefined;
      const now = new Date().toISOString();
      const names: Record<string, string> = {
        '#st': 'status',
        '#oc': 'outcome',
        '#acf': 'autoClosedFrom',
        '#aca': 'autoClosedAt',
        '#cl': 'currentLadderId',
        '#ua': 'updatedAt',
        '#cp': 'convertedPlacementId',
        '#cv': 'convertible',
        '#sa': 'scheduledAt',
        '#lm': 'lastMarkedAt',
      };
      const values: Record<string, unknown> = {
        ':closed': 'closed',
        ':noOutcome': 'no_outcome',
        ':from': tour.status,
        ':now': now,
        ':rot': rotation,
        ':true': true,
      };
      const conditions = [
        'attribute_exists(tourId)',
        '#st = :from',
        'attribute_not_exists(#oc)',
        'attribute_not_exists(#cp)',
        '(attribute_not_exists(#cv) OR #cv <> :true)',
      ];
      if (typeof tour.scheduledAt === 'string') {
        values[':sa'] = tour.scheduledAt;
        conditions.push('#sa = :sa');
      } else {
        conditions.push('attribute_not_exists(#sa)');
      }
      if (typeof tour.lastMarkedAt === 'string') {
        values[':lm'] = tour.lastMarkedAt;
        conditions.push('#lm = :lm');
      } else {
        conditions.push('attribute_not_exists(#lm)');
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId: tour.tourId },
            UpdateExpression:
              'SET #st = :closed, #oc = :noOutcome, #acf = :from, #aca = :now, #cl = :rot, #ua = :now',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ tourId: tour.tourId, from: tour.status }, 'tour auto-closed');
        return Attributes as TourItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId: tour.tourId }, 'tour auto-close lost its condition - skipped');
          return undefined;
        }
        throw err;
      }
    },
```

fake (synchronous check-and-set):

```ts
    async autoCloseIf(tour, rotation) {
      if (!isAutoCloseStatus(tour.status)) return undefined;
      const t = toursMap.get(tour.tourId);
      if (
        !t ||
        t.status !== tour.status ||
        t.outcome !== undefined ||
        t.convertedPlacementId !== undefined ||
        t.convertible === true ||
        t.scheduledAt !== tour.scheduledAt ||
        t.lastMarkedAt !== tour.lastMarkedAt
      ) {
        return undefined;
      }
      const now = new Date().toISOString();
      t.status = 'closed';
      t.outcome = 'no_outcome';
      t.autoClosedFrom = tour.status as TourItem['autoClosedFrom'];
      t.autoClosedAt = now;
      t.currentLadderId = rotation;
      t.updatedAt = now;
      toursMap.set(t.tourId, t);
      return { ...t };
    },
```

(Both files import `isAutoCloseStatus` from `lib/toursModel.js`; the repo
already imports types from there.)

GREEN both files + typecheck. Commit.

### Task 2.4 - `reopenIf`

RED, integration AND fake-parity:

1. a tour closed by `autoCloseIf` from scheduled: `reopenIf(read,
   'scheduled', '2026-10-20T12:00:00.000Z')` returns status `scheduled`,
   `lastMarkedAt` exactly `'2026-10-20T12:00:00.000Z'`, and NO `outcome`,
   `moveForward`, `convertible`, `autoClosedAt`, `autoClosedFrom`;
   `currentLadderId` unchanged.
2. a toured tour patched `{ outcome: 'not_a_fit', moveForward: false,
   convertible: false, status: 'closed' }`: `reopenIf(read, 'toured', ...)`
   wins and removes outcome / moveForward / convertible.
3. loses (undefined, row unchanged) when, after the read: the tour is no
   longer closed (a first `reopenIf` already ran - so a second call with the
   same stale read loses); `claimConversion` ran; the outcome changed.

GREEN - interface:

```ts
  /**
   * Reopen a closed tour (POST /api/tours/:id/reopen, spec 7.3): status ->
   * `target`, lastMarkedAt -> `lastMarkedAt` (the route's clock), and REMOVE
   * outcome / moveForward / convertible / autoClosedAt / autoClosedFrom - ONLY
   * while it is still closed, unconverted, and carries the outcome and
   * autoClosedFrom the caller read (field equality). currentLadderId is left
   * alone (it names no live rows); nothing is armed. Returns the post-write
   * item, or undefined when the condition failed - never throws for that.
   */
  reopenIf(tour: TourItem, target: AutoCloseStatus, lastMarkedAt: string): Promise<TourItem | undefined>;
```

real repo:

```ts
    async reopenIf(tour, target, lastMarkedAt) {
      const names: Record<string, string> = {
        '#st': 'status',
        '#lm': 'lastMarkedAt',
        '#ua': 'updatedAt',
        '#oc': 'outcome',
        '#mf': 'moveForward',
        '#cv': 'convertible',
        '#aca': 'autoClosedAt',
        '#acf': 'autoClosedFrom',
        '#cp': 'convertedPlacementId',
      };
      const values: Record<string, unknown> = {
        ':closed': 'closed',
        ':target': target,
        ':lm': lastMarkedAt,
        ':now': new Date().toISOString(),
      };
      const conditions = ['attribute_exists(tourId)', '#st = :closed', 'attribute_not_exists(#cp)'];
      if (typeof tour.outcome === 'string') {
        values[':oc'] = tour.outcome;
        conditions.push('#oc = :oc');
      } else {
        conditions.push('attribute_not_exists(#oc)');
      }
      if (typeof tour.autoClosedFrom === 'string') {
        values[':acf'] = tour.autoClosedFrom;
        conditions.push('#acf = :acf');
      } else {
        conditions.push('attribute_not_exists(#acf)');
      }
      try {
        const { Attributes } = await doc.send(
          new UpdateCommand({
            TableName: table,
            Key: { tourId: tour.tourId },
            UpdateExpression: 'SET #st = :target, #lm = :lm, #ua = :now REMOVE #oc, #mf, #cv, #aca, #acf',
            ConditionExpression: conditions.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
            ReturnValues: 'ALL_NEW',
          }),
        );
        log.info({ tourId: tour.tourId, to: target }, 'tour reopened');
        return Attributes as TourItem;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          log.debug({ tourId: tour.tourId }, 'tour reopen lost its condition');
          return undefined;
        }
        throw err;
      }
    },
```

fake: check `!t || t.status !== 'closed' || t.convertedPlacementId !==
undefined || t.outcome !== tour.outcome || t.autoClosedFrom !==
tour.autoClosedFrom` -> undefined; else set status / lastMarkedAt /
updatedAt, `delete` the five attributes, return a copy.

GREEN both + typecheck. Commit.

---

## S3 - activity types and the shared writer

### Task 3.1 - the two new activity types

- `app/src/repos/activityEventsRepo.ts` `ActivityEventType`: add
  `| 'tour_auto_closed'` and `| 'tour_reopened'` after `'tour_converted'`.
- `dashboard/src/api/types.ts` `TimelineMilestoneType` (around `:2495`): the
  same two members, same place (it mirrors the server union).
- Doc comments that list the tour activity kinds: `app/src/routes/tours.ts`
  (the activity route comment around `:442-452`), `app/src/routes/units.ts`
  (around `:157-166`), `dashboard/src/api/types.ts` (around `:2897-2902`) -
  add the two kinds.
Typecheck (both workspaces). Commit.

### Task 3.2 - extract `recordTourEvent` into `app/src/lib/tourEvents.ts`

RED: new `app/test/tourEvents.test.ts` against `createFakeWorld()`: seed a
unit with a landlord the way `app/test/toursApi.test.ts` does for
`BASE_CREATE_BODY` (reuse its fixture ids), call `recordTourEvent(deps, {
tenantId, unitId, tourId: 'tour-x' }, 'tour_auto_closed', 'tour_auto_closed',
'Tour closed automatically: no outcome recorded after two weeks')` and assert:
an activity event for the tenant AND the landlord with that type and label,
`refType 'tour'`, `refId 'tour-x'`; audit rows on `units#<unitId>` and
`tours#tour-x` with `event_type 'tour_auto_closed'` and payload `{ tourId:
'tour-x' }`; with `world.failAuditAppendFor.add('tour_auto_closed')` it still
resolves and still writes the activity events.

GREEN: create `app/src/lib/tourEvents.ts`:

```ts
// The ONE writer for a tour lifecycle event (moved out of routes/tours.ts so
// the auto-close sweep and the reopen route record exactly what the PATCH
// route records). Three best-effort surfaces: BOTH parties' contact timelines
// (tenant + the unit's landlord, via lib/personEvents), the property's
// Activity card (a `units#<unitId>` audit row), and the tour's own history (a
// `tours#<tourId>` audit row - GET /api/tours/:tourId/activity). NONE may fail
// the caller: state is already persisted. PII-safe logs: ids and type only.
import type { ActivityEventType } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { Logger } from './logger.js';
import { recordPersonMilestone, type PersonMilestoneDeps } from './personEvents.js';

export interface TourEventDeps extends PersonMilestoneDeps {
  audit: AuditRepo;
}

export interface TourEventSubject {
  tenantId: string;
  unitId: string;
  tourId: string;
}

export async function recordTourEvent(
  deps: TourEventDeps,
  tour: TourEventSubject,
  activityType: ActivityEventType,
  auditType: string,
  label: string,
): Promise<void> {
  const log: Logger = deps.log;
  await recordPersonMilestone(deps, {
    tenantId: tour.tenantId,
    unitId: tour.unitId,
    type: activityType,
    label,
    refType: 'tour',
    refId: tour.tourId,
  });
  try {
    await deps.audit.append(`units#${tour.unitId}`, auditType, { tourId: tour.tourId });
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, `${auditType} unit audit failed (best-effort)`);
  }
  try {
    await deps.audit.append(`tours#${tour.tourId}`, auditType, { tourId: tour.tourId });
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, `${auditType} tour audit failed (best-effort)`);
  }
}
```

(If `PersonMilestoneDeps` is not exported from `lib/personEvents.ts`, export
it - it is the `{ activityEvents, units, log }` shape `recordTourEvent` passed
before. Match its real field names and optionality.)

In `app/src/routes/tours.ts`, replace the closure body (`:260-287`) with a
delegation that keeps the local name, so no call site changes:

```ts
  // Tour lifecycle events go through the ONE shared writer (lib/tourEvents.ts)
  // so the auto-close sweep and reopen record exactly what this route does.
  const recordTourEvent = (
    tour: { tenantId: string; unitId: string; tourId: string },
    activityType: ActivityEventType,
    auditType: string,
    label: string,
  ): Promise<void> =>
    recordTourEventShared({ activityEvents, units, audit, log }, tour, activityType, auditType, label);
```

with `import { recordTourEvent as recordTourEventShared } from
'../lib/tourEvents.js';` (drop the now-unused `recordPersonMilestone` import
if nothing else in the file uses it).

GREEN: the new test, then the WHOLE `app/test/toursApi.test.ts` unchanged
(this is a pure refactor - not one existing assertion may change). Typecheck.
Commit.

---

## S4 - PATCH changes (`app/src/routes/tours.ts`)

### Task 4.1 - staff outcomes only

RED (`app/test/toursApi.test.ts`, near the exit-gate tests): a toured tour,
PATCH `{ outcome: 'no_outcome', moveForward: false }` -> 400 with
`error` containing `'move_forward, not_a_fit'`; the stored tour has no
outcome.

GREEN: in the PATCH validation (`:1047-1049`) use `isStaffTourOutcome` and
`STAFF_TOUR_OUTCOMES.join(', ')` in the message; update the imports (drop
`isTourOutcome` / `TOUR_OUTCOMES` if no longer used in the file - an unused
import fails lint). Run the file GREEN. Commit.

### Task 4.2 - consistent read, status precondition, 409 `tour_changed`

RED (`app/test/toursApi.test.ts`):

1. "PATCH that read a pre-close status cannot land on an auto-closed tour":
   create a tour with a past `scheduledAt`. Wrap `world.toursRepo.patch` so
   that on its FIRST call it first runs
   `await world.toursRepo.autoCloseIf(<the tour as read before>, 'rot-race')`
   (the sweep landing between the route's read and write) and then calls the
   real patch with all three arguments. PATCH `{ status: 'toured' }` ->
   409, `body.error === 'tour_changed'`; the stored tour is still `closed`
   with `outcome 'no_outcome'`, `autoClosedFrom 'scheduled'`; no
   `tour_took_place` activity event was written for it.
2. "a PATCH racing a delete-like miss answers 404": wrap so the first call
   deletes the tour from `world.toursMap` and then calls the real patch ->
   404 `tour_not_found`.
3. The precondition rides every PATCH: spy on `world.toursRepo.patch` and
   assert the route's call passes `{ expectedStatus: <status read> }` as the
   third argument (for a reschedule, a status change, and an exit-gate patch).

GREEN in the PATCH handler:

- `const current = await tours.get(tourId, { consistentRead: true });`
- the main write:

```ts
    let tour: TourItem;
    try {
      // The precondition is the status the guards above ran on: a concurrent
      // change (another PATCH, a conversion, the auto-close sweep) between
      // that read and this write is refused instead of merged on top
      // (tour auto-close spec section 8).
      tour = await tours.patch(tourId, patch, { expectedStatus: currentStatus });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Two conditions share this exception: the tour is gone, or its status
        // moved after our read. A consistent re-read tells them apart; neither
        // runs a single side effect below.
        const fresh = await tours.get(tourId, { consistentRead: true });
        if (fresh === undefined) {
          res.status(404).json({ error: 'tour_not_found' });
          return;
        }
        res.status(409).json({
          error: 'tour_changed',
          detail: 'This tour changed while you were saving - reload and try again.',
        });
        return;
      }
      throw err;
    }
```

- EXISTING TESTS THAT WRAP `world.toursRepo.patch` (grep `toursRepo.patch =`
  across `app/test`): change each wrapper signature to `async (id, updates,
  opts) =>` and forward `opts` to the real patch. Do not change what they
  assert. If any existing test now fails, STOP and report it in the ledger
  (it encodes last-writer-wins behavior the spec removes) rather than
  weakening it.
- Dashboard: no change for the 409. `ApiError.message` is `<error> (<detail>)`
  (`dashboard/src/api/client.ts:75-83`), which the tour page's header alert
  and the dialogs already show for every other 409 (for example
  `illegal_status_transition (...)`); `tour_changed (This tour changed while
  you were saving - reload and try again.)` reads the same way. Do not
  reshape `ApiError`.

GREEN: the whole `toursApi.test.ts`, `tourRemindersApi.test.ts` and every
other app test file that PATCHes tours (`grep -l "api/tours" app/test`).
Typecheck. Commit.

### Task 4.3 - stamp `lastMarkedAt`

RED (`toursApi.test.ts`, harness with an injected `toursNow`):

- PATCH `{ status: 'toured' }` -> stored `lastMarkedAt` equals the injected
  now;
- PATCH `{ scheduledAt }` (reschedule) -> stamped;
- booking a requested tour (`{ scheduledAt }` only) -> stamped;
- PATCH `{ outcome: 'move_forward', moveForward: true }` on a toured tour (no
  status) -> `lastMarkedAt` unchanged from before that PATCH.

GREEN: after the patch is fully built and BEFORE `effectiveStatus` is
derived:

```ts
    // The auto-close clock's floor (spec 5.3): a person marking, rescheduling
    // or reviving this tour gives it a fresh two weeks.
    if (patch['status'] !== undefined || patch['scheduledAt'] !== undefined) {
      patch['lastMarkedAt'] = getNow();
    }
```

GREEN (the whole file). Typecheck. Commit.

---

## S5 - the sweep

### Task 5.1 - the close-nag clear helper (`app/src/services/relayCloseNag.ts`)

RED (the existing relayCloseNag test file - grep `armRelayCloseNagIfOpen`
under `app/test`; add a new file `app/test/relayCloseNagClear.test.ts` if
none fits) with a fake `conversationsRepo` (`getById`, `setCloseNagNextAt`
spies):

- open `relay_group` with `close_nag_next_at` and `owner { type: 'tour', id:
  'tour-1' }` -> `setCloseNagNextAt('conv-1', null)` called once;
- owner absent -> cleared; owner `{ type: null }` -> cleared;
- owner `{ type: 'placement', id: 'p-1' }` -> not called; owner tour
  `'tour-2'` -> not called;
- status `closed`, type not `relay_group`, no nag, missing conversation,
  missing/empty groupThreadId -> not called;
- `getById` rejects -> resolves (never throws), logs at error.

GREEN:

```ts
/**
 * Clear a pending close-nag on a tour's OWN open relay group when the tour is
 * REOPENED (tour auto-close spec 7.4): the tour is live again, so a "close
 * this group?" prompt on Today would be wrong mid-coordination - and a
 * reopened not-a-fit that moves forward carries its group into the placement.
 * The next terminal tour event arms the nag again (set-if-absent). Skips a
 * group another owner holds. Best-effort: NEVER throws.
 */
export async function clearRelayCloseNagOnReopen(
  deps: ArmRelayCloseNagDeps,
  groupThreadId: string | undefined,
  tourId: string,
): Promise<void> {
  const log = deps.logger ?? defaultLogger;
  if (typeof groupThreadId !== 'string' || groupThreadId.length === 0) return;
  try {
    const conversation = await deps.conversationsRepo.getById(groupThreadId);
    if (
      !conversation ||
      conversation.type !== 'relay_group' ||
      conversation.status !== 'open' ||
      conversation.close_nag_next_at === undefined
    ) {
      return;
    }
    const owner = conversation.owner;
    if (owner !== undefined && owner.type !== null && !(owner.type === 'tour' && owner.id === tourId)) return;
    await deps.conversationsRepo.setCloseNagNextAt(groupThreadId, null);
    log.info({ conversationId: groupThreadId }, 'relay close-nag cleared on tour reopen');
  } catch (err) {
    log.error({ err, conversationId: groupThreadId }, 'relay close-nag clear failed (best-effort)');
  }
}
```

(Check the conversation item's `owner` field name/type in
`conversationsRepo.ts` around `:223`; adapt the property access, not the
rule.) GREEN + typecheck. Commit.

### Task 5.2 - `app/src/jobs/tourAutoClose.ts`

RED: new `app/test/tourAutoClose.test.ts` against `createFakeWorld()` with a
fresh `createEventBus()` (from `../src/lib/events.js`) whose `tour.updated`
and `scheduled.updated` emits the test records. Seed the tenant contact and a
unit with a landlord as `toursApi.test.ts` does. Create tours through
`world.toursRepo.create({ ..., createdAt })` (the fake honors a supplied
`createdAt`). CLOCK TRAP: the fake stamps `updatedAt` with the WALL clock on
every write, and with no `lastMarkedAt` the clock's mark IS `updatedAt`
(spec 5.3) - a tour just created through the fake is not due for 14 REAL
days whatever its dates say. So after every setup write, set
`world.toursMap.get(id)!.updatedAt = <the case's intended last change>`
(normally its `createdAt`), or give it an explicit `lastMarkedAt`, and build
each case's injected `now` from those values. Cases:

1. a scheduled tour created `2026-08-25T00:00:00.000Z`, dated
   `2026-09-01T15:00:00.000Z`; `runTourAutoClose('2026-09-20T00:00:00.000Z',
   deps)` -> summary `{ scanned: 1, due: 1, closed: 1, lost: 0, failed: 0 }`;
   the stored tour is closed / `no_outcome` / `autoClosedFrom 'scheduled'`;
   `tour_auto_closed` activity events for tenant and landlord with the exact
   person-timeline label; `units#` and `tours#` audit rows of that type; one
   `tour.updated { tourId, status: 'closed' }` and one `scheduled.updated {
   contactId: tenantId }`.
2. not due one millisecond before the boundary; due exactly at it.
3. skipped (closed 0, due 0): requested; canceled; closed; toured with
   `outcome: 'move_forward', moveForward: true, convertible: true`; toured
   with `convertedPlacementId: 'pending:x'`; a tour whose `lastMarkedAt` is
   within the window; a LEGACY tour (no `lastMarkedAt`) whose `updatedAt` is
   within the window (marked just before the deploy).
4. each candidate status closes: toured (undated: created 20 days before
   now), no_show.
5. lost write: replace `world.toursRepo.autoCloseIf` with one that returns
   `undefined` -> `{ due: 1, closed: 0, lost: 1 }`, no activity, no audit,
   no events, no nag.
6. failed write: one that throws -> `failed: 1`, the run continues to the
   next due tour (two due tours, the second closes).
7. nag: a tour with `groupThreadId` -> an open relay group without a nag gets
   `close_nag_next_at`; one that already has a nag keeps its value.
8. reminders: a never-sent reminder row of the tour's ladder is gone after
   the close (seed it the way `app/test/tourReminders.test.ts` seeds rows);
   a SENT row survives.
9. a side effect failing (`world.failAuditAppendFor.add('tour_auto_closed')`)
   does not stop a second due tour from closing.
10. nothing is sent: the world's outbound record (whatever
    `toursApi.test.ts` asserts sends against) is unchanged after a run that
    closes tours.
11. `tourIds` scope: two due tours, `{ tourIds: [a] }` -> only `a` closes,
    `scanned 1`; an unknown id is ignored (`scanned` counts tours found).

GREEN: create the module.

```ts
// Tour auto-close (Sam #18, 2026-10-01; spec
// docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md).
//
// A tour that still has no outcome two weeks after its clock start (see
// lib/toursModel.ts autoCloseDueAtMs) closes ON ITS OWN with outcome
// `no_outcome`. SILENT by construction: these deps hold no messaging adapter
// and no send service, so nothing here can text anyone. It never marks a
// no-show, never touches tenant status or placements.
//
// One conditional write per tour (toursRepo.autoCloseIf): a staff change that
// lands between our read and our write wins, and we skip the tour this run.
// Only the WINNER of that write runs the side effects - reminder sweep,
// activity, relay close-nag, events - each best-effort.
//
// The injected `now` decides only WHICH tours are due; every stamp is wall
// clock (repo convention). Runs on the worker's own 15-minute poll and on the
// hermetic dev tick (POST /__dev/tour-auto-close/tick).
import { randomUUID } from 'node:crypto';
import { AUTO_CLOSE_STATUSES, isAutoCloseDue } from '../lib/toursModel.js';
import type { EventBus } from '../lib/events.js';
import { logger as defaultLogger, type Logger } from '../lib/logger.js';
import { recordTourEvent } from '../lib/tourEvents.js';
import type { ActivityEventsRepo } from '../repos/activityEventsRepo.js';
import type { AuditRepo } from '../repos/auditRepo.js';
import type { ConversationsRepo } from '../repos/conversationsRepo.js';
import type { TourRemindersRepo } from '../repos/tourRemindersRepo.js';
import type { TourItem, ToursRepo } from '../repos/toursRepo.js';
import type { UnitsRepo } from '../repos/unitsRepo.js';
import { armRelayCloseNagIfOpen } from '../services/relayCloseNag.js';

/** The worker poll's own cadence - a two-week rule needs no 30 s tick. */
export const TOUR_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000;

/** Person-timeline label (server-owned, rendered verbatim). */
export const TOUR_AUTO_CLOSED_LABEL = 'Tour closed automatically: no outcome recorded after two weeks';

export interface TourAutoCloseDeps {
  toursRepo: ToursRepo;
  tourRemindersRepo: TourRemindersRepo;
  conversationsRepo: ConversationsRepo;
  unitsRepo: UnitsRepo;
  auditRepo: AuditRepo;
  activityEventsRepo?: ActivityEventsRepo;
  events: EventBus;
  logger?: Logger;
}

export interface TourAutoCloseOptions {
  /** Dev tick only: consider ONLY these tours (each read consistently). */
  tourIds?: readonly string[];
}

export interface TourAutoCloseSummary {
  scanned: number;
  due: number;
  closed: number;
  lost: number;
  failed: number;
}

async function loadCandidates(deps: TourAutoCloseDeps, opts: TourAutoCloseOptions): Promise<TourItem[]> {
  if (opts.tourIds !== undefined) {
    const found = await Promise.all(opts.tourIds.map((id) => deps.toursRepo.get(id, { consistentRead: true })));
    return found.filter((t): t is TourItem => t !== undefined);
  }
  const pages = await Promise.all(AUTO_CLOSE_STATUSES.map((status) => deps.toursRepo.listByStatus(status)));
  return pages.flat();
}

export async function runTourAutoClose(
  nowIso: string,
  deps: TourAutoCloseDeps,
  opts: TourAutoCloseOptions = {},
): Promise<TourAutoCloseSummary> {
  const log = deps.logger ?? defaultLogger;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error('runTourAutoClose: now must be an ISO 8601 instant');
  const candidates = await loadCandidates(deps, opts);
  const summary: TourAutoCloseSummary = { scanned: candidates.length, due: 0, closed: 0, lost: 0, failed: 0 };

  for (const tour of candidates) {
    if (!isAutoCloseDue(tour, nowMs)) continue;
    summary.due += 1;
    const rotation = randomUUID();
    let closed: TourItem | undefined;
    try {
      closed = await deps.toursRepo.autoCloseIf(tour, rotation);
    } catch (err) {
      summary.failed += 1;
      log.error({ err, tourId: tour.tourId }, 'tour auto-close write failed');
      continue;
    }
    if (closed === undefined) {
      summary.lost += 1;
      continue;
    }
    summary.closed += 1;
    log.info({ tourId: tour.tourId, from: tour.status }, 'tour closed automatically (no outcome after two weeks)');
    await afterClose(closed, rotation, deps, log);
  }

  if (summary.closed > 0 || summary.failed > 0) log.info({ ...summary }, 'tour auto-close run');
  return summary;
}

/** The winner's side effects - each best-effort, none may stop the run. */
async function afterClose(tour: TourItem, rotation: string, deps: TourAutoCloseDeps, log: Logger): Promise<void> {
  try {
    await deps.tourRemindersRepo.deleteSupersededForTour(tour.tourId, rotation);
  } catch (err) {
    log.error({ err, tourId: tour.tourId }, 'tour auto-close: reminder sweep failed (rows stay refused by the rotated pointer)');
  }
  await recordTourEvent(
    { activityEvents: deps.activityEventsRepo, units: deps.unitsRepo, audit: deps.auditRepo, log },
    { tenantId: tour.tenantId, unitId: tour.unitId, tourId: tour.tourId },
    'tour_auto_closed',
    'tour_auto_closed',
    TOUR_AUTO_CLOSED_LABEL,
  );
  await armRelayCloseNagIfOpen({ conversationsRepo: deps.conversationsRepo, logger: log }, tour.groupThreadId, 'tour');
  deps.events.emit('tour.updated', { tourId: tour.tourId, status: 'closed' });
  deps.events.emit('scheduled.updated', { contactId: tour.tenantId });
}
```

(Match `recordTourEvent`'s deps to Task 3.2's `TourEventDeps`; match
`deleteSupersededForTour`'s real signature in `tourRemindersRepo.ts` - the
PATCH terminal branch calls it as `(tourId, rotation)`.)

GREEN + typecheck + lint the new file
(`cd "W:/tmp/tour-auto-close"; npx eslint app/src/jobs/tourAutoClose.ts
app/test/tourAutoClose.test.ts`). Commit.

### Task 5.3 - worker wiring (`app/src/worker.ts`)

After the tour-reminder poll block, add a block that builds the deps with the
same lazy-import style and starts the poll on its OWN interval. The local
`startPoll` wrapper binds the shared interval, so call the imported pollLoop
`startPoll` directly (it is imported under another name in `worker.ts` - use
that name) with `{ logger, intervalMs: TOUR_AUTO_CLOSE_INTERVAL_MS,
baseContext: bootContext }`. Use the SAME `events` bus value the roster-action
poll's deps use in `worker.ts` (it is bridged to the app's SSE). The poll name
is `'tour auto-close'`. Add a header comment: the poll's purpose, the 15-minute
cadence and why it is not the shared one, and that it is silent by
construction. If a test pins the worker's poll list or count (grep
`app/test` for `'tour reminder'` together with `worker`), extend it.
Typecheck. Commit.

### Task 5.4 - dev tick (`app/src/routes/dev.ts`)

RED: new `app/test/devTourAutoCloseTick.test.ts` patterned on
`app/test/devJournalSweepTick.test.ts` (build the app with `createDevRouter`
and injected `tourAutoCloseDeps` from a fake world):

- `{ now: 'nope' }` -> 400 `now must be a valid ISO 8601 datetime`;
- `tourIds` not an array, empty, 51 entries, containing `''` or a number ->
  400 `tourIds must be a non-empty array of at most 50 tour ids`;
- `{ now: '2026-09-20T00:00:00Z' }` -> 200 `{ ok: true, now:
  '2026-09-20T00:00:00.000Z', scanned, due, closed, lost, failed }` and the
  due tour is closed (same CLOCK TRAP as Task 5.2: set the seeded tour's
  `updatedAt` / `createdAt` in `world.toursMap` so it is due at that `now`);
- `{ now, tourIds: [a] }` with two due tours -> only `a` closed.

GREEN:

- `DevRouterDeps` gains `tourAutoCloseDeps?: TourAutoCloseDeps;` (doc: "Deps
  for POST /__dev/tour-auto-close/tick - injected in tests; defaults to the
  worker's construction (worker.ts).").
- Lazily built deps mirroring the worker's (the dev router runs in the APP
  process: use the app's event bus the same way the roster-actions tick's
  deps do).
- The route, beside the tour-reminders tick:

```ts
  // POST /__dev/tour-auto-close/tick { now?, tourIds? } - the deterministic
  // e2e seam for the worker's 15-minute auto-close poll (Sam #18). `now` is
  // normalized like the tour-reminders tick. `tourIds` (dev-only) scopes the
  // sweep to those tours so a spec can never close another spec's tours; the
  // real poll never passes it. Same job, same rule, same writes otherwise.
  router.post('/__dev/tour-auto-close/tick', json(), async (req, res) => {
    const body = (req.body ?? {}) as { now?: unknown; tourIds?: unknown };
    let nowIso = new Date().toISOString();
    if (body.now !== undefined) {
      if (typeof body.now !== 'string' || !Number.isFinite(Date.parse(body.now))) {
        res.status(400).json({ error: 'now must be a valid ISO 8601 datetime' });
        return;
      }
      nowIso = new Date(body.now).toISOString();
    }
    let tourIds: string[] | undefined;
    if (body.tourIds !== undefined) {
      const ids = body.tourIds;
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 50 ||
        !ids.every((id): id is string => typeof id === 'string' && id.length > 0)
      ) {
        res.status(400).json({ error: 'tourIds must be a non-empty array of at most 50 tour ids' });
        return;
      }
      tourIds = ids;
    }
    const summary = await runTourAutoClose(nowIso, tourAutoCloseDeps(), tourIds !== undefined ? { tourIds } : {});
    log.info({ now: nowIso, ...summary }, 'dev tour auto-close tick ran');
    res.status(200).json({ ok: true, now: nowIso, ...summary });
  });
```

- `e2e/support/selectors.md` lists the tick seams (around `:101-108`): add
  this one. `e2e/README.md`'s dev-only surface list names the `*/tick`
  seams: add `tour-auto-close`.
GREEN + typecheck. Commit.

---

## S6 - reopen route (`app/src/routes/tours.ts`)

### Task 6.1 - `POST /api/tours/:tourId/reopen`

RED: new `app/test/toursReopenApi.test.ts` using `makeWebhookHarness({
toursNow: () => NOW })` and the `authed()` helper pattern from
`toursApi.test.ts`. To get an auto-closed tour, create one through the API
and close it with `world.toursRepo.autoCloseIf(await world.toursRepo.get(id),
'rot-1')` (or by running `runTourAutoClose` with world deps). Cases:

1. 404 `tour_not_found` for an unknown id.
2. 409 `tour_not_closed` for a scheduled tour.
3. 409 `tour_converted` for a converted tour (PATCH toured, PATCH `{ outcome:
   'move_forward', moveForward: true }`, POST `/api/placements/from-tour`) and
   for a closed tour whose `convertedPlacementId` is `'pending:x'` (set
   through the world map).
4. 409 `tour_reopen_unsupported` for PATCH `{ status: 'closed' }` straight
   from scheduled (closed, no outcome, no autoClosedFrom).
5. 400 for any body field (`{ status: 'toured' }`).
6. auto-closed from scheduled -> 200, `tour.status 'scheduled'`, no outcome /
   autoClosedAt / autoClosedFrom / moveForward / convertible,
   `lastMarkedAt === NOW`; the reminder rows for the tour are exactly the
   ones before the call (none armed); nothing sent (the world's outbound
   record unchanged).
7. auto-closed from toured -> toured; from no_show -> no_show.
8. closed as not a fit (PATCH toured, then `{ outcome: 'not_a_fit',
   moveForward: false, status: 'closed' }`) -> toured, outcome / moveForward /
   convertible gone; then PATCH `{ outcome: 'move_forward', moveForward: true
   }` -> 200 convertible (the normal flow works after a reopen).
9. activity: a `tour_reopened` person milestone with label `'Tour reopened'`
   for tenant and landlord, and `units#` / `tours#` audit rows of that type.
10. close-nag: an open relay group owned by the tour with a nag -> nag
    cleared; a group owned by a placement -> untouched.
11. `tour.updated { tourId, status: <target> }` emitted (use the harness's
    event bus the way existing tour tests assert `tour.updated`).
12. two concurrent reopens of the same tour -> exactly one 200 and one 409
    `tour_changed`.
13. after a reopen, `GET /api/tours/:id` shows the reopened state and a
    second reopen is 409 `tour_not_closed`.

GREEN: add the route after the PATCH handler:

```ts
  // POST /api/tours/:tourId/reopen - reopen a CLOSED tour (Sam #18,
  // 2026-10-01; spec section 7): back to the state it closed from
  // (reopenTargetFor), outcome cleared, a fresh two weeks on the auto-close
  // clock (lastMarkedAt). SILENT: arms no reminder (not even into a past
  // 'scheduled'), sends nothing, touches no placement or roster. A converted
  // tour never reopens - the placement owns it. The ONLY way out of 'closed';
  // PATCH still refuses every change to a closed tour.
  router.post('/:tourId/reopen', async (req, res) => {
    const tourId = String(req.params['tourId'] ?? '');
    const body: unknown = req.body ?? {};
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'body must be a JSON object' });
      return;
    }
    const fields = Object.keys(body);
    if (fields.length > 0) {
      res.status(400).json({ error: `unknown field(s): ${fields.join(', ')}` });
      return;
    }
    const current = await tours.get(tourId, { consistentRead: true });
    if (!current) {
      res.status(404).json({ error: 'tour_not_found' });
      return;
    }
    const decision = reopenTargetFor(current);
    if (!decision.ok) {
      res.status(409).json({ error: decision.error });
      return;
    }
    const reopened = await tours.reopenIf(current, decision.target, getNow());
    if (reopened === undefined) {
      res.status(409).json({ error: 'tour_changed' });
      return;
    }
    await recordTourEvent(
      { tenantId: current.tenantId, unitId: current.unitId, tourId },
      'tour_reopened',
      'tour_reopened',
      'Tour reopened',
    );
    await clearRelayCloseNagOnReopen({ conversationsRepo: conversations, logger: log }, current.groupThreadId, tourId);
    events.emit('tour.updated', { tourId, status: reopened.status });
    log.info({ tourId, to: reopened.status }, 'tour reopened via api');
    res.json({ tour: reopened });
  });
```

Update the router header comment's route list (`tours.ts:5-11`) and the
"closed is terminal" wording in the PATCH guard comment (`:1065-1072`):
"terminal for PATCH; POST /:tourId/reopen is the only way out".
GREEN (the new file and all of `toursApi.test.ts`) + typecheck. Commit.

---

## S7 - listing-send chip (`app/src/lib/listingSendTour.ts`)

### Task 7.1

RED (`app/test/listingSendTour.test.ts`): a closed tour with `autoClosedFrom:
'toured'` (outcome `no_outcome`) -> signal state `toured`; with
`autoClosedFrom` `scheduled` / `no_show` -> undefined; precedence: an
auto-closed-from-toured tour beats a scheduled one for the same pairing.

GREEN: in `qualifyingState`, after the converted line:

```ts
  // Auto-closed from toured (Sam #18): the visit happened - only the decision
  // is missing - so "Toured" is the honest floor, as for a converted tour.
  if (status === 'closed' && tour['autoClosedFrom'] === 'toured') return 'toured';
```

and add the case to the module header's PRECEDENCE list. GREEN. Commit.

---

## S8 - dashboard

Run dashboard tests with `cd "W:/tmp/tour-auto-close/dashboard"; npx vitest
run <files>`. Dashboard tests pin `Date` globally (`test/setup.ts`): call
`vi.useRealTimers()` BEFORE `vi.useFakeTimers()` where a test needs its own
clock.

### Task 8.1 - api types, client, catalog

- `dashboard/src/api/types.ts` (around `:899-906`): `TourOutcome` gains
  `'no_outcome'`; `TOUR_OUTCOME_LABELS.no_outcome = 'No outcome recorded'`;
  add `export type StaffTourOutcome = Exclude<TourOutcome, 'no_outcome'>;`
  with a comment (people record only these; `no_outcome` is the auto-close
  sweep's). `Tour` gains optional `autoClosedAt?: string;`, `autoClosedFrom?:
  'scheduled' | 'toured' | 'no_show';`, `lastMarkedAt?: string;` (documented).
- `dashboard/src/api/endpoints.ts`: `patchTour`'s `outcome?: StaffTourOutcome`;
  fix its doc ("record the exit-gate decision; only not-a-fit with `status:
  'closed'` closes the tour"); add

```ts
/** POST /api/tours/:tourId/reopen - reopen a closed tour (Sam #18): it goes
 *  back to the state it closed from, its outcome cleared; nothing is sent.
 *  Returns the updated tour (unwrapped from { tour }). 409s: tour_not_closed,
 *  tour_converted, tour_reopen_unsupported, tour_changed. */
export async function reopenTour(tourId: string): Promise<Tour> {
  const res = await request<{ tour: Tour }>(`/api/tours/${encodeURIComponent(tourId)}/reopen`, {
    method: 'POST',
    body: {},
  });
  return res.tour;
}
```

  (match the real `request` helper's option names - mirror `createTourRelay`
  or `cancelPendingRosterAction` in the same file). Export it through
  `dashboard/src/api/index.ts` if that file lists exports explicitly.
- `RecordOutcomeModal`'s decision type and `TourDetail`'s `confirmOutcome`
  parameter use `StaffTourOutcome`.
- `e2e/performance/mutationCatalog.ts`: add
  `entry(ENDPOINTS, 'reopenTour', 'request:POST', '/api/tours/:tourId/reopen'),`
  beside `createTour`. Run the e2e workspace's catalog test (find its
  command in `e2e/package.json`; e.g. `npm run test -w @housingchoice/e2e --
  performance/mutationCatalog.test.ts`) GREEN.
Typecheck. Commit.

### Task 8.2 - pure module `dashboard/src/routes/tours/tourReopen.ts`

RED `tourReopen.test.ts`: the same table as Task 1.3 against
`reopenTargetOf(tour)` (null where the server refuses), and
`REOPEN_BODY[target]` equals the three spec strings.

GREEN:

```ts
// tourReopen - which state a closed tour reopens INTO, mirrored from the
// server's reopenTargetFor (app/src/lib/toursModel.ts, spec 7.2) so the tour
// page offers Reopen exactly when POST /reopen would accept it. App and
// dashboard share no code; keep the two in step.
import type { Tour } from '../../api/index.js';

export type ReopenTarget = 'scheduled' | 'toured' | 'no_show';

const REOPEN_TARGETS: ReadonlySet<string> = new Set(['scheduled', 'toured', 'no_show']);

/** The state a reopen returns this tour to, or null when it cannot reopen. */
export function reopenTargetOf(tour: Tour): ReopenTarget | null {
  if (tour.status !== 'closed') return null;
  if (typeof tour.convertedPlacementId === 'string') return null;
  if (typeof tour.autoClosedFrom === 'string' && REOPEN_TARGETS.has(tour.autoClosedFrom)) {
    return tour.autoClosedFrom;
  }
  if (tour.outcome === 'not_a_fit' || tour.outcome === 'move_forward') return 'toured';
  return null;
}

/** The confirm dialog's body, by target (spec 9.2). */
export const REOPEN_BODY: Readonly<Record<ReopenTarget, string>> = {
  toured: 'This tour goes back to Toured so you can record a different outcome. Nothing is sent.',
  no_show: 'This tour goes back to No show so you can reschedule it. Nothing is sent.',
  scheduled:
    'This tour goes back to Not marked so you can mark it toured or a no-show, or reschedule it. Nothing is sent.',
};
```

GREEN. Commit.

### Task 8.3 - kebab item (`TourActionsMenu.tsx`)

(The kebab carries Reopen ONLY on a convertible, unconverted closed tour,
where "Start placement" holds the primary slot - Task 8.5 computes that.)

RED (`TourActionsMenu.test.tsx`): with `canReopen` true the menu shows a
"Reopen tour" item that calls `onReopen`; a kebab with ONLY `canReopen` true
renders (not the empty-kebab null); default (prop omitted) shows no item.
GREEN: optional props `canReopen?: boolean` (default false) and `onReopen?:
() => void`, documented "Reopen (closed, not converted, reopenable - spec
9.2)"; the item is last; include it in the "nothing qualifies" check. Update
the file header's action list. Commit.

### Task 8.4 - `ReopenTourModal` (`TourModals.tsx`)

RED (`TourDetail.test.tsx` or a new `TourModals.test.tsx` if one exists for
other modals): renders a dialog named "Reopen tour" with the body for its
`target`; its confirm button is "Yes, reopen" (NOT "Reopen tour" - the page
behind the shared Modal is not inert and Playwright names match by
substring); "Yes, reopen" awaits `onConfirm` then calls `onClose`; a
rejected `onConfirm` with an `ApiError` of status 409 shows the 409 copy,
any other error the generic copy, and the dialog stays open; "Cancel" calls
`onClose` only.
GREEN: mirror `CancelTourModal`'s structure exactly (same Modal, buttons,
busy handling), props `{ target: ReopenTarget; onClose: () => void;
onConfirm: () => Promise<void> }`. Commit.

### Task 8.4b - Record outcome dialog: a 409 says reload, not retry

RED (where `RecordOutcomeModal` is tested): `onConfirm` rejecting with an
`ApiError` of status 409 shows "This tour changed since the page loaded -
reload and try again."; any other rejection keeps "Couldn't record the
outcome - please try again.".
GREEN: in `RecordOutcomeModal`'s catch (`TourModals.tsx` around `:298-305`),
branch on `err instanceof ApiError && err.status === 409`. Share the string
with the Reopen dialog (one exported constant in `TourModals.tsx`). Other
tour dialogs are unchanged. Commit.

### Task 8.5 - tour page wiring (`TourDetail.tsx`)

RED (`TourDetail.test.tsx`, with the client mocked the way the file already
mocks `patchTour`):

- primary CTA "Reopen tour" for: closed + `autoClosedFrom: 'scheduled'` +
  `outcome: 'no_outcome'`; closed + `not_a_fit` - and the kebab has NO
  "Reopen tour" item (exactly one "Reopen tour" control on the page: assert
  `getAllByRole('button', { name: 'Reopen tour' })` length 1 with the kebab
  open);
- closed + `move_forward` + `convertible: true` (unconverted): primary "Start
  placement", and the kebab has "Reopen tour" (again exactly one);
- converted (`convertedPlacementId: 'placement-1'`): "View placement", no
  "Reopen tour" in the CTA or the kebab; `'pending:x'` likewise no Reopen;
- closed, no outcome, no autoClosedFrom: no Reopen anywhere;
- confirm from a toured target: `reopenTour` called once, then the "Record
  outcome" dialog is visible AND stays visible (the guarded close);
- confirm from a no_show target: dialog closes, the badge reads "No show";
- Outcome card for `no_outcome` with `autoClosedAt`: shows "No outcome
  recorded" and "Closed automatically on <short date>", and no "Moving
  forward" row.

GREEN:

- imports: `reopenTour`, `ReopenTourModal`, `reopenTargetOf`,
  `type ReopenTarget`.
- the modal union gains `'reopen'`; add state `const [reopenFor,
  setReopenFor] = useState<ReopenTarget | null>(null);` - the dialog renders
  from this snapshot, so it neither changes copy nor unmounts mid-confirm
  when the tour updates underneath it.
- `const reopenTarget = reopenTargetOf(tour);` and
  `const openReopen = (): void => { if (reopenTarget === null) return;
  setReopenFor(reopenTarget); setModal('reopen'); };`
- primary CTA ladder: after the `toured && outcome === undefined` branch add
  `else if (reopenTarget !== null) { primaryCta = (<Button size="sm"
  onClick={openReopen}>Reopen tour</Button>); }` (the converted and
  convertible branches stay first).
- kebab: `canReopen={reopenTarget !== null && tour.convertible === true}`
  (only when "Start placement" holds the primary slot - one placement per
  state, spec 9.2) and `onReopen={openReopen}`.
- confirm handler:

```ts
  // Reopen (spec 9.2): back to the state the tour closed from. Into toured,
  // recording the different outcome is what the operator came to do, so the
  // modal slot passes straight to Record outcome - the dialog's close below is
  // GUARDED for exactly that reason (same as "already toured").
  const confirmReopen = async (): Promise<void> => {
    setActionError(null);
    const reopened = await reopenTour(tourId);
    setTour(reopened);
    if (reopened.status === 'toured') setModal('outcome');
  };
```

- render beside the other modals:

```tsx
      {modal === 'reopen' && reopenFor !== null ? (
        // onConfirm may hand the slot to Record outcome before this dialog's
        // onClose runs; a flat setModal(null) would shut that dialog at once.
        <ReopenTourModal
          target={reopenFor}
          onClose={() => setModal((m) => (m === 'reopen' ? null : m))}
          onConfirm={confirmReopen}
        />
      ) : null}
```

- Outcome card: when `tour.outcome === 'no_outcome'` render the Outcome KV
  ("No outcome recorded" via `TOUR_OUTCOME_LABELS`) and, instead of the
  "Moving forward" KV, the line `Closed automatically on ${shortDate(
  tour.autoClosedAt)}` when `autoClosedAt` is a string (use the file's
  existing `shortDate` import and its KV / text styling). All other outcomes
  render exactly as today.
- Update the file header comment (one paragraph: a closed, unconverted tour
  offers Reopen; it goes back to the state it closed from; nothing is sent).
GREEN (the whole file) + typecheck. Commit.

### Task 8.6 - Tours page (`ToursPage.tsx`)

RED (`ToursPage.test.tsx`): a closed tour with `outcome: 'no_outcome'` on the
Closed tab shows a "No outcome recorded" badge; a not-a-fit one shows "Not a
fit"; a canceled tour shows no outcome badge; the Closed and Past intro
strings equal the spec's.
GREEN: in `TourRow`, after the status badge:

```tsx
          {tour.status === 'closed' && tour.outcome !== undefined ? (
            <span className={styles.badge}>{TOUR_OUTCOME_LABELS[tour.outcome] ?? tour.outcome}</span>
          ) : null}
```

(import `TOUR_OUTCOME_LABELS`), and the two `PAGE_INTRO` strings. Commit.

### Task 8.7 - Today lists no-shows

RED:

- `dashboard/src/routes/today/useTodayPastTours.test.tsx` (the no_show case
  around `:80`): the no-show is now among the rows, in date order.
- `Today.test.tsx`: a no-show row renders with its "No show" state and a link
  to `/tours/<id>` (no `?outcome=1`).
GREEN:

- delete `selectTodayPastTours` (`useTours.ts:252-263`, keep
  `TODAY_PAST_TOURS_CAP`) and its tests in `useTours.test.ts` (around
  `:297-330`);
- `useTodayPastTours.ts`: use the Past rows directly where it called the
  selector; rewrite its header (`:1-5`) and the "what Today leaves out" note
  (`:47-50`);
- `Today.tsx`: rewrite the header comment (`:7-9`) and the past-tours section
  comment (`:220-224`) - Today lists the Past tab's rows, no-shows included,
  because a no-show now leaves on its own two weeks after its last mark.
GREEN (the today and tours test files) + typecheck + lint the touched files.
Commit.

### Task 8.8 - activity labels

RED: `tourActivityFormat.test.ts` - `describeTourActivity` for
`tour_auto_closed` -> `'Closed automatically: no outcome recorded after two
weeks'`, `tour_reopened` -> `'Tour reopened'`, and
`tourActivityToMilestone` maps each to the same-named milestone type;
`listingFormat.test.ts` - `describeUnitActivity` for both types returns the
property labels AND `to: '/tours/<id>'`.
GREEN: add the entries to `TOUR_EVENT_LABELS` and `MILESTONE_TYPE`
(`tourActivityFormat.ts`) and to `TOUR_LABELS` (`listingFormat.ts`). Commit.

---

## S9 - e2e (run ONLY through the e2e workspace; see e2e/README.md)

### Task 9.1 - rewrite `e2e/tests/dashboard-next/today-past-tours.spec.ts`

The spec reseeds in `beforeAll` and creates tours 1-8 days in the past. With
no-shows on Today:

- header comment (`:1-20`): Today lists the Past rows, no-shows included.
- title `'lists past tours minus no-shows, ...'` ->
  `'lists past tours with no-shows, ...'`.
- first visit: THREE rows, most recent first:
  `[/tours/<notMarked>, /tours/<needsOutcome>?outcome=1, /tours/<noShow>]`;
  the no-show row's link name ends `, No show`; with every row shown the
  section link reads `'Open the Past tab'` (not "See all 3").
- every later `toHaveCount(2)` on the list (360px, 880px, back from the tour
  page) becomes 3; after recording the needs-outcome tour's outcome, 2.
- the cap: qualifying = notMarked (1 day), noShow (3 days), older 4-8 days =
  7 rows; Today shows 5 =
  `[notMarked, noShow, older[0], older[1], older[2]]`; the link reads
  `'See all 7 on the Past tab'`; the Past tab shows 7 rows.
- Keep every other assertion (deep link, back arrow, live drop, overflow).
Run it alone through the e2e workspace (see `e2e/README.md` for running one
spec against a lane) GREEN. Commit.

### Task 9.2 - new `e2e/tests/dashboard-next/tour-auto-close.spec.ts`

Conventions: copy `devLogin`, `NEXT`, `pastAt`, the `created` registry and
the quiet cleanup pattern from `today-past-tours.spec.ts`; lean ids
`contact-tenant-0001` and `unit-0001`; read the tenant's and the unit
landlord's phones through `GET /api/contacts/:id` / `GET /api/units/:id`
(never hard-code them); assert sends with `getOutboundTo` from
`e2e/fixtures/fakeTwilio.js`; accessibility-first selectors only
(`e2e/support/selectors.md`). EVERY tick passes `tourIds`.

```ts
async function tick(page: Page, tourIds: string[], now?: string) {
  const res = await page.request.post(`${NEXT}/__dev/tour-auto-close/tick`, {
    data: { tourIds, ...(now !== undefined && { now }) },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as { closed: number; due: number };
}
const daysFromNow = (d: number) => new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
```

Tests (one `test.describe`, `beforeAll` reseeds like today-past-tours):

1. `'a tour with no outcome closes on its own two weeks on, and nothing is
   sent'`: `since = new Date().toISOString()`; create a tour dated
   `pastAt(20, 10)`; `tick([id])` (real now) -> `closed 0` (created today:
   the clock starts at creation); `tick([id], daysFromNow(15))` -> `closed
   1`; `GET /api/tours/:id` -> status closed, outcome `no_outcome`,
   autoClosedFrom `scheduled`; the Closed tab (`/tours/closed`) row for it
   shows "No outcome recorded"; the tour page shows "Closed automatically
   on" and the "Reopen tour" button; `getOutboundTo` for the tenant and the
   landlord since `since` is empty.
2. `'reopen returns it to Not marked and gives it a fresh two weeks'`: on the
   same kind of tour (create + close as in 1), open the tour page, click
   "Reopen tour", the dialog (`getByRole('dialog', { name: 'Reopen tour' })`)
   shows the scheduled copy, click its "Yes, reopen" (scoped to the dialog);
   the badge reads "Scheduled"; the Past tab (`/tours/past`) lists it as "Not
   marked";
   `tick([id], daysFromNow(1))` -> `closed 0`; `tick([id],
   daysFromNow(15))` -> `closed 1`.
3. `'a not-a-fit tour reopens straight into Record outcome'`: create
   `pastAt(3, 10)`, PATCH toured, PATCH `{ outcome: 'not_a_fit', moveForward:
   false, status: 'closed' }`; tour page -> "Reopen tour" -> the dialog's
   "Yes, reopen" -> the "Record outcome" dialog is visible; Cancel it; the
   tour reads "Toured" and the CTA "Record outcome".
Cleanup in `afterEach`: for every created tour that is not closed, decide it
(toured + not a fit) so no later spec sees it on Past or Today.
Run the spec alone GREEN, then commit.

---

## S10 - docs and issues

### Task 10.1 - GLOSSARY (`documentation/GLOSSARY.md`, "Feature & label notes")

Add an entry: **Tour auto-close / "No outcome recorded" / Reopen** (Sam's item
18, 2026-10-01) - a tour still undecided two weeks after its clock start
(latest of its time, creation, and `lastMarkedAt` - the last time a person
marked, rescheduled or reopened it) is closed by the worker with outcome
`no_outcome` ("No outcome recorded"), silently; staff never record that
outcome. Reopen (`POST /api/tours/:tourId/reopen`) returns a closed,
unconverted tour to the state it closed from (`autoClosedFrom`, or toured for
a decided tour). Code/data: `autoClosedAt`, `autoClosedFrom`, `lastMarkedAt`,
`jobs/tourAutoClose.ts`. Commit.

### Task 10.2 - issue registry (`docs/issues/`)

- `past-tab-no-show-rows-need-an-exit.md`: `status: resolved`; append a
  RESOLVED (2026-10-01) block: closed BY DECISION (Sam, Sep 30: the two-week
  auto-close covers it; no manual exit); what shipped (no-shows leave the
  Past tab and Today two weeks after their last mark; Today lists them
  meanwhile); spec path.
- `tours-patch-status-precondition.md`: append an update block: PATCH now
  reads consistently and writes with a status precondition (409
  `tour_changed`) - the server-side window is closed; the client's
  stale-list window (a list loaded minutes earlier) remains, guarded by the
  bulk runner's re-read; status stays open.
- NEW `tour-relay-open-vs-auto-close-race.md` from `_TEMPLATE.md` (type
  debt, severity low, area app/tours): the relay-open path checks tour status
  on a read and `claimGroupThread` has no status condition, so a group opened
  in the same instant a tour auto-closes can land on a closed tour (spec
  6.6); suggested fix: a status condition on the claim.
- `tours-scheduled-range-query-unpaginated.md`: append a note that the
  auto-close sweep reads by status (paged), not by range.
- Run `npm run issues` (regenerates the ignored INDEX.md; do not commit it).
Commit the issue files.

### Task 10.3 - RUNBOOK

Add a short entry under the deploy notes section of `RUNBOOK.md`: "Tour
auto-close (first production run)" - no operator step; about 15 minutes after
the new worker starts it closes every tour already two weeks past with no
outcome; what else happens (timeline pins dated that day, reminder history
rows deleted, relay close-nags about four weeks later); how to review (Closed
tab, newest first, "No outcome recorded" badge; Reopen on the tour page).
Commit.

---

## S11 - final

1. Sync main ONCE: `cd "W:/tmp/tour-auto-close"; git fetch` is not needed
   (local main); `git merge main` - resolve preserving both sides; if the
   merge changed dependencies run `npm ci`.
2. The five gates, bare, from the worktree root, each with its real exit
   code recorded:
   1. `npm run typecheck`
   2. `npm test` (DynamoDB Local must be up; on red, follow AGENTS.md's
      re-run-and-compare rule; any `[dynamoAdmin]` line is a real container
      fault - capture it)
   3. `npm run smoke`
   4. `npm run e2e` (under a hard timeout; judge failures against a main
      baseline if they are outside this feature - this PC has shown late-run
      socket exhaustion)
   5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
      - no NEW errors versus the merge base on the same paths.
3. Live self-QA on an `npm run e2e:session` lane with the Playwright MCP: the
   auto-closed tour on the Closed tab and tour page; Reopen into each target;
   the no-show on Today; screenshots under `.playwright-mcp/`.

## 12. Watch items

- The harness fake must match the real repo's conditions (S2) - a looser fake
  makes route tests green on a broken store.
- Existing tests that wrap `world.toursRepo.patch` must forward the third
  argument (Task 4.2); a test that fails because it encodes last-writer-wins
  is a STOP-and-report, not a weaken.
- `recordTourEvent` extraction is a pure refactor: `toursApi.test.ts` must
  pass unchanged (Task 3.2).
- The guarded modal close (Task 8.5) - a flat `setModal(null)` shuts Record
  outcome the instant it opens.
- The dev tick in e2e must ALWAYS pass `tourIds` (a lane-wide future tick
  closes other specs' tours).
- Do not assert on `booked_too_late` reminder rows after a close (the close
  deletes never-sent rows).
- `no_outcome` must not become recordable anywhere in the dashboard
  (`StaffTourOutcome` on `patchTour` and the outcome dialog).
- Never edit source while this worktree's e2e runs; never restart DynamoDB
  Local; never run Playwright outside the e2e workspace.
- ASCII on every touched line; no `\u` through the Edit tool.
