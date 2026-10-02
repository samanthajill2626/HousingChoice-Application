# Slice report - S6 (reopen route) and S7 (listing-send tour chip)

- Date: 2026-10-02. Implementer: Claude Opus 5.5 (child of the build
  orchestrator). Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`,
  starting HEAD 764a0485 (S5 report commit).
- Sources followed: plan sections 0, 1, S6 (Task 6.1), S7 (Task 7.1); spec 7
  (all), 10.3, 12; the shipped contracts in `slices/s1-s2-report.md` section 6,
  `slices/s3-s4-report.md` section 7, `slices/s5-report.md` section 6; the
  binding corrections in `research/drift-s3-s7-routes-jobs.md` (3, 10, 11, 12,
  13 + Confirmations) and the orchestrator ruling D-h in `research/worklist.md`;
  the reference quotes in `.superpowers/sdd/research/ref-s3-s7-routes-jobs.md`.
- Scope held: exactly the four files the brief allowed (listed under "Files").
  No spec, plan or other docs edits besides this report.

## 1. Commits

| hash | task | one-liner |
|---|---|---|
| 9d50e1cb | 6.1 | feat(tours): POST /api/tours/:tourId/reopen - the only way out of closed |
| d266536d | 7.1 | feat(tours): listing-send chip counts a tour auto-closed from toured |
| (this) | records | docs(records): tour auto-close S6-S7 slice report |

Every commit: bare `git status` read first in its own call, MERGE_HEAD checked
absent (`git rev-parse --git-path MERGE_HEAD`; `.git` is a file in a
worktree), explicit paths staged, ASCII message, `Co-Authored-By: Claude Opus
5.5` trailer, committed through Bash with a heredoc. No survivor-pin commit
was needed (section 5).

Files: `app/src/routes/tours.ts`, new `app/test/toursReopenApi.test.ts`,
`app/src/lib/listingSendTour.ts`, `app/test/listingSendTour.test.ts`.

## 2. Per task: RED reason, GREEN result

Baseline before any edit: toursApi 214, listingSendTour 12 - green;
`npx eslint` on tours.ts, listingSendTour.ts, listingSendTour.test.ts exit 0
(no pre-existing lint error to name).

| task | RED (run, confirmed reason) | GREEN |
|---|---|---|
| 6.1 | 17 failed, 1 PIN passed. Every route case got Express's unmatched-route 404 (`expected 404 to be 409/400/200`, `expected 200 "OK", got 404`, the unknown-tour case `expected {} to deeply equal { error: 'tour_not_found' }`); the race case `expected undefined to be 200` (the parked reopenIf was never reached). The setups held: the real conversion returned 201 and every `autoCloseIf` closed. The auth case (403 / 401) passed on unchanged code - a PIN, as expected (the /api chain answers before any route). | toursReopenApi 18 passed |
| 7.1 | 2 failed: the auto-closed-from-toured tour `expected undefined to deeply equal { tourId: 't-auto', state: 'toured' }`; the precedence case picked the scheduled tour. The scheduled / no_show case and the not-a-fit PIN passed on unchanged code (they guard the rule's edges - mutant e). | listingSendTour 16 passed |

App test files run after Task 6.1 (the brief's list) - 6 files, 347 passed,
exit 0: toursReopenApi 18, toursApi 214, listingSendTour 12, placementConvert
19, tourRemindersApi 69, tourAutoClose 15.

After Task 7.1: toursReopenApi 18, toursApi 214, listingSendTour 16 = 248,
plus a sanity run of listingSendsApi.test.ts (16 - the only route-level test
of the chip's two callers, contacts.ts and units.ts).

Final run on the clean tree after the mutant check - 7 files, 367 passed,
exit 0: toursReopenApi 18, toursApi 214, listingSendTour 16, placementConvert
19, tourRemindersApi 69, tourAutoClose 15, listingSendsApi 16. No
`[dynamoAdmin]` line appeared in any run.

## 3. Gates run (scope: touched files + typecheck, per the brief)

- `npm run typecheck`: exit 0 after 6.1, after 7.1, and on the final
  committed state.
- `npx eslint app/src/routes/tours.ts app/test/toursReopenApi.test.ts
  app/src/lib/listingSendTour.ts app/test/listingSendTour.test.ts`: exit 0
  (also exit 0 per task on that task's files).
- ASCII: after every edit `git diff -U0 -- <file> | grep '^+' | grep -P
  '[^\x00-\x7F]'` printed nothing; the new test file has 0 non-ASCII bytes
  (`tr` check); a final scan of the added lines of `git diff -U0
  764a0485..HEAD` printed nothing. listingSendTour.ts is now fully ASCII (it
  was already). Untouched non-ASCII lines remain in tours.ts (header arrows
  :1/:5/:6/:8/:10/:11, other pre-existing comments, the relay comment above
  `router.post('/:tourId/relay'`) - the ratchet allows them. The one
  non-ASCII line this slice touched (the PATCH closed guard comment, em dash)
  is now fully ASCII.
- NOT run (outside this brief): `npm test`, `npm run smoke`, `npm run e2e`.
  Note for S11: tours.ts gained only names from modules it already imported
  (`reopenTargetFor` from `../lib/toursModel.js`,
  `clearRelayCloseNagOnReopen` from `../services/relayCloseNag.js`) - no new
  import edge for the smoke gate.

## 4. Divergences from the plan, and why

Binding corrections applied:

1. D-h / drift #3 (case 3): the converted half goes through the REAL route -
   the tenant contact (`contact-tenant-1`, tenant, searching), a landlord
   contact (`c-ll`, with a phone) and `unit-abc` (landlord `c-ll`) are seeded
   first (pattern `placementConvert.test.ts` seedTenantAndUnit), then PATCH
   toured, PATCH `{ outcome: 'move_forward', moveForward: true }`, POST
   `/api/placements/from-tour` (asserted 201). The `pending:x` half writes
   the state through `world.toursMap`. Both halves are separate `it`s.
2. Drift #13 (case 12): the `parked` flag is set BEFORE the wrapper awaits
   the second complete POST /reopen (the second request goes through the
   same wrapper); the test counts the `tours#<tourId>` `tour_reopened` row
   (exactly 1).
3. Drift #12: one auth case - POST `/api/tours/x/reopen` with the origin
   secret and no session -> 401; it also pins the 403 without the secret
   (the same two-step shape as toursApi's GET pin). A PIN by nature.
4. Drift #11: the header route list gained ONE new ASCII line (tours.ts:12,
   `->` aligned with the arrow column) - the arrow lines were not edited
   (inserted through an ASCII-only anchor). The PATCH closed-terminal
   comment: the brief named the em-dash line in the closed guard (now :1055,
   fully ASCII: "closed is terminal for PATCH; POST /:tourId/reopen is the
   only way out."), the plan named the guard's Rules block - the rules line
   was ALSO reworded (now :1044-1045, two ASCII lines) so neither comment
   still says "terminal" without "for PATCH".
5. Drift #10 (Task 7.1): all three module texts state the new rule - the
   header PRECEDENCE `toured` entry, the header "Disqualifying" sentence, and
   qualifyingState's doc comment. The test file's own header stated the same
   old rule, so it was updated too (an allowed file).

Within the plan's latitude:

6. Route code: the plan's block verbatim (insertion point after the PATCH
   handler, above the relay comment). The nag clear passes
   `current.groupThreadId`, as the brief and the plan say; the S5 report's
   suggested `reopened.groupThreadId` is equivalent (reopenIf never writes
   groupThreadId).
7. Case 7 is two `it`s (from toured, from no_show) and runs a MOVING clock:
   the status PATCH marks at MARKED (2026-09-01), the reopen runs at NOW
   (2026-09-20), so `lastMarkedAt === NOW` proves the reopen's own stamp.
   The from-toured case sends NO body at all (Express 5 leaves `req.body`
   undefined - the route's `?? {}`); every other case sends `{}`.
8. Case 10 is two `it`s; the nag is set directly on the conversation (as
   the sweep's arm would), because every tour here is closed with the fake
   `autoCloseIf` alone (no sweep side effects).
9. Tests beyond the plan's 13 cases (additive, none dropped):
   - a CONSISTENT-read case (`get` recorder sees exactly
     `[{ consistentRead: true }]`) - spec 7.3 had no other test (mutant f);
   - case 5 also pins the multi-field message order
     (`unknown field(s): status, outcome`) and the non-object body
     (`[]` -> 400 `body must be a JSON object`, mutant l);
   - case 6 also pins: the time is kept, `currentLadderId` untouched
     (`rot-1`), the stored item equals the response, the tenant contact,
     placements and pending roster actions unchanged, the reminder rows
     deep-equal (non-empty: the create's booked_too_late rungs - so a
     reopen that armed OR swept rows fails), and one info line
     `tour reopened via api` `{ tourId, to }`;
   - case 11 asserts the WHOLE bus tail after the reopen equals
     `[{ event: 'tour.updated', payload: { tourId, status: 'no_show' } }]`
     (exactly one emit; no `scheduled.updated`);
   - every refusal asserts the stored tour unchanged and no `tour_reopened`
     row; the converted cases use a DECIDED tour (outcome move_forward),
     so without the conversion check the outcome alone would reopen it.
10. Task 7.1: one PIN beyond the plan - a person-closed not-a-fit tour still
    shows no chip (only the auto-close from toured is new). The precedence
    case makes the scheduled tour NEWER, so precedence, not recency, decides.

No STOP condition was hit: no unexpected importer, no import cycle, no
contract mismatch with the S1-S5 reports or the reference quotes, no
unpredicted red in an existing test, and the harness fake needed nothing new.

## 5. Mutant check (applied with Edit, reverted with Edit; `git diff --quiet` clean after each)

| id | mutant | result |
|---|---|---|
| a | route: the body-field 400 block deleted | KILLED by the 400 case (`expected 200 to be 400`) |
| b | route: `recordTourEvent` moved ABOVE the `reopened === undefined` check | KILLED by the race case: 2 `tours#` rows for 1 |
| c | route: emit `status: 'closed'` instead of `reopened.status` | KILLED by the emit case |
| d | route: `clearRelayCloseNagOnReopen(..., \`${tourId}-other\`)` | KILLED by the own-group nag case (`NAG_AT` for undefined) |
| e | chip: `autoClosedFrom === 'toured'` -> `!== undefined` | KILLED by the scheduled / no_show case |
| f (extra) | route: read without `{ consistentRead: true }` | KILLED by the consistent-read case |
| g (extra) | route: `reopenIf(..., new Date().toISOString())` (wall clock, not the router clock) | KILLED by 5: scheduled, toured, no_show, GET + second reopen, race |
| i (extra) | route: `res.json({ tour: current })` (the pre-write read) | KILLED by 4: scheduled, toured, no_show, not-a-fit |
| l (extra) | route: `Array.isArray(body)` dropped | KILLED by the 400 case (`[]` -> 200) |
| n (extra) | route: target hardcoded to `'toured'` | KILLED by 5: scheduled, no_show, GET + second reopen, emit, race |

Totals: 10 mutants (5 required + 5 extra), 10 killed, 0 survivors. After the
last revert: tree clean, 7 files green (367), typecheck exit 0, eslint exit 0.

Not run, by construction: the chip line's `status === 'closed' &&` guard is
EQUIVALENT on every reachable state - `autoClosedFrom` exists only on a
closed tour (written by autoCloseIf, removed by reopenIf, and PATCH refuses
any change to a closed tour). Only an impossible fixture (a non-closed tour
carrying `autoClosedFrom`) could pin it; the guard stays for clarity.

## 6. Contracts the downstream slices consume (final, as committed)

### POST /api/tours/:tourId/reopen (tours.ts:1473-1517)

Auth: the /api chain (origin secret -> 403; no session -> 401; same posture
as every tour route). Body: EMPTY - no body, or `{}`. A body the global JSON
parser rejects never reaches the route (the app's generic parser error).
Checks run in this order; each refusal writes nothing and has no side effect:

| status | body (exact) | when |
|---|---|---|
| 400 | `{ "error": "body must be a JSON object" }` | the parsed body is not a plain object (e.g. `[]`) |
| 400 | `{ "error": "unknown field(s): <k1>, <k2>" }` | any key in the body (all keys, in body order, joined with `", "`) |
| 404 | `{ "error": "tour_not_found" }` | no tour with that id (consistent read) |
| 409 | `{ "error": "tour_not_closed" }` | status is not `closed` |
| 409 | `{ "error": "tour_converted" }` | `convertedPlacementId` is any string (finished, or a `pending:` claim) |
| 409 | `{ "error": "tour_reopen_unsupported" }` | closed with no candidate `autoClosedFrom` and no `not_a_fit` / `move_forward` outcome (API-only rows) |
| 409 | `{ "error": "tour_changed" }` | the conditional write lost to a concurrent change (another reopen, a conversion claim, anything that changed status / outcome / autoClosedFrom) |
| 500 | the app's error handler | a store failure other than the condition |
| 200 | `{ "tour": <TourItem> }` | reopened |

No reopen 409 carries a `detail` field (the PATCH's `tour_changed` does). The
409 order follows reopenTargetFor: not closed, then converted, then the
target, else unsupported.

The 200 `tour` is the repo's ALL_NEW item: `status` = the target -
`autoClosedFrom` when it is `scheduled` / `toured` / `no_show`, else `toured`
for a `not_a_fit` / `move_forward` outcome; `lastMarkedAt` = the router clock
(`deps.now`, wall clock in production) - the two-week auto-close clock
restarts from it; `updatedAt` = the wall clock; `outcome`, `moveForward`,
`convertible`, `autoClosedAt`, `autoClosedFrom` ABSENT; every other field
(`scheduledAt` - possibly in the past - `currentLadderId`, `groupThreadId`,
roster, `createdAt`, ...) unchanged.

Side effects, only on a 200, in order, each best-effort (never fails the
200): (1) the shared writer `recordTourEvent(..., 'tour_reopened',
'tour_reopened', 'Tour reopened')` - the tenant's and the unit landlord's
timeline pins (label `Tour reopened`, refType `tour`), then the
`units#<unitId>` and `tours#<tourId>` audit rows (payload `{ tourId }`);
(2) `clearRelayCloseNagOnReopen` on the tour's `groupThreadId` - clears a
pending close-nag only on an open relay group that is standalone or owned by
THIS tour; (3) bus `tour.updated { tourId, status: <target> }` (no
`scheduled.updated`); (4) info log `tour reopened via api` `{ tourId, to }`.
Nothing is sent, no reminder is armed or swept, no placement / roster /
tenant-status change.

Dashboard (S8): a second click after a 200 gets 409 `tour_not_closed`; every
409 maps to `TOUR_CHANGED_COPY` per the plan. The route accepts a POST with
no body, so the client may send `{}` or nothing.

### Listing-send chip (listingSendTour.ts, qualifyingState :56-66)

`toured` when status is `toured`; OR `closed` with a non-empty
`convertedPlacementId`; OR (NEW) `closed` with `autoClosedFrom === 'toured'`.
`scheduled` / `requested` as before. No signal for `canceled`, `no_show`, and
any other closed tour - a person's not-a-fit, a closed tour auto-closed from
`scheduled` or `no_show`. Precedence (toured > scheduled > requested) and the
newest-createdAt tie-break are unchanged. A REOPENED tour is classified by
its new status (reopen removes `autoClosedFrom`). Callers unchanged
(contacts.ts:1187, units.ts:989).

Anchors after S6-S7 (`app/src/routes/tours.ts`): header reopen line :12;
`reopenTargetFor` import :56; relayCloseNag import :126; PATCH
`router.patch('/:tourId'` :986, Rules line :1044-1045, closed guard comment
:1055; reopen route comment :1473, handler :1480-1517; relay comment :1519,
`router.post('/:tourId/relay'` :1544. Relative to the S3-S4 anchors: old
:12-:54 moved +1, old :55-:1042 +2, old :1043-:1468 +3, old :1469 onward +49
(the reopen block is 46 lines, its leading blank included).

## 7. Observations for the orchestrator (no action taken)

- A tour that vanished between the reopen's read and its write would answer
  409 `tour_changed`, not 404 (the route does not re-read, unlike PATCH).
  Unreachable today: no tour delete path exists (no DELETE route, no repo
  delete).
- The reopen and PATCH 409 shapes differ (`tour_changed` with vs without
  `detail`); harmless for S8, whose dialogs key on the status code.
- The TourUpdatedEvent doc (`events.ts:235`) already names this route (S5,
  drift #15) - nothing to update.
