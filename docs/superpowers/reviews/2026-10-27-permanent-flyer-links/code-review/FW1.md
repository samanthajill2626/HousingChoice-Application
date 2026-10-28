# Fix wave 1 - permanent flyer links (code review R1)

Fix-wave child report. Worktree `W:\tmp\permanent-flyer-links`, branch
`feat/permanent-flyer-links`, started at 704d5828 (main 71fb9b45 already
merged in; nothing merged or rebased here). Scope: the FW1 list in
`R1-adjudications.md` (C-1, C-2, C-3, C-4a, C-4b, C-4c, A-2 doc line, A-5
filing, A-6 server test, A-8c). Nothing marked REJECT or LEAVE was touched.
No runtime code changed: every source edit is a comment. Line numbers below
are at 8eebb336.

## Commits

| Hash | Subject |
|---|---|
| 81a7bfd2 | test(public): pin the flyer payload's key set off Available and the unitId cap at 200 |
| 8eebb336 | docs: permanent flyer links fix wave 1 - stale old-rule lines, issue refs, a filed issue |
| (this report) | docs(records): permanent flyer links - fix wave 1 report |

Before each commit: bare `git status` (only my files, nothing staged by
anyone else, HEAD unmoved), the MERGE_HEAD check printed nothing, explicit
paths staged, the added-line ASCII check printed nothing (grep exit 1), the
commit message grepped clean, and the Co-Authored-By trailer.

## Per item

1. C-1 - DONE.
   - `e2e/support/selectors.md:145` (Priority switch row): check the
     no-Priority absence "on a SERVED flyer, any status but Setup (a Setup,
     deleted or missing property shows the fallback page, where an absence
     proves nothing; a new property starts in Setup, so the spec makes it
     Available first)". The rest of the row is byte-unchanged.
   - `e2e/tests/dashboard-next/property-priority.spec.ts:142-145`: "publish
     (the flyer serves every status but Setup, where a new property starts;
     Available is the plain case)". Comment only.
   - Sweeps: see "Sweeps" below.
2. C-2 - DONE (`app/test/publicIntake.test.ts:539-588`).
   - `PUBLIC_FLYER_KEYS` (:540-561): the 16 served keys written out, sorted.
   - Every one of the six rows now asserts `Object.keys(res.body)` is
     exactly `['flyer']` (:571) and the sorted flyer key set equals
     `PUBLIC_FLYER_KEYS` (:572), so the key set is identical for every
     public status.
   - The five non-Available rows also assert that
     `JSON.stringify(res.body).toLowerCase()` contains neither the raw status
     (:580) nor `LISTING_STATUS_LABELS[status].toLowerCase()` (:581). The
     Available row keeps the existing case-sensitive raw check (:575).
   - The it.each list is `as const`, so the label lookup is typed without a
     cast. RED evidence is below.
3. C-3 - DONE. `app/test/publicIntake.test.ts:640` now reads "for a unit in
   status %s"; `app/test/publicSignupLeads.test.ts:306` reads "a flyer for a
   property in status %s". The verbose run shows, for example, "stamps
   capture_source:flyer + unit_of_interest for a unit in status occupied
   (permanent-flyer-links D5)".
4. C-4a - DONE. Comments only. The rule (never move a seeded unit) stays;
   the stale reason is replaced by "every spec shares the lean seed, and
   public-pages.spec.ts reads its served flyer":
   - `broadcasts.spec.ts:85-87`, :135-139, :354-357;
   - `matching-entry-points.spec.ts:22-23`, :59-61.
   - At :135-136 "it is under_application" became "the lean seed makes it
     under_application", because its status follows placement-0001, which
     other specs move (R4-1).
5. C-4b - DONE. `app/src/repos/unitsRepo.ts:477-479`: "The EXTERNAL listing
   URL (the home's public listing elsewhere - not the flyer link). Shown on
   the public flyer only while the property is Available
   (permanent-flyer-links D3a)."
6. C-4c + A-2 - DONE, plus one named extension.
   - `docs/issues/public-signup-abuse-hardening.md`: every public.ts
     citation is refreshed to the live line, in `refs:` and in the body:
     - six refs: :690-747 became :710-767; :198-211 -> :209-226;
       :253-260 -> :268-275; :760-777 -> :781-798; :541-578 -> :560-597;
       :637 -> :656.
     - sixteen body sites. They are named by symbol where one exists:
       `signupPinLabel`, `parseHousingFairBody`, `markSignupUnread`,
       `applyFlyerShareEntry`, and the handler's step labels - the deleted
       path (1a), the repeat check (3a), the pin and bump (3b), the ledger
       write (3c).
   - One sentence closes point (d): imported properties' unitIds are uuidv5
     of the normalized address (`unitIdForAddress`, `ids.ts:84-86`), so
     anyone holding the namespace can compute a public unitId from an
     address. Such ids count as known ids for (c) and (d).
   - `status`, `severity` and `updated:` are unchanged.
   - Every cited line was checked against the committed tree with
     `git show 8eebb336:app/src/routes/public.ts`.
   - Extension 1: `app/test/publicSignupLeads.test.ts:750-761` is now
     `:840-851`, in `refs:` and in the body. This branch's S1 additions
     shifted it - the same defect class in the same file.
   - Extension 2: `app/src/lib/import/ids.ts:84-86` is added to `refs:` for
     the new sentence.
   - Left as is: the `public.ts:376-411` citation at :22, which is pinned to
     main at 0f6f29f9 (historical).
7. A-5 - DONE. New `docs/issues/broadcast-send-refusal-deleted-unit-copy.md`
   (type bug, severity low, status open, area dashboard, created
   2026-10-28).
   - It states:
     - the refusal path (`broadcasts.ts:1187-1193`);
     - that the pre-flight reads status only (`RecipientPreview.tsx`
       `onSend`, :374-397), and `GET /api/units/:id` returns deleted units
       with their status (`units.ts:1025-1038`);
     - the misleading copy (:420);
     - how it is reached: a property deleted after the composer opened it.
       The composer's own list excludes deleted properties
       (`units.ts:884-887`);
     - that it is PRE-EXISTING, quoting main's copy.
   - One "not checked" line: the Make Available dialog's path for a
     property deleted while NOT Available.
   - Suggested fix: the reviewer's (a distinct code, or a `deleted_at`
     pre-flight check).
   - Not fixed. `npm run issues` exit 0 and lists it.
8. A-6 - DONE (`app/test/publicIntake.test.ts:725-763`). These sit inside
   the "flyer attribution (optional unitId)" describe, after the non-string
   unitId test.
   - A comment cites both caps (public.ts and FlyerPage.tsx
     `MAX_UNIT_ID_LEN`), parseHousingFairBody and app.ts trimJsonBody. It
     says that a change to either cap must change both.
   - it.each (:735-751): a unitId of exactly 200 characters, and of 200
     characters inside two spaces each side. Each gets 200 `{ ok: true }`,
     and the new contact has `capture_source: 'flyer'` and
     `unit_of_interest` equal to the 200-character id. An Available unit is
     seeded under that id, so the id must arrive whole and trimmed.
   - :753-763: a unitId of 201 characters gets 400 `{ error: 'invalid
     request' }`, with no contact and no send.
   - One request per bare harness, so the rate limit is never reached.
9. A-8c - DONE. Comments only.
   - The `app/src/routes/public.ts:56-58` file-header route list now reads
     "(missing/deleted/setup, or a stored status outside the listing
     statuses; ...)". This edit added one line, so every public.ts line
     below :57 moved +1 against the reviews' numbers. Item 6 cites the
     final tree.
   - The `dashboard/src/routes/public/publicApi.ts:5-9` header now reads
     "missing, deleted, in Setup, or holds a stored status outside the
     listing statuses - one body for all four".

## RED evidence (no in-place edit)

Method: the R1-conformance section 2 harness.
- A scratchpad vitest config outside the repo (`scratchpad\fw1\fw1-mutant.config.mjs`)
  spreads `app/vitest.config.ts` and sets `root` to the app.
- It adds one `enforce: 'pre'` transform plugin. The plugin rewrites ONE
  module in memory and throws if its pattern is missing.
- Each run's log carries the marker `[fw1-mutant] <name> APPLIED to
  W:/tmp/permanent-flyer-links/app/src/routes/public.ts` (`app.ts` for
  notrim).
- No repo file was edited or created for any mutant.
- Each run used publicIntake + publicSignupLeads. Logs:
  `.superpowers/sdd/logs/FW1-<mutant>-head.log` / `-new.log` (gitignored).

| Mutant | Old tests (704d5828) | FW1 tests | Red line |
|---|---|---|---|
| m16: `badge: LISTING_STATUS_LABELS[status]` added to the payload only off Available (R1-conformance M16) | 152/152 PASS (survived) | 5 failed, 150 passed | :572 `expected [ 'accepted_authorities', ...(16) ] to deeply equal [ 'accepted_authorities', ...(15) ]`, diff `+ "badge"` - the five non-Available rows |
| m16key: `open: false` off Available (no status word in it) | not run; survives by reading (no key check off Available) | 5 failed | :572, diff `+ "open"` |
| m16val: the label appended to `area`'s value off Available (key set unchanged) | not run; survives by reading (the case-sensitive raw check misses "Occupied", "Under application") | 5 failed | :580 `expected '{"flyer":{"unitid":"unit-1",...' not to contain 'occupied'` (also finalizing); :581 `... not to contain 'under application'` (also 'on hold', 'off market') |
| m16top: a top-level `open: false` beside `flyer` off Available | not run | 5 failed | :571 `expected [ 'flyer', 'open' ] to deeply equal [ 'flyer' ]` |
| cap64: `MAX_UNIT_ID_LEN = 64` (R1-adversarial A-6) | 152/152 PASS (survived) | 2 failed, 153 passed | :746 `expected 400 to be 200` - both accepts rows |
| cap201: `MAX_UNIT_ID_LEN = 201` | not run (no 201 test existed) | 1 failed | :759 `expected 200 to be 400` |
| notrim: `app.use(trimJsonBody())` removed | not run; by reading, two existing housingAuthority trim tests kill it | 3 failed | :746 (the padded unitId row), plus the pre-existing :1069 and :1318 trim tests |

Each new assertion fails alone on a mutant aimed at it:
- the key set (:572): m16, m16key;
- the top-level keys (:571): m16top;
- the lowercase raw status (:580): m16val on finalizing and occupied;
- the lowercase label (:581): m16val on the other three;
- the accepts rows (:746): cap64, notrim;
- the refusal (:759): cap201.

## Test counts and gates

| Check | Result |
|---|---|
| app publicIntake + publicSignupLeads at 704d5828 (baseline) | 71 + 81 = 152 passed, EXIT=0 |
| same two files, final tree | 74 + 81 = 155 passed, EXIT=0, no `[dynamoAdmin]` line |
| dashboard publicApi.test.ts + FlyerPage.test.tsx (the publicApi.ts comment) | 9 + 75 = 84 passed, EXIT=0 |
| root `npm run typecheck` | EXIT=0, all five workspaces. Run twice: before commit 1, and after the last comment edit |
| `npx eslint` on the 8 touched .ts files | EXIT=0, no output; no pre-existing errors in these files |
| `npm run issues` | EXIT=0, "452 open, 215 closed, 667 total"; the new issue is listed |
| ASCII, added lines + the new issue file + both messages | clean (grep exit 1) |
| `npm test`, smoke, e2e | not run (rules); no e2e ran at any point |

## Sweeps

Paths for (a) and (b) are WL-35's set plus `e2e/tests` (WL-42). Hits are
compared by file and text, with line numbers stripped, at three points:
26b4013b (the pre-merge tip, settled by S4 and S5), 704d5828 (after the
sync) and the final tree. Lists: `.superpowers/sdd/logs/FW1-sweep*.txt`.

- (a) `shareable|no longer available|flyer link`: 127 hits at 26b4013b,
  127 at 704d5828 (the sync brought none), 129 final.
  - FW1 removed one: unitsRepo's `Public flyer link.`.
  - FW1 added three, all LEAVE:
    - `unitsRepo.ts:478`: URL-sense "flyer link" inside the D3a note;
    - `broadcast-send-refusal-deleted-unit-copy.md:32`: a dated quote of
      main's pre-branch copy;
    - the same file's :14: the `SHAREABLE_STATUSES` identifier.
  - The other 126 are the S4/S5 LEAVE lists, unchanged.
- (b) `unavailable|non-available|not public yet|flyer link is dead|only
  resolves while|only works while|equally dead`: 913 at 26b4013b, 914 at
  704d5828, 913 final.
  - The sync brought exactly one hit, `selectors.md:145` "unavailable
    page" - C-1, now gone. So the conformance reviewer's "regex (a)" for
    this hit was regex (b).
  - FW1 reworded `broadcasts.spec.ts:355`, whose "non-available unit" is in
    the broadcast sense: true, LEAVE, as S5 settled it.
- (c) wrap-tolerant `answers only|only for an available|only while
  .*available|goes live when|unavailable page` over app, dashboard, e2e,
  documentation, docs/issues and scripts: 8 at 704d5828, 7 final.
  `property-priority.spec.ts:142` is gone. The remaining 7, all LEAVE:
  - `public.ts:55` and `publicIntake.test.ts:564`: D3a (the listing link
    only while Available), true;
  - `ListingDetail.test.tsx:207`, :216: the retired D7 copy inside an
    absence assertion;
  - `manual-retry-double-send-residual-windows.md:162`: unrelated
    ("answers only SendRefusedError");
  - `selectors.md:145` and :163: regex artifacts. The greedy `.*` spans one
    long table row, from "ONLY while on" (the Priority pill) or "only while
    a name is selected" (the composer filter) to a later, unrelated
    "Available": on :145 that is the new rule's "makes it Available first",
    and on :163 the send rule.
- Extra true-multiline ripgrep searches, excluding docs/superpowers:
  - `only(\s|//|\*|#)+(for|while|when|if)(\s|//|\*|#)+(an?...)?(available|shareable)`
    finds 1 hit, `publicIntake.test.ts:564` (D3a).
  - `(flyer|/p/)` then `only` then `available`, within one sentence, finds
    `units.ts:982-983`, `broadcasts.ts:1181-1182`, `unitsRepo.ts:478-479`,
    `BroadcastComposer.tsx:540` and `RecipientPreview.tsx:88`, :376. All
    are true: the D8 send rule, D3a, and the Setup note.
  - flyer near unavailable / dead / won't work finds only the dated quote in
    the new issue.
  - `stay(s) under_application` and `for public-pages.spec` find nothing
    outside docs/superpowers.

## Judgment calls

1. C-2 goes beyond the letter in two places. It adds the top-level `['flyer']`
   check, which m16top proves bites. It also adds a case-insensitive check
   of the RAW status, which m16val proves: the old case-sensitive check
   misses a capitalized "Occupied" or "Finalizing". The label check stays
   off the Available row, as dispatched.
2. `PUBLIC_FLYER_KEYS` is a second written-out list. The allowlist test
   (:409-428) is untouched, so a new payload key must be added to both, and
   each fails loudly if it is not.
3. A-6's accepted cases assert the credit, not just the 200. By reading,
   that also kills a truncating parser and a check-then-trim order.
4. A-5's `created:` is 2026-10-28, the mission's date (UTC), matching the
   abuse issue's `updated:`. The local date was 2026-10-27 EDT.

## Left for the orchestrator (outside FW1's named scope)

- Other three-cause 404 lists still omit the off-list status. A-8c named the
  two headers only:
  - public.ts:466 (sendNotFound) and :871 (the gate comment). The route
    comment :859-866 already covers it;
  - publicApi.ts:80-81 (the getFlyer doc);
  - FlyerPage.tsx:16 and :252;
  - the sign-up path's "missing, deleted or setup" lists.
- public-signup-abuse-hardening.md still holds citations this branch did not
  shift but that are stale against main, for example `config.ts:1008-1014`
  (live :1041-1050). They were not touched.
- `FlyerPage.tsx:52-56` names only FlyerPage.test.tsx as the boundary pin.
  The server half is now pinned in publicIntake.test.ts:725-763, whose
  comment names the dashboard copy. Not touched: dashboard source, not in
  scope.

## Hygiene

- No e2e session or suite ran: no listener on lane 11, and no session.pid.
- No `AWS_*` variables were exported.
- The mutation harness and the commit-message files live only in the
  scratchpad.
- `git status --short` was empty after commit 2.
