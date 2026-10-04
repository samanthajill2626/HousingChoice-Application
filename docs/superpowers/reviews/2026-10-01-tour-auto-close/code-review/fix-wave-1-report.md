# Fix wave 1 report - code review round 1 (feat/tour-auto-close)

- Date: 2026-10-04. Implementer: the fix-wave-1 subagent (Claude Opus 5.5),
  worktree `W:\tmp\tour-auto-close`, starting HEAD 91ba43c4.
- Scope: exactly FW-1..FW-7 of `code-review/adjudications-r1.md` section 2.
  Nothing outside that list was changed (section 4 lists the in-file extras
  and why).
- Vitest summary lines below are copied from the runs; vitest's ellipsis and
  the issues script's arrow / middle dot are written here as `...`, `->` and
  `,` (ASCII rule).

## 1. Commits

| fix | commit | subject | files |
|---|---|---|---|
| FW-1 | e95622a6 | fix(tours): auto-close conditions on updatedAt for a never-marked tour (review r1 AD-1, ruling A-1) | `app/src/repos/toursRepo.ts`, `app/src/jobs/tourAutoClose.ts`, `app/test/helpers/twilioWebhookHarness.ts`, `app/test/toursRepo.integration.test.ts`, `app/test/toursRepoFakeConditions.test.ts`, `app/test/tourAutoClose.test.ts` |
| FW-2 | e2501b09 | fix(tours): close-nag arm / clear lines carry the tourId (review r1 SC-1) | `app/src/jobs/tourAutoClose.ts`, `app/src/routes/tours.ts`, `app/test/tourAutoClose.test.ts` |
| FW-3 | 9a444d07 | test(tours): pin the nag-only-on-open-relay rule and the undated scheduled clock (review r1 SC-2, SC-3) | `app/test/tourAutoClose.test.ts`, `app/test/toursModel.test.ts` |
| FW-4 | 02b13963 | test(harness): the fake tour conditions branch string-vs-absent like the store (review r1 SC-5) | `app/test/helpers/twilioWebhookHarness.ts` |
| FW-5 | b1018603 | docs(tours): the PATCH precondition refuses a concurrent STATUS change only (review r1 AD-3) | `app/src/routes/tours.ts` (comment), `docs/issues/tours-patch-status-precondition.md` |
| FW-6a | a83417a5 | docs(spec): tour auto-close 6.3 - updatedAt is conditioned for a never-marked tour (ruling A-1) | `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` |
| FW-6b | 78be74c4 | docs(issues): file tour-reopen-edge-states (review r1 AD-5, AD-7, AD-8) | `docs/issues/tour-reopen-edge-states.md` (new) |
| FW-7 | (this file's commit) | docs(records): fix wave 1 report | this file |

FW-4 did NOT share FW-1's commit: FW-1's harness hunk introduces the
`storedAsRead` helper (`app/test/helpers/twilioWebhookHarness.ts:3464-3469`)
and already uses it for `lastMarkedAt` and `updatedAt` (the new term hangs off
`lastMarkedAt`'s absent branch, so that branch had to become explicit); the
FW-4 commit applies the same helper to the remaining three fields.

## 2. Per fix: RED and GREEN

### FW-1 (AD-1, ruling A-1) - strict TDD

Tests written first: integration +2
(`app/test/toursRepo.integration.test.ts:771`, `:790`, helper `:763`), fake
parity +2 (`app/test/toursRepoFakeConditions.test.ts:217`, `:237`, helper
`:210`), job +1 (`app/test/tourAutoClose.test.ts:261`). The unrelated write is
`clearRoster` (touches no status / outcome / scheduledAt / lastMarkedAt); each
repo-level case waits for the wall clock to pass the read's `updatedAt`
millisecond first and asserts the stored `updatedAt` really moved. The job
case wraps `world.toursRepo.autoCloseIf` to run `clearRoster` before the real
close, on a seed whose `updatedAt` is pinned (CLOCK TRAP) and an open relay
group linked by a direct map write.

RED (tests only, unchanged code), each for the predicted reason - the close
landed on the stale read:

- integration (DynamoDB Local): `Tests  1 failed | 55 passed (56)`; the
  unmarked case: `expected { tourType: 'self_guided', ...(12) } to be
  undefined`. The (PIN) marked case passed, by design.
- fake parity: `Tests  1 failed | 29 passed (30)`; `expected { tenantId:
  'contact-close-ua', ...(12) } to be undefined`.
- job: `Tests  1 failed | 15 passed (16)`; the summary diff was `closed: 1,
  lost: 0` against the expected `closed: 0, lost: 1`.

Implementation: `app/src/repos/toursRepo.ts:726-741` (in the
`attribute_not_exists(#lm)` branch: `#ua = :ua` from the read, or
`attribute_not_exists(#ua)` when the read has no string `updatedAt`); the
harness mirror in the same synchronous check
(`twilioWebhookHarness.ts:3646-3648`). Comments rewritten: the interface doc
(`toursRepo.ts:287-303`) and the job header (`app/src/jobs/tourAutoClose.ts:10-21`)
now state exactly what is conditioned (status, no outcome, no conversion
claim, not convertible, the same scheduledAt, the same lastMarkedAt, and only
for a never-marked tour the same updatedAt) and name the same-millisecond
residual as a false negative of the guard.

GREEN: integration `Tests  56 passed (56)`; fake parity `Tests  30 passed
(30)`; job `Tests  16 passed (16)`. Dependent suites right after: toursApi
`Tests  214 passed (214)`, toursReopenApi `Tests  18 passed (18)`,
devTourAutoCloseTick `Tests  7 passed (7)`.

Mutation check of the two (PIN) cases (the over-correction - the term applied
to MARKED tours too - put into both the real repo and the fake, run, then
reverted before the commit): integration `Tests  1 failed | 55 passed (56)`,
fake `Tests  1 failed | 29 passed (30)`, in each the (PIN) case: `expected
undefined to match object { status: 'closed', ...(3) }`. So the PINs hold the
"only for never-marked tours" half of the ruling.

### FW-2 (SC-1) - strict TDD

Test first (`app/test/tourAutoClose.test.ts:353`, modeled on probe P6): two due
tours, the first linked to an open relay group whose `getById` rejects.

RED: `Tests  1 failed | 16 passed (17)`; `expected [ [ undefined, 'conv-1' ]
] to deeply equal [ [ 'tour-1', 'conv-1' ] ]` - the ERROR line `relay close-nag
arm failed (best-effort)` had the conversationId and no tourId. The summary
(`closed: 2`) and status assertions above it already passed, as predicted.

Implementation: `log.child({ tourId: tour.tourId })` at the sweep's arm call
(`app/src/jobs/tourAutoClose.ts:131-137`) and `log.child({ tourId })` at the
reopen route's clear call (`app/src/routes/tours.ts:1515-1521`). The shared
helpers in `app/src/services/relayCloseNag.ts` are unchanged.

GREEN: job `Tests  17 passed (17)`; toursReopenApi `Tests  18 passed (18)`;
devTourAutoCloseTick `Tests  7 passed (7)`.

The route change has no committed test (`app/test/toursReopenApi.test.ts` is
not in the fix list). Evidence instead, a throwaway probe (reopen of an
auto-closed tour whose linked group's `getById` rejects, the harness's log
capture read back): with the fix `Tests  1 passed (1)`, captured line
`{"tourId":"tour-1","conversationId":"conv-1"}`; with the route's pre-fix
call shape restored transiently, `Tests  1 failed (1)`, captured line
`{"conversationId":"conv-1"}`. Probe deleted, route restored to the fix.

### FW-3 (SC-2, SC-3) - coverage of behavior that is already right

No RED is possible without a production change (the reviewers' probes P3 and
P1 showed the behavior right). Cases added:
`app/test/tourAutoClose.test.ts:328` (a CLOSED relay group, closed through
`setRelayStatus`) and `:340` (an open `tenant_1to1` thread named by
`groupThreadId`), both titled (PIN): each tour closes and the conversation
gains no `close_nag_next_at`. `app/test/toursModel.test.ts:254` case 9 now
loops over `scheduled`, `toured` and `no_show` (title updated).

On unchanged production code: job `Tests  19 passed (19)`; model `Tests  42
passed (42)` (case 9 extended in place, so the count is unchanged).

Mutation probe, without touching the read-only helper: a throwaway file
replaced `armRelayCloseNagIfOpen` through `vi.mock` with a mutant that drops
the relay-type and open-status checks, and ran the same two assertions:
`Tests  2 failed (2)` (`expected '2026-11-01T18:59:15.885Z' to be undefined`,
and the same for the thread). Probe deleted.

### FW-4 (SC-5) - hardening, no RED required

Change: `twilioWebhookHarness.ts:3646` (`scheduledAt`) and `:3672-3673`
(`outcome`, `autoClosedFrom`) now go through `storedAsRead`: a string read
must equal the stored value, any other read requires the attribute absent.

Throwaway probe, three non-string reads through DynamoDB Local AND the fake
(an undated tour closed with a read carrying `scheduledAt: null`; reopen of a
closed row stored with `outcome: NULL`; reopen of one stored with
`autoClosedFrom: NULL`). Before: `store [true,false,false] fake
[false,true,true]` -> `Tests  1 failed (1)` (the fake was stricter on the
first and looser on the other two). After: `store [true,false,false] fake
[true,false,false]` -> `Tests  1 passed (1)`. Probe deleted; it created and
dropped its own throwaway-prefix table, like the integration file.

GREEN after the change: fake parity `Tests  30 passed (30)`; toursApi `Tests
214 passed (214)`; toursReopenApi `Tests  18 passed (18)`; tourAutoClose
`Tests  19 passed (19)`; devTourAutoCloseTick `Tests  7 passed (7)`.

### FW-5 (AD-3) - comments only

`app/src/routes/tours.ts:1228-1233`: a concurrent STATUS change (another PATCH
that changed status, a conversion finalize, the auto-close sweep) is refused;
only status is conditioned, so a same-status concurrent PATCH (an exit gate,
a reschedule) or a conversion claim still merges as before.
`docs/issues/tours-patch-status-precondition.md` update block: same precision
("closed for STATUS changes"), plus the sentence that the same-status window
is pre-existing and still open - two exit-gate PATCHes on one toured tour both
answer 200 and write two `tour_outcome` activity rows (the once-only check
reads the pre-patch outcome, `routes/tours.ts:1443`). Status stays open.

### FW-6 (ruling A-1 text; AD-5, AD-7, AD-8)

(a) Spec 6.3: the "Residual (accepted)" paragraph is replaced (spec `:301-318`)
by the rule, why it is limited to never-marked tours, the same-millisecond
residual, and the tag "(Changed 2026-10-04, ruling A-1 in
code-review/adjudications-r1.md: ...)". Nothing else in the spec changed.

(b) New `docs/issues/tour-reopen-edge-states.md` from the template (comment
block deleted; id = filename; debt; low; open; app/tours; created
2026-10-04): three paragraphs, AD-5, AD-7, AD-8, each with its suggested fix.
Every ref was checked against the live tree after the code commits
(`toursModel.ts:253-258`, `tourReopen.ts:12-20`, `routes/tours.ts:1051-1106`,
`:1124-1127`, `:1134-1166`, `:1143-1149`, `:1459-1464`, `:1494`, `:1504`,
`:1517`, `relayCloseNag.ts:84-113`, `today.ts:1001-1004`,
`toursRepo.ts:785-797`, `:803`, `TourDetail.tsx:110`, `:318`).

`npm run issues`: exit 0, output `[issues] 363 open, 193 closed, 556 total ->
docs/issues/INDEX.md` and `[issues] open by severity: 7 high, 146 med, 210
low`; no warning line at all. `docs/issues/INDEX.md` is gitignored
(`.gitignore:62`) and was not committed.

## 3. Gates (run after the code and docs commits, HEAD 78be74c4)

| gate | command | result |
|---|---|---|
| typecheck | `npm run typecheck` (repo root) | exit 0 (app includes `tsconfig.test.json`) |
| eslint | `npx eslint` on the 8 named files | exit 0, no output |
| tests | `npx vitest run test/toursRepo.integration.test.ts` (app) | exit 0, `Tests  56 passed (56)` |
| tests | `npx vitest run test/toursRepoFakeConditions.test.ts` | exit 0, `Tests  30 passed (30)` |
| tests | `npx vitest run test/tourAutoClose.test.ts` | exit 0, `Tests  19 passed (19)` |
| tests | `npx vitest run test/toursModel.test.ts` | exit 0, `Tests  42 passed (42)` |
| tests | `npx vitest run test/toursApi.test.ts` | exit 0, `Tests  214 passed (214)` |
| tests | `npx vitest run test/toursReopenApi.test.ts` | exit 0, `Tests  18 passed (18)` |
| tests | `npx vitest run test/devTourAutoCloseTick.test.ts` | exit 0, `Tests  7 passed (7)` |

No `[dynamoAdmin]` line in any run. The three FW-1 files were then run three
more times each (the millisecond wait is the only timing-sensitive part): 9 of
9 green. Not run, as briefed: `npm test`, `npm run smoke`, `npm run e2e`; no
e2e lane or session was started; the DynamoDB Local and S3 containers were
not touched.

## 4. Changed beyond the list, and why

- FW-1: two comments in named files that stated the old rule were corrected
  with the code - the integration file's section header
  (`toursRepo.integration.test.ts:628-630`, "never updatedAt equality") and
  the fake's autoCloseIf comment.
- FW-3: the two new job cases pass on unchanged code by design, so their
  titles carry "(PIN)" (the repo's convention); case 9's title now names
  `scheduled`.
- FW-5: "a conversion claim" is named among the same-status writes that still
  merge (AD-3 names it). The issue's update block had line refs that this
  wave's own edits shifted; they now point at the live tree
  (`routes/tours.ts:1234`, `:1235-1249`, `toursRepo.ts:469-474`).
- FW-6a: because "change nothing else in the spec" keeps the CONDITION
  bullet's "never `updatedAt` equality" wording, the new paragraph says it
  amends that bullet (it now holds for marked tours only).
- Transient, none committed: two mutants (FW-1's PIN check in `toursRepo.ts`
  and the harness; FW-2's route log shape) and three probe files
  (`app/test/zz-fw2-probe.test.ts`, `zz-fw3-probe.test.ts`,
  `zz-fw4-probe.test.ts`), each reverted / deleted before the next commit;
  `grep MUTANT` over `app/src` and `app/test` is empty, no `zz-*` file
  remains, the tree was clean at every commit.

## 5. Not done, and notes for the orchestrator

- No committed test pins the reopen route's clear line carrying `tourId`
  (FW-2): `app/test/toursReopenApi.test.ts` is outside the fix list. The
  probe in section 2 is the only evidence; a one-case addition there is
  cheap if a later wave wants it.
- Line drift this wave caused in docs outside the fix list (not edited):
  `docs/issues/tour-relay-open-vs-auto-close-race.md` cites `toursRepo.ts:496`,
  `:540`, `:679` (now `:502`, `:546`, `:685`) and `routes/tours.ts:1544`,
  `:1550`, `:1559`, `:1644` (now 8 lines lower: `:1552`, `:1558`, `:1567`,
  `:1652`); `docs/issues/tours-scheduled-range-query-unpaginated.md` cites
  `toursRepo.ts:393` (now `:399`). The S11 main sync will move them again;
  re-point after it if wanted.
- Production note for the handback: the sweep lists candidates from the
  eventually consistent `byStatus` GSI. With the new term, a never-marked tour
  whose index copy lags a recent write (any write, so its clock restarted
  anyway) now loses its close and is re-evaluated 15 minutes later - the
  intended direction (a skip, never a false close). Such runs count `lost`
  and, as before, log nothing unless `closed` or `failed` is non-zero.
