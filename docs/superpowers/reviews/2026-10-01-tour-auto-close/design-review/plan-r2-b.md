# Plan review round 2 (reviewer B) - tour auto-close and reopen

- Plan: `docs/superpowers/plans/2026-10-01-tour-auto-close-reopen.md` (PLAN v3 @4f45fa2e)
- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` (APPROVED)
- Inputs read: the v2 -> v3 plan diff, the spec diff, `adjudications.md` (Plan
  round 1), `plan-r1-a.md`, my `plan-r1-b.md`.
- Method: the new material was reviewed cold against the repo (existing tests
  the new steps touch, the harness, the route code the plan adds), then the
  round-1 fixes were checked for being correct, not just present.

Bottom line: no BLOCKING or HIGH finding. One MEDIUM changes what a literal
builder does (Task 8.4b turns an existing test red and the plan does not say
how to handle it). The rest are LOW precision/docs items.

---

## 1. [MEDIUM] Task 8.4b turns an existing test red, and the plan does not name it

**What is wrong.** Task 8.4b makes every writing tour dialog show
`TOUR_CHANGED_COPY` for an `ApiError` with status 409, Mark already toured
included. The existing test
`dashboard/src/routes/tours/TourDetail.test.tsx:555-568` ("a failed PATCH keeps
the dialog open with an inline error and no outcome modal") rejects `patchTour`
with `new ApiError(409, 'illegal_status_transition', 'nope')` (`:556`) and
expects the GENERIC copy `/couldn't mark the tour as toured/i` (`:563-565`).
The test file's `ApiError` is the real class (the mock spreads `actual`,
`TourDetail.test.tsx:50-53`), so the new `instanceof ApiError && status === 409`
branch fires. On a correct implementation the alert reads "This tour changed
since the page loaded - reload and try again." and the test fails. The plan
says only "any other rejection keeps that dialog's existing copy". It never says
that this existing pin uses a 409 and has to move to a non-409 rejection, for
example `new ApiError(500, ...)`, to keep testing the generic copy. (Checked:
no other existing dialog test rejects with a 409. `:373` and `:401` go through
`runDirect` / `handleConvert`, the header alert, which this task does not touch.)

**Implication.** A literal builder hits a red existing test in the middle of
Task 8.4b, with three plausible responses:
- fix the fixture (right);
- narrow the branch to `tour_changed` only to keep the old test green. That
  breaks spec 9.2 / D14, which name `illegal_status_transition` explicitly;
- treat it as the plan's STOP-and-report case (watch item 2).

Same class as round 1's PB2 (an existing pin broken and not named), which was
accepted. Name `:555-568` in Task 8.4b: switch its rejection to a non-409, and
add the 409 case beside it.

## 2. [LOW] Task 6.1 case 12 works as written, but its activity count is ambiguous

**Walked as a concrete interleaving.** This was checked against the harness and
the planned route code (Task 6.1 GREEN; fake `reopenIf` per Task 2.4).
1. Request A: `get` returns the closed tour, `reopenTargetFor` returns ok, then
   A calls `tours.reopenIf`. The wrapper's first call flips its flag and then
   awaits `authed(app).post('/reopen')` (request B).
2. Request B: `get` still sees `closed`, because A has not written. B's
   `reopenIf` is the wrapper's second call, so it forwards to the fake. The
   fake's check passes (`status` closed, no `convertedPlacementId`, `outcome`
   and `autoClosedFrom` equal), so it writes and returns the item. B records
   the activity, clears the nag, emits, and answers 200.
3. A resumes and forwards its stale read. The fake's check
   `t.status !== 'closed'` is now true, so it returns `undefined`, the route
   takes `reopened === undefined`, and A answers 409 `tour_changed`.

Supertest gives each `request(app)` its own ephemeral server, so the nested
request cannot deadlock. The router looks `tours.reopenIf` up at call time on
the same `world.toursRepo` object, so the wrapper is honored. Result: one 200,
one 409 `tour_changed`, as the coordinator asked.

**What is ambiguous.** "Assert ... that the tour shows exactly ONE
`tour_reopened` activity event." One reopen writes the person milestone TWICE
when the unit has a landlord: tenant plus landlord (`personEvents.ts:91-106`).
Case 9 of the same file requires the landlord copy, so the unit is seeded with
one. It also writes two audit rows (`units#` and `tours#`). Counting
`world.activityEvents` gives 2 on a correct implementation; counting the
`tours#` audit row (what `GET /api/tours/:id/activity` serves) gives 1. Name the
surface: one `tours#<id>` row, or one milestone per party.

## 3. [LOW] Task 1.1's merged "RED" is green before any code changes

**What is wrong.** Task 1.1 now carries the former Task 4.1 case:
`PATCH { outcome: 'no_outcome', moveForward: false }` should return 400, with
an error containing `'move_forward, not_a_fit'`. On unchanged code
`isTourOutcome('no_outcome')` is false and the route already answers
`outcome must be one of: move_forward, not_a_fit` (`app/src/routes/tours.ts:1047-1049`).
That is the same 400 and the same text, so the case passes before anything
changes. It goes red only in the middle of the task: after the model half
(`TOUR_OUTCOMES` gains `no_outcome`, so the PATCH accepts and stores it) and
before the validator half. The plan labels it RED, not (PIN). Its own new rule
(section 0) says a pin must be labeled and that RED means "confirm it is red
for the stated reason".

**Implication.** The commit stays coherent: both halves land together, and
typecheck passes after 1.1, since the repo's `TourOutcome` is untouched until
2.1 and the route only assigns into `Record<string, unknown>`. But the case
proves nothing unless the builder runs it between the halves. Either label it
(PIN), or sequence the task: model half GREEN, then this case RED (200 and
`no_outcome` stored), then the validator switch GREEN.

## 4. [LOW] S11's handback step never says to commit the records copy

S11.4 writes `.superpowers/sdd/handback.md` (gitignored) and "the mission
records' `handback.md`", but not that the records copy is committed with
explicit paths. AGENTS.md ("Mission reasoning is version-controlled"): the
handback goes to `docs/superpowers/reviews/<date>-<branch>/` and is committed
as produced. The repo's recent plans spell this out, e.g.
`docs/superpowers/plans/2026-09-25-share-skip-fix.md:3531` ("build-handback.md
(committed); the orchestrator's own `.superpowers/sdd/handback.md` ... mirrors
it"). It is a docs-only commit after the gates, so no gate re-run is needed;
say so.

## 5. [LOW] The new docs text lags the APPROVED spec

- Task 10.1 (GLOSSARY) defines the clock start as "latest of its time,
  creation, and `lastMarkedAt`". Spec 5.3 (round 3 addition) now says the mark
  is `lastMarkedAt` when present, otherwise `updatedAt`, and that this covers
  ANY tour no person has marked yet: "a booked-ahead tour never marked toured
  is the common case". So the canonical vocabulary doc states a rule that is
  wrong for the commonest case. For example, a tour whose relay group opened
  after its date counts from that write, not from its date.
- Task 10.3 (RUNBOOK) keeps "plus 'Undated' rows last changed more than 14
  days ago". Spec 13 (round 3) now adds that no screen shows that date, so this
  part of the preview "errs safe: it may predict closes that will not happen".
  The RUNBOOK drops that qualifier and keeps an instruction the operator cannot
  carry out. Say "count every Undated row" instead.
- The plan's own constants table ("Record outcome 409") and work map ("8.4b
  outcome-dialog 409") still scope the 409 copy to one dialog, while Task 8.4b
  and spec 9.2 cover every writing dialog.

## 6. [LOW] The round-1 "stale comments" fix (PB10) is incomplete

Task 8.8 rewords the two comment blocks (`seed/history.ts` ~`:79-96`,
`seedTourTrails.test.ts` ~`:53-69`), but two more claims of the same 8-key
mirror stay false:
- `app/test/seedTourTrails.test.ts:134`: the `it` title "every generated tours#
  row type is one of the 8 dashboard TOUR_EVENT_LABELS keys";
- `app/test/seedHistory.test.ts:858-861`: "Every row type is one of the 8
  dashboard TOUR_EVENT_LABELS keys ... Pinned literal mirror ... a drift alarm".

`TOUR_EVENT_LABELS` grows to ten keys in Task 8.8. Also unnamed:
`dashboard/src/routes/tours/TourModals.tsx:1-21`, the header ("the five small
input dialogs", the error UX), which Tasks 8.4 / 8.4b make stale with a sixth
dialog and the shared 409 copy.

---

## Adjudications - contested?

None. Every PB ruling in "Plan round 1" can stand as written. The fixes were
checked for correctness:

- PB1 / PA1 (8.5 exactly-one): correct.
  - In the CTA states every kebab guard is false for `closed`
    (`TourDetail.tsx:301-321`) and `canReopen` is false when
    `convertible !== true`, so asserting "More actions" ABSENT catches a
    builder who drops the convertible gate.
  - In the convertible state the only Reopen is the `menuitem`.
  - The existing no-kebab pin (`TourDetail.test.tsx:449-457`) survives.
- PB2 / PA6: correct. `mutationCatalog.test.ts:375` is the only count pin the
  new entry moves (`:386` counts `automatic_in_scope`, and `reopenTour` is
  `workflow_only`). The firewall derives its paths from the catalog
  (`firewall.ts:189-195`) and has no count pin.
- PB3 / PA3: correct. The field is required in `TourAutoCloseDeps`, so leaving
  it out of the worker's object, which is passed to `runTourAutoClose`, or the
  dev tick's `??=` literal, typed `TourAutoCloseDeps | undefined`, is a compile
  error. The listed constructors all exist with a `{ logger }` signature (the
  roster block, `worker.ts:395-431`).
- PB4 / PA2: correct (walked in finding 2).
- PB5 / PA5: correct as an ordering. See finding 3 for the RED label.
- PB6 / PA4: present. See findings 4 and 5 for the gaps.
- PB7, PB8, PB9: correct. PB10 is partial (finding 6).
