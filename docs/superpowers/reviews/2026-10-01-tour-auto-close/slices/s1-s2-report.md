# Slice report - S1 (model) and S2 (repo + harness fake)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 55d5555d (main @ae04122d plus docs-only commits).
- Sources followed: plan sections 0, 1, S1, S2; spec 5, 6.3, 7.3, 8; the
  binding corrections in `research/drift-s1-s2-model-repo.md` (A, B, E) and
  `research/worklist.md` decisions D-a and D-b.
- Scope held: only the files the brief allowed were touched (listed under
  "Files" below). No spec, plan or other docs edits besides this report.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| f0b4789e | 1.1 | feat(tours): no_outcome outcome + staff-only PATCH outcome guard |
| b18f8937 | 1.2 | feat(tours): auto-close two-week clock (autoCloseDueAtMs, isAutoCloseDue) |
| ca8536b7 | 1.3 | feat(tours): reopenTargetFor + lifecycle header for auto-close and reopen |
| f5eeb7e8 | 2.1 | feat(tours): TourItem auto-close attributes; repo TourOutcome re-exports the model |
| f81955fb | 2.2 | feat(tours): toursRepo.patch expectedStatus precondition (real + fake) |
| 52ea34d2 | 2.3 | feat(tours): toursRepo.autoCloseIf conditional close (real + fake) |
| 4f911c9e | 2.4 | feat(tours): toursRepo.reopenIf conditional reopen (real + fake) |
| (this) | records | docs(records): this report |

Every commit: bare `git status` read first, MERGE_HEAD checked absent (both
`.git/MERGE_HEAD` and `git rev-parse --git-path MERGE_HEAD`), explicit paths
staged, ASCII message, `Co-Authored-By: Claude Opus 5.5` trailer. Task 1.1
carries the routes/tours.ts validator switch in the same commit, per the plan.
No survivor-pin commit was needed (section 5).

Files: `app/src/lib/toursModel.ts`, `app/src/repos/toursRepo.ts`,
`app/src/routes/tours.ts` (import block + validator only),
`app/test/helpers/twilioWebhookHarness.ts` (import block + fake toursRepo only),
`app/test/toursModel.test.ts`, `app/test/toursApi.test.ts` (one PIN case only),
`app/test/toursRepo.integration.test.ts` (appended at the end of its describe),
new `app/test/toursRepoFakeConditions.test.ts`.

## 2. Per task: RED reason, GREEN result

Baseline before any edit: toursModel 19, toursRepo.integration 26, toursApi 204
- all green. Lint baseline on the seven files: exactly one error,
`routes/tours.ts 58:8 'TourOutcome' is defined but never used`.

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 1.1 | toursModel: 6 failed - TOUR_OUTCOMES lacks no_outcome, isTourOutcome('no_outcome') false, label undefined, `STAFF_TOUR_OUTCOMES is not iterable`, `isStaffTourOutcome is not a function` x2. The toursApi PIN passed on unchanged code; with the MODEL half applied alone it went red (`expected 200 to be 400` - staff could record no_outcome), then green after the validator switch. | toursModel 24 + toursApi 205 = 229 passed |
| 1.2 | 12 failed - `AUTO_CLOSE_AFTER_MS` undefined, `autoCloseDueAtMs` / `isAutoCloseDue` not a function | toursModel 36 passed |
| 1.3 | 6 failed - `reopenTargetFor is not a function` | toursModel 42 passed |
| 2.1 | none by plan design ("declarations only"); typecheck is the gate | typecheck exit 0 |
| 2.2 | 2 failed (1 integration, 1 fake) - "promise resolved instead of rejecting": the stale-expectedStatus patch was written (opts ignored). The 4 PINs (2 per file) passed on unchanged code. | integration 29 + fake 3 = 32 passed |
| 2.3 | 30 failed (15 cases x 2 files), every one `tours.autoCloseIf is not a function` | integration 44 + fake 18 = 62 passed |
| 2.4 | 20 failed (10 cases x 2 files), every one `reopenIf is not a function` | integration 54 + fake 28 = 82 passed |

Final run of all four touched test files together (post-mutant, clean tree):
toursModel 42, toursRepo.integration 54, toursRepoFakeConditions 28,
toursApi 205 - 329 passed, exit 0. Sanity runs of toursApi (205) after 2.2,
2.3 and 2.4 because the harness fake changed.

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after every task (1.1, 1.2, 1.3, 2.1, 2.2, 2.3,
  2.4) and again on the final committed state.
- `npx eslint app/src/lib/toursModel.ts app/src/repos/toursRepo.ts
  app/src/routes/tours.ts app/test/toursModel.test.ts
  app/test/toursRepo.integration.test.ts app/test/toursRepoFakeConditions.test.ts
  app/test/helpers/twilioWebhookHarness.ts`: exit 0 (the one baseline error is
  removed by Task 1.1, decision D-a). `npx eslint app/test/toursApi.test.ts`:
  exit 0.
- ASCII: `git diff -U0 | grep '^+' | grep -P '[^\x00-\x7F]'` printed nothing
  for every edited file after every edit; the new test file has 0 non-ASCII
  bytes (`tr` check).
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.
  Note for S11: toursRepo.ts now carries a VALUE import of
  `../lib/toursModel.js` (drift A.1), which is exactly what the smoke gate
  resolves in the compiled output.

## 4. Divergences from the plan, and why

Drift corrections applied (binding):

1. D-a / drift A.2 (Task 1.1): the routes/tours.ts import statement drops
   `isTourOutcome`, `TOUR_OUTCOMES` AND the pre-existing unused
   `type TourOutcome`, in the same statement edit as adding
   `isStaffTourOutcome` / `STAFF_TOUR_OUTCOMES` (routes/tours.ts:50-60). The
   validator is at routes/tours.ts:1046-1049 (one line up from :1047, because
   the import block shrank by one line).
2. Drift A.1 (Task 2.3): toursRepo.ts:38 became the mixed import
   `import { isAutoCloseStatus, type AutoCloseStatus, type TourOutcome, type TourType } from '../lib/toursModel.js';`.
   Task 2.1 had made it `import type { AutoCloseStatus, TourOutcome, TourType }`
   exactly as the plan says; 2.3 converted it when the value was needed.
3. Drift A.3 (Task 2.3): new harness import
   `import { isAutoCloseStatus } from '../../src/lib/toursModel.js';`
   (twilioWebhookHarness.ts:158, beside the toursRepo import).
4. Drift A.4 (Task 2.4 case 1): reopenIf is handed the POST-close item that
   autoCloseIf returned. Both test files share the shape through a
   `seedClosed(repo, 'auto' | 'person' | 'bare')` helper whose `auto` branch
   returns autoCloseIf's ALL_NEW item.
5. Drift A.5 (Tasks 1.1 / 1.3): every rewritten line is ASCII. The replaced
   outcomes block removed the old :67 em dash; the rewritten `closed`
   paragraph replaced the old :33 em dash with " - ". Untouched pre-existing
   non-ASCII lines remain at toursModel.ts:1, :5, :25 (old :22 - inside the
   lifecycle header but not part of the plan's change, so not rewritten) and
   :146 (old :125). The ratchet rule allows them.
6. D-b (Task 2.2+): the plan's two-file parity form - every S2 case exists in
   toursRepo.integration.test.ts (DynamoDB Local) and, row for row, in the new
   toursRepoFakeConditions.test.ts (createFakeWorld()).

Found myself / chosen within the plan's latitude:

7. Test strength beyond the plan's list (all additive, no plan case dropped):
   - 1.1 PIN asserts the EXACT 400 body
     `{ error: 'outcome must be one of: move_forward, not_a_fit' }` (plan:
     "containing") and that the stored tour is still toured with no outcome /
     moveForward.
   - 1.2: a non-string `scheduledAt` -> null; an unreadable `updatedAt` is not
     read at all once `lastMarkedAt` exists (-> DUE).
   - 1.3: not-closed takes precedence over a conversion; `autoClosedFrom`
     wins over a person outcome when both exist; closed + `no_outcome` alone
     -> `tour_reopen_unsupported`.
   - 2.2: the stale precondition also refuses a patch that does not touch
     `status`; the missing-tour PIN asserts no stub row is created.
   - 2.3: one race row per condition term AND per branch (scheduledAt equal /
     absent, lastMarkedAt equal / absent) - 8 rows; a `convertible: false` win
     (pins the `#cv <> :true` half and the fake's `=== true`);
     `autoClosedAt === updatedAt` and >= the pre-call wall clock.
   - 2.4: 7 race rows where the plan named 3 - adds isolation rows for the
     status term ("it left closed (outcome kept)"), the absent-outcome branch
     ("an outcome appeared", API-only bare shape), and both autoClosedFrom
     branches; the win asserts updatedAt is the wall clock, not the mark.
     Mutant R1-fake (section 5) shows the status isolation row is necessary:
     the plan's "a first reopen already ran" row alone does not kill a fake
     that drops its status check (the outcome / autoClosedFrom terms also
     catch that row).
8. Placement: `PatchTourOptions` sits right after `PatchTourInput`;
   `autoCloseIf` and `reopenIf` are appended after `clearRoster` in the
   interface and in both implementations (the plan named no position). The
   `patch` interface doc now also states the expectedStatus refusal.
9. The plan's code was otherwise taken verbatim (including the fake's
   `as TourItem['autoClosedFrom']` cast and both methods' debug-level logs).
   `TourItem.outcome`'s own doc line was left as is.
10. Task 2.1's importer grep was re-run (multiline import regex across the
    repo): no file imports `TourOutcome` or `TourStatus` from the repo -
    matches drift B.6. Re-checked before 2.3: the only `ToursRepo`
    implementers are `createToursRepo` and the harness fake; the other typed
    uses are `Pick<ToursRepo, 'get'>` (relayFanOut.ts:371,
    rosterResolution.ts:156).

No STOP condition was hit: no unexpected importer, no import cycle
(toursModel.ts still imports nothing), no contract mismatch with the
reference quotes, no unpredicted red in an existing test.

## 5. Mutant check (one-line mutants, applied with Edit, reverted with Edit)

Each repo run paired one real-repo mutant with one fake mutant: the
integration file exercises only the real repo and the parity file only the
fake, so each file's result attributes to its own mutant. After the last
revert `git diff --quiet` was clean and all four files re-ran green (329).
Real-repo mutants that drop a term whose placeholder is used nowhere else
were written as tautologies (e.g. `(attribute_not_exists(#cp) OR
attribute_exists(#cp))`), because DynamoDB rejects an unused expression name
or value with a ValidationException - a deletion would "fail" every test for
the wrong reason.

Task 1.2 clock (toursModel.ts) - 6 mutants, 6 killed:

| id | mutant | killed by |
|---|---|---|
| M1.1 | `due <= nowMs` -> `due < nowMs` | case 12 (inclusive boundary) |
| M1.2 | `lastMarkedAt !== undefined` -> `!== null` | cases 10, 11 |
| M1.3 | drop `if (tour.convertible === true) return null` | cases 5, 12 |
| M1.4 | `due !== null && due <= nowMs` -> `due! <= nowMs` | case 12 (null guard) |
| M1.5 | drop the `scheduledAt !== ''` check | case 9 |
| M1.6 | drop the unreadable-mark refusal (`markedMs ?? 0`) | case 10 |

autoCloseIf - real (toursRepo.ts) 8 mutants, 7 killed + 1 equivalent;
fake (harness) 8 mutants, 8 killed:

| id | real mutant -> killed by | fake mutant -> killed by |
|---|---|---|
| A1 | drop up-front refusal -> the 3 refusal cases | same -> the 3 refusal cases |
| A2 | delete `#st = :from` -> "the status changed" | delete `t.status !== tour.status` -> "the status changed" |
| A3 | `#cp` term tautology -> "a conversion was claimed" | delete `t.convertedPlacementId !== undefined` -> "a conversion was claimed" |
| A4 | `#sa = :sa` tautology -> "it was rescheduled" | delete `t.scheduledAt !== tour.scheduledAt` -> "it was rescheduled", "an undated tour got a date" |
| A5 | `attribute_not_exists(#lm)` tautology -> "a person marked it for the first time" | `t.lastMarkedAt !== tour.lastMarkedAt` -> `false` -> both mark rows |
| A6 | (exploratory) `(attribute_not_exists(#cv) OR #cv <> :true)` -> `#cv <> :true` -> SURVIVED, equivalent (below) | `t.convertible === true` -> `!== undefined` -> the convertible: false win (+ reopen 'auto' seeds) |
| A6b | whole `#cv` term tautology -> "it became convertible" | delete `t.outcome !== undefined` -> "an outcome was recorded" |
| A7/A8 | delete `attribute_not_exists(#oc)` -> "an outcome was recorded" | drop `t.currentLadderId = rotation` -> the scheduled win, the reopen auto win |

reopenIf - real 6 mutants, 6 killed; fake 6 mutants, 6 killed:

| id | real mutant -> killed by | fake mutant -> killed by |
|---|---|---|
| R1 | `#st = :closed` tautology -> "it left closed (outcome kept)" | delete `t.status !== 'closed'` -> "it left closed (outcome kept)" |
| R2 | `#cp` term tautology -> "a conversion was claimed" | delete `t.convertedPlacementId !== undefined` -> "a conversion was claimed" |
| R3 | `#oc = :oc` tautology -> "the outcome changed" | delete `t.outcome !== tour.outcome` -> "the outcome changed", "an outcome appeared" |
| R4 | `attribute_not_exists(#acf)` tautology -> "autoClosedFrom appeared" | `t.autoClosedFrom !== tour.autoClosedFrom` -> `false` -> both autoClosedFrom rows |
| R5 | `#acf = :acf` tautology -> "autoClosedFrom changed" | drop `delete t.moveForward` -> both wins |
| R6 | `':now': lastMarkedAt` (updatedAt = the mark) -> the auto-closed win | `t.updatedAt = lastMarkedAt` -> the auto-closed win |

Totals: 34 mutants, 33 killed, 1 survivor.

The survivor (A6, real only) is an EQUIVALENT mutant on DynamoDB Local:
with the condition reduced to `#cv <> :true`, all 54 integration cases still
pass - including the win on a tour with NO `convertible` attribute - so
DynamoDB Local evaluates `<>` against a missing attribute as TRUE, and the
`attribute_not_exists(#cv) OR` half is behaviorally redundant there. No
behavior test can kill it, so there is no pin to add; the behavior that
matters (an absent `convertible` closes, `convertible: true` does not, and
`convertible: false` does) is already pinned by the case-1 win, the
"it became convertible" row and the `convertible: false` win (A6b proves the
term as a whole is pinned). The explicit half is kept as the spec (6.3)
writes it: it states intent and holds on any engine that evaluates a missing
attribute differently.

## 6. Contracts the downstream slices consume (final, as committed)

`app/src/lib/toursModel.ts` (pure, still no imports):

```ts
export const TOUR_OUTCOMES = ['move_forward', 'not_a_fit', 'no_outcome'] as const;            // :75
export type TourOutcome = (typeof TOUR_OUTCOMES)[number];                                     // :77
// TOUR_OUTCOME_LABELS.no_outcome === 'No outcome recorded'                                   // :81-85
export const STAFF_TOUR_OUTCOMES = ['move_forward', 'not_a_fit'] as const satisfies readonly TourOutcome[]; // :94
export type StaffTourOutcome = (typeof STAFF_TOUR_OUTCOMES)[number];                          // :96
export function isStaffTourOutcome(x: unknown): x is StaffTourOutcome;                        // :101
export const AUTO_CLOSE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;                                  // :162 (1209600000)
export const AUTO_CLOSE_STATUSES = ['scheduled', 'toured', 'no_show'] as const satisfies readonly TourStatus[]; // :166
export type AutoCloseStatus = (typeof AUTO_CLOSE_STATUSES)[number];                           // :168
export function isAutoCloseStatus(x: unknown): x is AutoCloseStatus;                          // :172
export interface AutoCloseClockInput {                                                        // :177
  status: unknown; outcome?: unknown; convertible?: unknown; convertedPlacementId?: unknown;
  scheduledAt?: unknown; createdAt?: unknown; lastMarkedAt?: unknown; updatedAt?: unknown;
}
export function autoCloseDueAtMs(tour: AutoCloseClockInput): number | null;                   // :201
export function isAutoCloseDue(tour: AutoCloseClockInput, nowMs: number): boolean;            // :228 (inclusive, null-safe)
export type ReopenRefusal = 'tour_not_closed' | 'tour_converted' | 'tour_reopen_unsupported'; // :240
export interface ReopenTargetInput {                                                          // :242
  status: unknown; outcome?: unknown; convertedPlacementId?: unknown; autoClosedFrom?: unknown;
}
export type ReopenTargetResult =                                                              // :249
  | { ok: true; target: AutoCloseStatus }
  | { ok: false; error: ReopenRefusal };
export function reopenTargetFor(tour: ReopenTargetInput): ReopenTargetResult;                 // :253
```

`autoCloseDueAtMs` returns null for: a status outside AUTO_CLOSE_STATUSES; any
`outcome`; `convertible === true`; any `convertedPlacementId` string; a
missing or unparseable `createdAt`; a present-but-unparseable `scheduledAt`
(an empty string counts as undated) or mark. The mark is `lastMarkedAt` when
it is not undefined, else `updatedAt`. Due = max(createdAt, scheduledAt,
mark) + AUTO_CLOSE_AFTER_MS. `reopenTargetFor` checks in order: not closed;
any `convertedPlacementId` string; `autoClosedFrom` a candidate status (wins
over an outcome); outcome `not_a_fit` / `move_forward` -> `toured`; else
unsupported.

`app/src/repos/toursRepo.ts`:

```ts
import { isAutoCloseStatus, type AutoCloseStatus, type TourOutcome, type TourType } from '../lib/toursModel.js'; // :38
export type { TourOutcome, TourType };                       // :49 (the hand-copied union is gone)
// TourItem additions (after `convertible`):
  autoClosedAt?: string;                                     // :106 wall clock of the close; reopen removes it
  autoClosedFrom?: AutoCloseStatus;                          // :109 status closed FROM; reopen removes it
  lastMarkedAt?: string;                                     // :113 person mark / reopen; never removed
export interface PatchTourOptions {                          // :173
  expectedStatus?: string;                                   // :180
}
// ToursRepo:
  patch(tourId: string, updates: PatchTourInput, opts?: PatchTourOptions): Promise<TourItem>;            // :221
  autoCloseIf(tour: TourItem, rotation: string): Promise<TourItem | undefined>;                          // :298
  reopenIf(tour: TourItem, target: AutoCloseStatus, lastMarkedAt: string): Promise<TourItem | undefined>; // :308
```

Behavior the callers rely on:

- `patch(..., { expectedStatus })`: condition
  `attribute_exists(tourId) AND #expectedStatus = :expectedStatus`; a
  mismatch throws `ConditionalCheckFailedException`, indistinguishable from a
  missing tour (S4 re-reads to tell them apart). Without opts: unchanged.
- `autoCloseIf(tour, rotation)`: returns `undefined` with NO write when
  `tour.status` is not a candidate; otherwise one UpdateItem: SET status
  closed, outcome no_outcome, autoClosedFrom = tour.status, autoClosedAt =
  updatedAt = wall clock, currentLadderId = rotation; condition = exists AND
  status as read AND no outcome AND no convertedPlacementId AND
  (no convertible OR convertible <> true) AND scheduledAt equal-or-absent AND
  lastMarkedAt equal-or-absent. Returns the ALL_NEW item; `undefined` on a
  lost condition or a missing tour; any other error propagates (S5 counts it
  as `failed`). Logs at debug only; the job owns the info line.
- `reopenIf(tour, target, lastMarkedAt)`: SET status = target, lastMarkedAt
  = the argument, updatedAt = wall clock; REMOVE outcome, moveForward,
  convertible, autoClosedAt, autoClosedFrom; condition = exists AND status
  closed AND no convertedPlacementId AND outcome equal-or-absent AND
  autoClosedFrom equal-or-absent (both read from `tour` - hand it the
  CONSISTENT read, spec 7.3). currentLadderId untouched. Returns ALL_NEW or
  `undefined`; other errors propagate. Debug logs only.
- The harness fake implements all three with the same conditions as one
  synchronous check-and-set; parity is pinned by
  toursRepoFakeConditions.test.ts.

## 7. Heads-ups for later slices

- Shifted anchors (my edits moved them): routes/tours.ts is one line up after
  the import block - the PATCH eventually consistent read is now :1056 and
  the main `tours.patch(tourId, patch)` write :1238. toursApi.test.ts's patch
  wrappers moved +22 lines: :2066, :2144, :2264 (zero-argument stub), :3324
  (restored at :3333). The harness fake toursRepo literal starts at :3464;
  its new methods sit at :3623 (autoCloseIf) and :3652 (reopenIf);
  `deleteSupersededForTour` is now :3768.
- Clock trap (drift B.11 / D-f) still applies to S5: both `create`s stamp
  `updatedAt` with the wall clock but pass `status`, `lastMarkedAt`,
  `autoClosedFrom`, `outcome` through - my tests seed shapes that way.
- DynamoDB Local treats `<>` against a missing attribute as true (section 5).
</content>
</invoke>
