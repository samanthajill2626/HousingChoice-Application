# Fix wave 2 - permanent flyer links (code review R2)

Fix-wave child report. Worktree `W:\tmp\permanent-flyer-links`, branch
`feat/permanent-flyer-links`, started at 00f52046 (main 71fb9b45 already
merged in at 49d9fd24; nothing merged or rebased here). The planner session
committed 35e54b70 (`intent.md` only) during this run; my commits sit on top
of it and touch none of its files. Scope: the FIX (FW2) rows of
`R2-adjudications.md` - R2-3, R2-2, R2-4 and the 404 cause-list comment row.
No runtime code changed: every source edit is a comment, and the one test
change is in `app/test`. Line numbers below are at 78a553ef.

## Commits

| Hash | Subject |
|---|---|
| 22ae56b2 | test(public): the served flyer is the Available payload in every public status but for the listing link |
| 78a553ef | docs: permanent flyer links fix wave 2 - the import namespace is public, the deleted-send trace, 404 cause lists |
| (this report) | docs(records): permanent flyer links - fix wave 2 report |

Before each commit: bare `git status` (only my files, nothing staged by
anyone else), the MERGE_HEAD check printed nothing, explicit paths staged,
the added-line ASCII check printed nothing (grep exit 1), the commit message
grepped clean, and the Co-Authored-By trailer.

## Per item

1. R2-3 - DONE (`app/test/publicIntake.test.ts:534-638`).
   - `RECORDED_FACTS` (:578-586): the five facts `seedFullUnit` leaves unset
     (`utilities`, `video_url`, `application_fee` 50, `same_day_rta` true,
     `washer_dryer` 'hookups') plus STORED two-item lists
     (`voucher_size_accepted` [1, 2], `accepted_authorities`
     ['Atlanta Housing Authority', 'DCA']). Each row seeds
     `{ ...RECORDED_FACTS, status }` over `seedFullUnit`; `seedFullUnit`
     itself is unchanged, so the other tests keep their fixture.
   - `AVAILABLE_FLYER` (:592-609): the Available payload as a literal, all 16
     keys in `PUBLIC_FLYER_KEYS` order. A literal, not `toUnitFlyer(seed)`,
     so the code under test is not its own oracle.
   - The new assertion (:634-636): `res.body` toEqual
     `{ flyer: { ...AVAILABLE_FLYER, listing_link } }`, the stored link for
     Available and null for the rest. It runs LAST, so a key or status-word
     mutant still fails at the check aimed at it (see the re-check below).
   - Kept, as dispatched: the top-level keys (:619), the key set (:620), no
     `status` property (:621), the raw status (:623), and the lowercase raw
     status and label off Available (:628-629).
   - Removed: the three one-field checks of `listing_link`, `media` and
     `contact_number`. :634 subsumes them: each value is in the literal, and
     null-versus-absent is still told apart (toEqual does not equate null
     with a missing key, and :620 pins presence).
   - The comments (:534-549, :551-553, :573-577, :588-591, :631-633) say
     what each check pins, scoped to "the response body" of a unit with
     every public field recorded. The overclaim "nothing status-derived
     under any other key" is gone.
   - Test title: "status %s: 200, the Available payload value for value but
     for the listing link (null off Available), no status word". Nothing
     cited the old title (grep).
2. R2-2 - DONE (`docs/issues/public-signup-abuse-hardening.md`).
   - :103-106: the quoted label is now "Signed up from the flyer for
     `<address>` (`<Status>`) as `<typed first last>`", with the status label
     in parentheses only when the home is not Available (D6;
     `signupPinLabel`, `public.ts:209-226`, the suffix at :224).
   - :149-155, point (d): the import namespace is in the PUBLIC GitHub
     repository (`ids.ts:24`, on the `github` remote's main since c4d9e069,
     2026-08-05; R2-1), "So ANYONE can compute an imported property's unitId
     from its address".
   - `refs:` gains `app/src/lib/import/ids.ts:24`. `status` (open),
     `severity` (med) and `updated` (2026-10-28) are unchanged.
   - Checked here: `ids.ts:24` is the `NAMESPACE` constant, and
     `git log github/main -- app/src/lib/import/ids.ts` gives c4d9e069. The
     repository's public visibility rests on R2's and the orchestrator's
     anonymous API checks of 2026-10-28; not re-queried.
3. R2-4 - DONE (`docs/issues/broadcast-send-refusal-deleted-unit-copy.md:42-65`).
   - The "Not checked" paragraph is replaced by R2's trace: the throwaway
     test's steps, then the code path, each line Read before citing:
     - the dialog opens on a status other than available
       (`RecipientPreview.tsx:391-394`);
     - its button PATCHes `available` (:442) and then sends (:444),
       `onMakeAvailableAndSend` :436-451;
     - the PATCH route (`app/src/routes/statusTransition.ts:342-371`) calls
       `setListingStatus` (`app/src/services/statusTransition.ts:684-703`),
       which never reads `deleted_at`: `unitsRepo.getById` returns a deleted
       unit (`unitsRepo.ts:1284-1293`), and `update`'s only condition is
       that the item exists (:1379). The status flips, with a
       `listing_status_changed` audit row;
     - the send guard still refuses (`broadcasts.ts:1189`), with the same
       copy (`RecipientPreview.tsx:420`);
     - a later restore only removes `deleted_at` (`unitsRepo.ts:1413-1427`),
       so the property comes back Available. Main had the same flow.
   - Extension (R2-review's own fix bullets): the Suggested fix (:67-73) now
     says which option covers which path. The pre-flight `deleted_at` check
     covers both, since it runs before the dialog. A distinct refusal code
     alone fixes the copy, but the dialog still writes the status first.
     Refusing `setListingStatus` on a deleted unit closes that.
   - `refs:` gains five sites. Type, severity (low) and status (open) are
     unchanged.
4. The comment row - DONE, comments only.
   - The cause lists now add "a stored status outside the listing statuses":
     - `public.ts:466-470` (`sendNotFound`) and :872-873 (the flyer gate);
     - `publicApi.ts:80-82` (the `getFlyer` doc);
     - `FlyerPage.tsx:16-19` (the header) and :255-258 (the catch).
   - `FlyerPage.tsx:52-59` (`MAX_UNIT_ID_LEN`) now cites
     `app/test/publicIntake.test.ts` as the pin of the server's boundary
     (200 accepted, also inside surrounding spaces; 201 refused), "so a
     change to either cap must change both" - FW1's wording in that test.
   - The "no existence oracle beyond holding the id" wording is unchanged at
     both `public.ts` sites. The reflow puts the phrase whole on one line
     (:468, :873), which makes it easier to find for the R2-1 follow-up. No
     other file carries it.
   - A `git diff -U0` filter over the three source files found no changed
     line that is not a comment line.

## RED evidence (no in-place edit)

Method: the R1-conformance section 2 harness shape, as in FW1.
- A scratchpad vitest config outside the repo
  (`scratchpad\fw2\fw2-mutant.config.mjs`) spreads `app/vitest.config.ts`
  and sets `root` to the app.
- It adds one `enforce: 'pre'` transform plugin. The plugin rewrites the
  payload line in memory (`public.ts:885` at 00f52046, :886 now) and throws
  if that anchor is missing.
- Every run's log carries `[fw2-mutant] <name> APPLIED to
  W:/tmp/permanent-flyer-links/app/src/routes/public.ts`.
- Each run used publicIntake, publicSignupLeads, propertyFormFlyerParity and
  unitFields (R2's vals2 set).
- Logs: `.superpowers/sdd/logs/FW2-<mutant>-head.log` / `-new.log`
  (gitignored).

Every mutant spreads extra values over the payload only when
`unit.status !== 'available'`:
- vals2 (R2, verbatim): `accepted_authorities: []`, `voucher_sizes: []`,
  `voucher_size: null`;
- vals (R2, verbatim): vals2 plus `same_day_rta: null`, `video_url: null`;
- facts5 (FW2): the five facts the old fixture never recorded, each null;
- lists1 (FW2): `accepted_authorities` and `voucher_sizes` cut to their
  first item.

| Mutant | Tests at 00f52046 | FW2 tests | Red line (the five non-Available rows) |
|---|---|---|---|
| vals2 | 249/249 PASS (survived) | 5 failed, 244 passed | :634 `expected { flyer: { unitId: 'unit-1', ...(15) } } to deeply equal { flyer: { ...(16) } }`; diff: `accepted_authorities` [] for the two-item list, `voucher_size` null for 1, `voucher_sizes` [] for [1, 2] |
| vals | 249/249 PASS (survived) | 5 failed | :634; the diff adds `same_day_rta` null for true and `video_url` null for the URL |
| facts5 | 249/249 PASS (survived) | 5 failed | :634; `application_fee`, `same_day_rta`, `utilities`, `video_url` and `washer_dryer` each null for the recorded value |
| lists1 | 249/249 PASS (survived) | 5 failed | :634; the diff drops "DCA" and 2 |

- All four fail ONLY at the new assertion (:634); the kept key and string
  checks pass them.
- facts5 and lists1 also need the new seed: with the old fixture those five
  facts are null and the lists one item long in every status, so no
  assertion could see either mutant. The seed is load-bearing.

Re-check: the kept checks still bite where FW1 proved them. FW1's harness
(`scratchpad\fw1\fw1-mutant.config.mjs`, used read-only) was run against the
new tree, publicIntake only:

| FW1 mutant | Result | Red line (FW1's line then) |
|---|---|---|
| m16 | 5 failed | :620 key set (:572) |
| m16key | 5 failed | :620 (:572) |
| m16val | 5 failed | :628 on 2 rows, :629 on 3 (:580, :581) |
| m16top | 5 failed | :619 top-level keys (:571) |

## Test counts and gates

| Check | Result |
|---|---|
| The four app files at 00f52046 under each mutant (baseline) | 249 tests per run (publicIntake 74), all passed |
| app publicIntake.test.ts, after commit 1 and again after the comment edits | 74 passed, EXIT=0, no `[dynamoAdmin]` line, both runs |
| dashboard `npx vitest run src/routes/public` | 9 files, 142 passed, EXIT=0 |
| root `npm run typecheck` | EXIT=0, twice: before commit 1, and after the last comment edit |
| `npx eslint` on publicIntake.test.ts, public.ts, publicApi.ts, FlyerPage.tsx | EXIT=1 - see the next paragraph |
| `npm run issues` | EXIT=0, "452 open, 215 closed, 667 total"; both issues listed, severity and status unchanged |
| ASCII, the added lines and both commit messages | clean (grep exit 1) |
| `npm test`, smoke, e2e | not run (rules); no e2e ran |

Lint, attributed by baseline. The only errors are the two PRE-EXISTING
`react-hooks/set-state-in-effect` errors in FlyerPage.tsx:
- :226:5 `setVariant(...)` in the cta effect;
- :244:7 `setStage({ kind: 'fallback', ... })` in the fetch effect.

The baseline is the 00f52046 file, linted through `--stdin
--stdin-filename` (the worktree untouched). It has the same rule on the same
two statements, at :223:5 and :241:7; the +3 is the cap comment's three added
lines. No new error. The other three files print nothing.

## Judgment calls

1. The seed goes beyond the five named fields with stored two-item lists
   for the authorities and the voucher sizes. Both are fields the
   projection reads; the fixture had only the one-item fallbacks (legacy
   `jurisdiction`, `beds`). lists1 shows why: a list cut short off
   Available survives a one-item seed.
2. The expected payload is a literal, not `toUnitFlyer` of the seed. It is a
   third written-out key list beside the allowlist test and
   `PUBLIC_FLYER_KEYS`, so a new payload key must be added to all three -
   each fails loudly if not.
3. The three one-field checks were removed (item 1); the task kept only the
   key-set and status-string checks by name, and :634 covers the rest.
4. Two comment reflows beyond the inserted words: FlyerPage.tsx's two
   paragraphs, and `public.ts:872-873`, to keep the oracle phrase on one line.
   Wording outside the cause lists is unchanged.
5. The abuse issue's quoted label still omits the opt-out note
   (`SIGNUP_OPT_OUT_NOTE`, appended only when texts are off). R2-2 named
   only the status suffix, and the quote never carried the note.

## Left for the orchestrator (outside FW2's named rows)

- R2-1 is Cameron's. The oracle lines (`public.ts:468`, :873) and the
  abuse issue's severity wait on his answer.
- Two more three-cause lists omit the off-list status. Neither is a 404
  list, and FW1 flagged the sign-up one:
  - `public.ts:523-524`, the sign-up credit: "A missing, deleted or setup
    unit (or no unitId) keeps today's plain 'housing_fair' source";
  - `dashboard/src/routes/public/FlyerPage.test.tsx:680`, a test helper's
    doc ("a missing, deleted or setup unit").
- FW1's other open note is untouched: the abuse issue's stale citations
  against main, for example `config.ts:1008-1014`.

## Hygiene

- No e2e session or suite ran. No `AWS_*` variables were exported
  (`env | grep '^AWS_'` exit 1).
- The mutation harness, the FlyerPage baseline copy and the commit-message
  files live only in the scratchpad.
- `git status --short` was empty after commit 2.
