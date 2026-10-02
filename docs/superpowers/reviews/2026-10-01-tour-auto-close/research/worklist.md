# Research worklist - orchestrator merge and adjudications

- Date: 2026-10-02 (research ran 2026-10-01 23:38 - 2026-10-02 00:06).
- Four parallel read-only readers checked plan v4 against the live tree
  (HEAD f319a306; code == main @ae04122d). Their findings are the four
  `drift-*.md` files beside this one; byte-exact reference quotes are under
  `.superpowers/sdd/research/ref-*.md` (gitignored run state).
- Totals: 51 plan corrections (5 + 15 + 18 + 13), 0 STOP findings, 12 spec
  flags. No correction changes a design decision; the spec stays the contract.
- Each implementer brief points at its slice's drift file; this file holds the
  decisions the drift files left to the orchestrator and the spec-flag rulings.

## 1. Spec-flag rulings (decisions taken alone; Cameron asleep)

| # | flag (drift file) | ruling |
|---|---|---|
| F1 | Spec 5.3 / round-3 headline "background jobs only read tours" is false: the worker's roster-action poll writes `groupThreadId` / `roster` / `updatedAt` when it applies a person-confirmed deferred group open (s1-s2 #13, s3-s7 R1) | ACCEPT as a TEXT correction. The clock conclusion holds (one write per person-confirmed action; postpone-only; never status / outcome / date). S10 corrects spec 5.3 and the section 12 writer list (adds the roster-actions poll and the conversion claim / release at `placements.ts:716/:750/:778`), and the new Tier-2 race issue names all three open paths (POST /:tourId/relay, apply-now, the worker poll / dev roster tick). No build change. |
| F2 | Reopen racing a conversion on a closed, unconverted, `convertible: true` tour (API-only state): conversion claims with no status / convertible condition, so a reopen landing between its read and its claim is silently overridden; end state coherent (s1-s2 #15, s3-s7 R2) | DEFER: one paragraph in the new race issue (suggested fix `AND #cv = :true` on `claimConversion`). Same class as today's PATCH `{moveForward:false}` racing a conversion. No build change. |
| F3 | Spec 7.4's owner test reads `conversation.owner` literally, so a group with only the legacy `placementId` back-reference and no `owner` counts as "owner absent" and gets its nag cleared (s3-s7 R3) | ACCEPT with a build refinement that honors the spec's intent (never clear another owner's nag): the helper resolves the owner through the repo's own `getOwner(conv)` when that function is exported (`conversationsRepo.ts:385-400`); if it is a method rather than an export, inline the same legacy mapping. Test adds one case: legacy `placementId` only -> NOT cleared. |
| F4 | Spec 8.4 stamps `lastMarkedAt` on ANY patch carrying `status`, so an API-only same-status restatement (`{status:'toured'}` on a toured tour, legal today) restarts the two-week clock (s1-s2 #16, s3-s7 R4) | ACCEPT as a refinement in the spec's own words: 5.2 defines the mark as "the latest instant a PERSON CHANGED the tour's status or time" and 11 says "stamps on status / time changes". S4 stamps when `patch.status` is present AND differs from `currentStatus`, OR `patch.scheduledAt` is present. Booking / revival auto-advance (requested -> scheduled) is a real change and still stamps. Test adds: a same-status restatement leaves `lastMarkedAt` unchanged. Recorded for Cameron in the handback. |
| F5 | Spec 12's seed note names only the matrix's two no-shows; the matrix's two scheduled tours (+17d / +19d) and live.ts's three tours (+14d - +16d; two own the live relay group) would also auto-close after a full reseed if a worker runs (s1-s2 #17, s9-s10 3c) | ACCEPT as TEXT: S10 corrects spec 12's bullet; the RUNBOOK entry and the handback must not repeat "two no-shows". No seed change (spec D10). |
| F6 | `useTour` refetches on `tour.updated` through an eventually consistent GET, so the page can briefly repaint the pre-reopen row (s8 risk 1) | PRE-EXISTING for every PATCH; e2e assertions rely on Playwright's auto-retry. No change. Handback line. |
| F7 | Header-alert direct actions (Mark toured CTA, Mark no-show kebab) still show the raw `ApiError.message` on a 409; D14 covers dialogs only (s8 risk 2) | Spec 8.3 accepts. Handback line ("not blocking, your eye"). |
| F8 | Seed-trail label (`seed/history.ts:800-813`) would label `no_outcome` as "not a fit"; unreachable, no seed writes it (s1-s2 #18) | Note only. |
| F9 | Closed-tab link `aria-label` replaces the content name, so the outcome badge is never part of the link's accessible name (s8 risk 4) | Test guidance only: unit and e2e find the badge by text inside the row. |
| F10 | The converted Closed fixture (move_forward) newly shows a "Move forward" badge (s8 risk 5) | Spec 9.3 says "a closed tour with an outcome" - intended. The "no badge" case uses the canceled fixture. |
| F11 | A closed tour with a `pending:` claim renders "View placement" to `/placements/pending:x` (s8 risk 6) | Pre-existing, out of scope. Handback line. |
| F12 | Worker block has no automated coverage; the lane's real worker ticks the sweep 15 min into a run with nothing due (s3-s7 R5, s9-s10 2) | Accepted (typecheck + the dev tick test cover the job; the e2e proves the seam). Self-QA runs the real worker on a lane for the "nothing due" case only. |

## 2. Orchestrator decisions on choices the drift files left open

- D-a Task 1.1: DROP the pre-existing unused `type TourOutcome` import at
  `routes/tours.ts:58` in the same import-statement edit (the statement is a
  touched line; gate 5 ratchets touched lines). Also drop `isTourOutcome` /
  `TOUR_OUTCOMES` (their only use is the validator being switched).
- D-b Task 2.2 parity tests: keep the plan's two-file form (integration file +
  new `toursRepoFakeConditions.test.ts`), not the single-script parity idiom.
- D-c Task 3.2: `TourEventDeps` re-declares `activityEvents` as REQUIRED
  (`Pick<ActivityEventsRepo, 'record'>`), so no caller can silently drop both
  timeline pins (PA3 spirit; all three callers always have it).
- D-d Task 4.2 wrappers: forward `opts` at `toursApi.test.ts:2044` and `:2122`
  (the two that reach the staff PATCH); leave `:2242` as a zero-argument stub
  (three unused params = three new lint errors); `:3302`, `placementConvert
  .test.ts:307` / `:782` may stay as they are. Install the wrapper / spy only
  AFTER the create resolves (POST /api/tours calls `tours.patch` itself).
- D-e Task 5.1: type the helper's deps as
  `{ conversationsRepo: Pick<ConversationsRepo, 'getById' | 'setCloseNagNextAt'>; logger?: Logger }`;
  new test file `app/test/relayCloseNagClear.test.ts`; owner resolution per F3.
- D-f Task 5.2: use `world.events` / `world.emitted` from `createFakeWorld()`
  rather than a fresh bus. The CLOCK TRAP is mandatory: both `create`s overwrite
  `updatedAt` with the wall clock; set `world.toursMap.get(id)!.updatedAt` (or
  `lastMarkedAt`) after every setup write.
- D-g Task 5.4: model the tick test on `devGating.test.ts:477-516` / `:851-879`
  (world-fake deps), not on the journal-sweep test.
- D-h Task 6.1 case 3: seed the tenant contact and `unit-abc` (pattern
  `placementConvert.test.ts:43-57`) and convert through the REAL route; the
  `pending:x` half goes through `world.toursMap`. Add the 401 auth case (#12)
  and set the parking flag BEFORE awaiting in case 12 (#13).
- D-i Task 8.4 / 8.4b: page-level in `TourDetail.test.tsx` (no
  `TourModals.test.tsx` exists); add the VALUE import `ApiError` to
  `TourModals.tsx`.
- D-j Task 8.5: render "Closed automatically on <date>" as ONE element
  (`<p className={styles.subtle}>`), midday-UTC `autoClosedAt` fixtures; add
  `reopenTour` to the barrel mock.
- D-k Task 8.7: keep the cap pin ("caps Today at five rows") in its own
  describe; drop the `selectTodayPastTours` import; flip
  `useTodayPastTours.test.tsx:90`; drop the unused `useMemo` import.
- D-l Task 9.x: run one spec ONLY as
  `npm run e2e -w @housingchoice/e2e -- tests/dashboard-next/<file>.spec.ts`
  (single hop; the root form eats `--grep` and runs the whole suite).
- D-m Task 10.2: `status: resolved` + `resolved: <run day>` frontmatter and a
  `**Resolution (<date>, feat/tour-auto-close).**` paragraph; the new issue's
  `created:` is the run day (2026-10-02). RUNBOOK entry goes under
  `## Daily operations` immediately before `### Tour reminder supersession`.
- D-n S10 also lands the spec TEXT corrections of F1 and F5 (sections 5.3 and
  12) as a separate docs commit, recorded as an adjudication here.

## 3. Slice -> drift file map (implementer briefs cite these)

| slice | drift file | sections |
|---|---|---|
| S1, S2 | drift-s1-s2-model-repo.md | A (1-5), B (6-12), E |
| S3, S4, S5, S6, S7 | drift-s3-s7-routes-jobs.md | corrections 1-15, Confirmations |
| S8 | drift-s8-dashboard.md | corrections 1-18, section 2, section 5 |
| S9, S10, Task 8.8 seed comments | drift-s9-s10-e2e-docs.md | corrections 1-13, sections 2-3 |
