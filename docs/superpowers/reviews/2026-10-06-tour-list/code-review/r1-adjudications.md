# Code review r1 - orchestrator adjudications (feat/tour-list @ 38695b70)

Reports: `r1-spec-conformance.md` (109 items: 83 CONFORMS, 19 DEVIATES-RULED,
5 PARTIAL, 2 DEVIATES-UNRULED, 0 MISSING; findings SC-1..SC-6) and
`r1-adversarial.md` (plan-blind; AD-1..AD-5). Gates at 38695b70 before the
fix wave: typecheck 0, npm test 0 (all five workspaces), smoke 0, e2e 0 (314
passed, 17.2 min), eslint 0 new rows versus the merge base.

FIX = goes into fix wave 1; FILE = a docs/issues entry, not this branch's
code; REJECT = no change, reason given; NOTE = handback only.

## Spec-conformance findings

- SC-1 [MEDIUM] seed pin omits the performance world - FIX (confirmed: the
  world builds purely via `generatePerformanceSeed(resolvePerformanceSeedConfig(...))`
  as `seedUnreadFlag.test.ts` already does; slice A's "cannot see it" was
  wrong). One more `PROFILES` entry in `seedTourPartition.test.ts`.
- SC-2 [LOW] `from`/`to` accept any `Date.parse` form, zone-less forms read in
  the server's zone - FIX (spec 5.1 says ISO 8601 instants; the 400 text
  already says so). Require an ISO 8601 date-time with an explicit zone
  before `Date.parse`; a parse unit case and a route validation row.
- SC-3 [LOW] the Search control renders after Sort and Clear filters - FIX
  (spec 4.3 "Labels, roles and order" is explicit and was approved at the
  gate; no ruling moved it). Move the Search block between Tour type and
  Sort; pin the DOM order of the controls in a test.
- SC-4 [LOW] an invalid date range leaves the list area blank - FIX (spec
  4.3 "the list area keeps that message until fixed"; slice G's divergence 7
  had no ruling). Render the sentence in the list area while the hook is
  idle, outside the count region; test.
- SC-5 [LOW] no route-level `when=range` case - FIX (tests only): one route
  case with offset-form bounds, both one-sided forms.
- SC-6 [LOW] two spec-9 DynamoDB Local bullets run on the fake only - FIX
  (tests only): a `when: 'past'` unfiltered final-phase walk ending
  `nextCursor: null` on one page, and an every-dated-status walk asserting
  `evaluated <= returned + 1`.
- Coverage gap 4 (e2e asserts focus, not viewport) - FIX (tests only):
  `toBeInViewport()` on the focused row in `tours-all.spec.ts` test 3.
- Coverage gap 5 (sort change while searching) - FIX (tests only): one view
  case mirroring the When-change case.

## Adversarial findings

- AD-1 [LOW] the cursor-400 mapping is per request, so a ValidationException
  from Query 2..6 (never caused by the client's key) is answered 400 with no
  log line - FIX (proven by the reviewer's throwaway test; the route's own
  comment promises the distinction). Map to 400 only when the throw came
  from the FIRST Query and that Query carried the client's start key; log a
  WARN with the error name and phase kind on the 400 path; everything else
  rethrows (500 + the app's error log). Regression test: a throw on call 2
  -> 500 and one error line; route test 9 stays green.
- AD-2 [LOW] the paged date-range read has no span bound on client windows
  (`GET /api/tours?from&to`, `GET /api/today?toursFrom&toursTo`), and
  from > to on `GET /api/tours` is a pre-existing 500 - FILE
  (`tours-date-range-reads-unbounded-span`, debt, low). Spec D6 and section 7
  keep the two callers unchanged; `?status=` already walks a whole partition,
  so this is not a new class; the dashboard sends 1-, 30- and 90-day windows.
  Not this feature's change to make.
- AD-3 [LOW] `_schedPartition` is stamped at create only; PATCH never writes
  it; the harness `listByScheduledRange` fake admits unstamped rows while the
  All-tab fake requires the stamp - REJECT the PATCH stamping (design review
  R1-2 rejected exactly this with evidence - every production row is written
  by the repo's create, which has stamped every tour since its first commit;
  tours are never imported; the seeds were the only gap and S2 fixed them -
  and the reviewer who raised it conceded). A plan-blind reviewer re-deriving
  the same proposal is noted for Cameron in the handback. The harness-fake
  divergence is inert (every writer stamps) and pre-existing - FILE
  (`harness-date-range-fake-ignores-sched-partition`, debt, low).
- AD-4 [PLAUSIBLE] AWS may refuse an oversized or ill-formed crafted cursor
  key with an error not named ValidationException (a 500) - FIX the cheap
  half: `decodeTourListCursor` caps every key value (1024 bytes) and requires
  well-formed strings (`String.prototype.isWellFormed`), so a crafted key is a
  400 whatever AWS answers; unit cases. The hosted-dev probe is Cameron's
  call - NOTE in the handback.
- AD-5 [PLAUSIBLE] a macOS trackpad swipe-back may deliver momentum `wheel`
  events after mount and cancel its own return anchor - FILE
  (`tour-list-restore-anchor-trackpad-swipe`, bug, low) with the probe the
  reviewer proposes; the spec names `wheel` as a user-intent event and a
  change on a hypothesis is not warranted. NOTE for Cameron.

## Fix wave 1 scope (one fresh implementer)

Code: SC-2, SC-3, SC-4, AD-1, AD-4. Tests only: SC-1, SC-5, SC-6, coverage
gaps 4 and 5. Issues: AD-2, AD-3 (harness fake), AD-5. Then a FRESH
re-reviewer on the fix diff, then the affected gates, then the main sync and
the full battery.
