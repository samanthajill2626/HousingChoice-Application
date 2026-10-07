# Fix wave 1 - feat/tour-list (code review r1)

Implementer: Claude Opus 5.5, 2026-10-06. Worktree `W:\tmp\tour-list`, branch
`feat/tour-list`, started at HEAD ae203afd, ended at 73bf231c (plus this
report's commit). Scope: `r1-adjudications.md` (FIX: SC-2, SC-3, SC-4, AD-1,
AD-4; tests only: SC-1, SC-5, SC-6, coverage gaps 4 and 5; FILE: AD-2, AD-3
harness fake, AD-5). Nothing REJECTed was implemented.

Every code fix ran TDD: the test written first and run RED for the finding's
reason, then the fix, GREEN, one commit. Every tests-only item was green on
write (a PIN) and, except the e2e assertion (divergence 9), was proven by ONE
hand mutant applied and restored with the Edit tool, the restore verified by
`git diff --quiet -- <file>`. DynamoDB Local was up throughout and was never
restarted, stopped or removed; every captured run was swept for
`[dynamoAdmin]`: 0 hits.

## Commits

| item | commit | message |
|---|---|---|
| AD-1 | 5d61a075 | fix(app): a cursor 400 only for the client's own start key |
| SC-2 | 87d7a34b | fix(app): tour list bounds are ISO 8601 instants with a zone |
| AD-4 | a369f2b2 | fix(app): cursor keys are capped and well-formed |
| SC-3, SC-4 | 32052e7c | fix(dashboard): All tab - the Search control in the spec's place; the invalid-range message in the list area |
| SC-1, SC-5, SC-6 | 1a37a4be | test(app): the seed pin covers the performance world; a route-level range case; two DynamoDB Local walks |
| gap 5 | 8fff4ddc | test(dashboard): a sort change while searching walks at once |
| gap 4 | 85709cab | test(e2e): the restored row is in the viewport |
| AD-2, AD-3, AD-5 | 73bf231c | docs(issues): file three review follow-ups |

## Per finding

### AD-1 - cursor 400 only for the client's own start key (5d61a075)

- Code: `app/src/routes/tours.ts` - a `ClientStartKeyRefusedError` class after
  `toTourListRow`; the route wraps the `queryListPhase` it hands to
  `listTourPage`, counts calls, and tags a ValidationException thrown by call 1
  while `opts.startKey` is defined (only call 1 can carry the client's key).
  The catch answers 400 `invalid cursor` only for the tagged error, with
  `log.warn({ name, phase: <kind> }, 'tours list: cursor start key refused')`;
  everything else rethrows (500 via the app's error handler, which logs). The
  engine (`tourListPage.ts`) and the harness delegate are untouched - the
  wrapper sits in the route and still calls `tours.queryListPhase` per call,
  so test spies apply.
- RED: case 9 `expected [] to have a length of 1 but got +0` (no WARN line on
  the 400 path); case 11 `expected 400 to be 500` (its call list
  `[{d, startKey: true}, {u, startKey: false}]` matched first, so the throw
  really came from Query 2); case 12 `expected 400 to be 500` (k-less u
  cursor).
- GREEN: toursApi.test.ts 226/226; app `tsc -p tsconfig.test.json` exit 0.
- Tests: case 9 also asserts one WARN line `{ name: 'ValidationException',
  phase: 'd' }` (no `tl9-` id in it) after the injected throw, and a second
  one after the end-to-end out-of-range rejection; new case 11 (call 1
  delegates, call 2 throws -> 500 `{ error: 'internal server error' }`, exactly
  one level-50 line `unhandled error while handling request: GET /list`, no
  WARN); new case 12 (a k-less `u` cursor, baseline 200 first, then call 1
  throws -> 500, one level-50 line, no WARN).

### SC-2 - from / to are ISO 8601 date-times with a zone (87d7a34b)

- Code: `app/src/lib/tourListQuery.ts` - `ISO_ZONED_DATE_TIME` (the
  adjudicated regex) and `boundInstant(raw)` (regex AND `Date.parse`, then the
  canonical `toISOString()`), used for `from` / `to` only; the cursor's `n`
  keeps its own canonical check.
- RED: parse case 9 `from 10/06/2026: expected { ok: true, ... } to deeply
  equal { ok: false, ... }`; route case 1 `when=range&from=10/06/2026: expected
  200 to be 400`.
- GREEN: tourListQuery 26, toursApi 226, tourListPage 14 - 266/266.

### AD-4 - cursor keys capped and well-formed (a369f2b2)

- Code: `tourListQuery.ts` - `isKeyValue` (non-empty string,
  `isWellFormed()`, at most `MAX_KEY_VALUE_BYTES = 1024` UTF-8 bytes) used by
  `isKey` for every `k` value; a `/// <reference lib="es2024.string" />`
  directive (divergence 3).
- RED: cursor case 3b `a 1,100-byte d tourId: expected { v: 1, ... } to be
  undefined`; route case 13 `tourId of length 1100: expected 200 to be 400`
  (the fake model resumed from the crafted key).
- GREEN: tourListQuery 27, toursApi 227, tourListPage 14 - 268/268; app tsc
  (both configs) exit 0.
- Tests: case 3b - a 1,100-byte d tourId, a 1,100-byte u createdAt, 600
  two-byte characters (1,200 bytes, 600 UTF-16 units), a lone surrogate in a d
  tourId and in a u createdAt (all built in code with `String.fromCharCode`;
  no `\u` escape typed), and the inclusive cap (exactly 1,024 bytes
  round-trips); route case 13 - an oversized and a lone-surrogate d key, each
  400 `invalid cursor`, `queryListPhase` never called. The key's scheduledAt is
  one no fixture row holds, so the fake's tie guard cannot be the RED's cause.

### SC-3 and SC-4 - control order; the list-area range message (32052e7c)

- Code: `AllToursView.tsx` - the Search block moved inside `.controls` between
  Tour type and Sort (wrapper `styles.control` + `styles.search`, label
  `styles.controlLabel`, input keeps `styles.searchInput`); while
  `data.status === 'idle' && rangeError !== null` the list area (after the
  count line, outside it) shows the sentence in the empty-state box
  (`rowStyles.empty` / `emptyText`); the copy under the inputs stays.
  `AllToursView.module.css` - `.search` is now `width: 360px` (the container
  query's later `.control { width: 100% }` still makes it full width at 480px
  or less), `.searchInput` dropped its `max-width`, the dead `.searchLabel`
  rule is gone, the section comments name Search.
- RED: order case `Sort after Search: expected +0 to be truthy`; list-area
  case and the amended Date range case `expected [ <p class="_rangeError_...">
  ] to have a length of 2 but got 1`.
- GREEN: AllToursView.test.tsx 64/64; the whole `src/routes/tours/` folder 19
  files, 538/538; dashboard tsc exit 0.

### SC-1 - the seed pin covers the performance world (1a37a4be, PIN)

- `seedTourPartition.test.ts` gains `performance: { tours:
  generatePerformanceSeed(resolvePerformanceSeedConfig({}, ANCHOR)).tables.tours }`
  and a per-profile non-vacuity guard (cast, matrix, performance each > 0).
- Green on write (1/1). MUTANT: `_schedPartition: 'tours',` removed from
  `buildTour` (`app/src/lib/seed/performance.ts:655`) -> red with 50
  `performance:perf-tour-000NN` rows; restored, byte-identical.

### SC-5 - a route-level when=range case (1a37a4be, PIN)

- Route case 14: rows 1 ms outside each end, both ends exactly, a middle row
  and an undated request; `when=range&from=2026-10-01T00:00:00-04:00&to=2026-10-31T23:59:59.999-04:00`
  -> one page, `nextCursor: null`, `['tl14-in3', 'tl14-in2', 'tl14-in1']`;
  `from` alone adds `tl14-after`, `to` alone adds `tl14-before`.
- Green on write. MUTANT: `boundInstant` returns the RAW bound (the route
  hands uncanonicalized bounds to the plan) -> red: `['tl14-in2', 'tl14-in1',
  'tl14-before']`; restored, byte-identical.

### SC-6 - two DynamoDB Local walks (1a37a4be, PIN)

- Engine describe (`toursRepo.integration.test.ts`): (a) `when: 'past'`,
  every status, pinned at 2028-03-01 (after all seven dated rows), `limit` 7,
  TINY constants -> ONE page, the seven ids latest first, `nextCursor: null`,
  `calls` 1, `evaluated <= returned + 1`; (b) `when: 'any'` with
  `['scheduled','toured','no_show','canceled','closed']` -> the plan's D has no
  `statusFilter`, the walk returns the dated rows then the undated toured row,
  ends null, and `expectPeekBound` holds on at least 3 unfiltered-D pages.
- Green on write (the describe 5/5). MUTANT A: the peek row dropped
  (`needed + 1` -> `needed`, `tourListPage.ts:96`) -> (a) red `expected { v: 1,
  ... } to be null` (a phantom cursor). MUTANT B: D always filtered
  (`planTourListPhases`) -> (b) red `expected { kind: 'd', ... } to not have
  property "statusFilter"`. Both restored, byte-identical.

### Coverage gap 5 - a sort change while searching (8fff4ddc, PIN)

- One AllToursView case mirroring the When case's fake-timer idiom: a
  keystroke, then Sort -> Earliest first within 300 ms -> `call(1)` is `{ when:
  'any', sort: 'earliest' }` and the walk from `e-c1` (limit 100) follows at
  once.
- Green on write. MUTANT: the Sort select calls `setChosen` directly instead
  of `change()` -> red `expected [ { limit: 50 }, { limit: 50 } ] to strictly
  equal [ ..., { cursor: 'e-c1', limit: 100 } ]`; restored, byte-identical.
  GREEN 65/65.

### Coverage gap 4 - the restored row in the viewport (85709cab, PIN)

- `tours-all.spec.ts` test 3: `await expect(all.link(noShowId)).toBeInViewport()`
  right after `toBeFocused()` (still assertions only, so the anchor's
  user-intent guard is not tripped).
- Single-spec e2e: everything else committed first (only the spec dirty);
  `npm run e2e:session` in the background, log
  `.superpowers/sdd/fixwave-e2e-session.log`, ready on LANE 8 (app :9801, web
  :9811, fake-twilio :9821); `npm run e2e -w @housingchoice/e2e --
  tests/dashboard-next/tours-all.spec.ts` (log
  `.superpowers/sdd/fixwave-tours-all.log`): exit 0, "reusing the live
  e2e:session on lane 8", **5 passed (7.8s)**.
- Lane stopped: `npm run e2e:stop` exit 0 ("stopped session launcher 3868 (+
  children)", "dropped lane 8 tables", "released lane 8 lease");
  `e2e/.artifacts/session.pid` absent (Test-Path False); no TCP listener on
  9801 / 9811 / 9821 / 9831 (Get-NetTCPConnection). The background launcher
  then reported exit 1 - the expected result of being stopped.

### AD-2, AD-3 (harness fake), AD-5 - filed (73bf231c)

- `docs/issues/tours-date-range-reads-unbounded-span.md` (debt, low).
- `docs/issues/harness-date-range-fake-ignores-sched-partition.md` (debt,
  low) - records design review R1-2's rejection of PATCH stamping and why,
  and that the plan-blind reviewer re-derived it.
- `docs/issues/tour-list-restore-anchor-trackpad-swipe.md` (bug, low,
  plausible) - the probe and the candidate fix.
- All three print 0 non-ASCII bytes. `npm run issues`: exit 0, "372 open, 196
  closed, 568 total", no warning lines. INDEX.md is gitignored and was not
  added.

## Final gates (after the last code commit)

- `npm run typecheck`: exit 0, all five workspaces.
- `npx eslint` on the nine code files the wave touched (`git diff --name-only
  --diff-filter=d ae203afd..HEAD` filtered to .ts/.tsx): exit 0, no output -
  none of the known pre-existing errors live in these files, and no new one.
  The CSS and Markdown files are outside eslint's config.
- Touched test files, final run: app - tourListQuery 27, tourListPage 14,
  tourListIndexFakeMirror 8, seedTourPartition 1, toursRepo.integration 79,
  toursApi 228 (357/357); dashboard - AllToursView.test.tsx 65/65.
- ASCII: the added-lines check printed 0 before every commit.
- Not run, per the brief: full `npm test`, full `npm run e2e`, `npm run
  smoke`.

## Divergences from the adjudication and the brief, and why

1. Commit 6 is TWO commits (8fff4ddc dashboard, 85709cab e2e): the brief's
   e2e step requires everything but the spec committed before the run and the
   spec committed after green, which one combined commit cannot satisfy.
2. AD-1 narrows spec 5.5's literal sentence ("A DynamoDB ValidationException
   on a request that CARRIED a cursor is answered 400 invalid cursor") to the
   adjudicated rule (only Query 1 with the client's key). Consistent with the
   sentence's own rationale ("a defect in the query, not the client's input")
   and the route's old comment; spec 5.5 and the section-9 bullet ("400 with a
   cursor, 500 without") were NOT edited here - the orchestrator may want to
   amend them in place.
3. AD-4: `String.prototype.isWellFormed` is ES2024 and the app compiles
   against ES2023 (TS2550 measured on a scratch file without it), so
   `tourListQuery.ts` carries `/// <reference lib="es2024.string" />`;
   production runs Node 24 (Dockerfile `node:24-slim`, engines `>=24`), where
   the method exists.
4. Small additions inside the adjudicated items: SC-2 also rejects the
   zone-less date-times `2026-10-06T00:00:00` / `...00.000` (the finding's
   core case) and accepts a no-seconds `...T12:30Z`; AD-4 also tests a u key,
   bytes-not-characters and the inclusive cap; SC-1 replaced the global
   `seen > 0` with a per-profile guard; SC-6 (b) also asserts the plan's D
   has no `statusFilter` and the walk's ids.
5. SC-6 (a) pins at 2028-03-01, not the describe's PINNED (2026-10-06): every
   fixture row is dated 2028, so `past` at PINNED would read nothing. It uses
   TINY (a 1-Query budget), which makes "one page" stronger, not weaker.
6. SC-3: the search's label now uses the row's `.controlLabel`; the old
   `.searchLabel` rule (unused afterwards) was deleted rather than left dead.
7. SC-4: the list-area message reuses the empty-state box; the existing Date
   range case was amended to expect the sentence twice (it used `getByText`,
   which throws on two matches).
8. AD-1's new cases are numbered 11 and 12 and AD-4's route case 13, SC-5's
   14, continuing the describe's numbering.
9. Gap 4's `toBeInViewport` was NOT mutant-proven: in this fixture the
   restored row sits near the top of a short filtered list, so no product
   mutant (for example dropping `scrollIntoView`, as the view focuses with
   `preventScroll`) can move it out of view, and a test-side mutant (shrinking
   the viewport) would only test Playwright. The scroll call stays pinned by
   the unit test's `scrollIntoView` spy.

## Notes for Cameron (from the adjudication)

- AD-3: a plan-blind reviewer re-derived the PATCH-stamping proposal that
  design review R1-2 rejected; rejected again, recorded in the harness issue.
- AD-4: whether AWS itself answers a crafted key with a ValidationException
  is unprobed; the hosted-dev probe stays Cameron's call (the decoder now
  refuses such keys first).
- AD-5: filed as plausible; a real macOS Chrome trace decides it.

## Left undone

- Nothing in the wave's scope.
- Next per the adjudication: a FRESH re-reviewer on the fix diff
  (ae203afd..HEAD), the affected gates, the main sync and the full battery.
