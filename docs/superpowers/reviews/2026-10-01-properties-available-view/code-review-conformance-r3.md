# Code review r3 - spec conformance (re-amended note)

Branch `feat/properties-available-view` @e9b9e421. The fix wave reviewed is
2eae6330..HEAD (82b6bc69, 01083245, e9b9e421). The contract is the re-amended note
`docs/superpowers/specs/2026-10-01-properties-available-view-design.md` (3.2 and 3.3
rewritten; 3.5 and 6 touched). Rulings contested: `review-adjudications-r2.md`.
Reviewer: conformance (Opus), read-only. The coordinator's e2e gate was running in
this worktree, so every run below was a single worker and no suite was started.

Paths: `LL` = `dashboard/src/routes/listings/ListingsList.tsx`, `LLT` =
`.../ListingsList.test.tsx`, `UST` = `.../ListingsList.urgentState.test.tsx`, `AS` =
`.../AuthoritySummary.tsx`, `PR` = `e2e/performance/routes.ts`, `PRT` =
`e2e/performance/routes.test.ts`, `SPEC` =
`e2e/tests/dashboard-next/properties-available-view.spec.ts`.

## Method - mutation

Throwaway files under `dashboard/src/routes/listings/__probe_conf__/` (deleted
afterwards):

- Byte-copies of LL, each with exactly one rule reverted. Only the relative imports
  changed.
- Byte-copies of LLT, each wired to one mutant.
- A baseline copy of LLT wired to the real LL.
- One window probe.

Run with `vitest --no-file-parallelism`, with one exception: the window probe was run
alone, without that flag. Results:

| Copy | Mutation (one line of LL) | Shipped LLT tests (48) | Verdict |
|---|---|---|---|
| base | none | 48/48 green (+2 appended probes green) | HEAD is green |
| E | drop `state: OWN_WRITE` (LL:255) | "a late commit ... never wipes a newer keystroke" FAILS | stamp pinned |
| R | old guard: adopt iff not REPLACE (LL:217) | the foreign-replace test and the same-URL count test FAIL | foreign/same-URL adoption pinned |
| F | drop the pending-navigation skip (LL:252) | "skips a filter write while a navigation is pending" FAILS | skip pinned |
| G | row `onOpen` -> no-op (LL:415) | "opening a row saves the search ..." FAILS | row save pinned |
| H | drop `statusRef.current?.focus()` (LL:430) | the Show-all-statuses focus test FAILS | focus pinned |
| B | adopt iff unstamped, so POP onto a stamped entry is NOT adopted (LL:217) | ALL 48 PASS; only my appended probe fails | "Back/Forward always" UNPINNED |
| A | prune even while loading (LL:228-231) | ALL 48 PASS; only my appended probe fails | "while a view loads nothing is pruned" UNPINNED |
| C | current tab built from `selection` (LL:292) | ALL 48 PASS | "unpruned choice" pinned only jointly with A |

The two probes appended to the base copy (both green on HEAD):

- POP probe: chip 2-BR (a stamped write), then count "Show 1 coming soon property for
  DCA" (PUSH), then Back. Expect `/listings?voucher=2`, status Available, no authority
  pressed. Mutant B leaves status `setup` with DCA pressed while the URL says
  `?voucher=2`.
- Load probe: at `/listings?ha=dca` while loading, `fireEvent.blur` the box. Expect the
  location unchanged. Mutant A rewrites it to bare `/listings`.

Window probe:

- Setup: a real BrowserRouter with 600 units per view. A raw click on the Deleted tab,
  outside act. A MutationObserver clicks 2-BR as a microtask right after the commit's
  DOM mutations - that is, before a passive effect the Scheduler deferred.
- Shipped LL: `{"url":"/listings/deleted","pressed":"true"}`.
- The same LL with `useEffect` -> `useLayoutEffect` at LL:242:
  `{"url":"/listings/deleted?voucher=2","pressed":"true"}`.

Also run: `npx eslint` on every r3-touched .ts/.tsx, exit 0. Not run: tsc, npm test,
e2e, perf (gate in progress); all three are code-traced.

## Conformance against the re-amended note

61 of 64 items are DELIVERED. The amended note adds two statements to 3.2: the
pending-navigation skip, and the abandoned-text limitation. Unchanged items keep their
r2 verdicts; I re-verified each at HEAD.

| # | Amended statement | Verdict | Evidence | Pinned by |
|---|---|---|---|---|
| 3.2-model | Local urgent state; the URL is persistence | DELIVERED | LL:212-218, 246-265 | UST:40-57, 76-89 |
| 3.2-adopt | Own writes STAMPED (`unitListFilterWrite`). Adopt on mount and every navigation that is not a stamped write: Back/Forward ALWAYS; any foreign PUSH or REPLACE, including the router's same-URL REPLACE. The stamp stops a late own commit reverting a newer choice | DELIVERED | LL:87-96, 209-218, 251-257 | Stamp: LLT:752-764 (mutant E). Foreign/same-URL: LLT:766-787 (mutant R). Back/Forward-always: NOT pinned (mutant B) - R3-3 |
| 3.2-write-q | Search writes on blur and when a row is opened, rides along with other writes, never per keystroke | DELIVERED | LL:108-116, 273-275, 389, 415 | LLT:232-256, 796-808 (mutant G); UST:76-89 |
| 3.2-limit | Text abandoned by a browser Back/Forward is not saved | DELIVERED (a stated non-behavior) | No save on POP; the unmount blur is dropped by React (adversarial r2, R2-4) | n/a |
| 3.2-count | A count PUSHes, or REPLACEs on a same-URL target; either way adopted | DELIVERED | AS:38-66 (CountCell: a plain Link at 55-63, no onClick); LL:277-283 | LLT:324-335, 777-787 (mutant R) |
| 3.2-skip | A write is SKIPPED while a PUSH or Back/Forward is still pending (react-router's history index has moved past the COMMITTED location) | PARTIAL | LL:241-244 records the committed index in a PASSIVE effect. Writes are therefore also skipped AFTER the navigation has committed, until that effect runs. Window probe: 2-BR on screen, absent from the URL; with `useLayoutEffect` the write lands. R3-1 | The pending case: LLT:815-834 (mutant F). The post-commit over-skip: nothing |
| 3.2-omit | Defaults/empties omitted; unrelated params untouched | DELIVERED | `unitListFacets.ts`:88-98; LL:80-85 | UFT |
| 3.2-tabs | The current tab carries the current (unpruned) choice; the other tab is the bare path | DELIVERED | LL:289-292, 320 | LLT:789-794. It fails only if BOTH this and the prune-when-ready ternary revert (mutants A and C each pass all 48) - R3-3 |
| 3.2-inv | Prune once READY only; while loading nothing is pruned; no rewrite on load; the next interaction re-serializes | DELIVERED | LL:228-231; `unitListFacets.ts`:165-172 | No-rewrite and re-serialize: LLT:649-655. Prune-when-ready: NOT pinned (mutant A) - R3-3 |
| 3.3e | Search text local, seeded from `q`, saved on blur or row open | DELIVERED | LL:382-391, 415 | as 3.2-write-q |
| 3.5c | "Show all statuses" hands focus to the status filter | DELIVERED | LL:293, 342, 423-434 | LLT:738-746 (mutant H) |
| 6a | Terminal and resolver amendments; ledger citations updated for moved lines | PARTIAL | Terminal (PR:403-411) and resolver (PR:1103-1108) hold. The ledger PR:776-777 still cites LL:240 and 349-367 / 349-358, lines 82b6bc69 moved. Today LL:240 is a comment and 349-367 is chip markup. The anchors are now LL:298 (h1), 404 (empty title), 413 (rows `ul`), 422 (default empty line). R3-2 | PRT:422-455 checks citation FORMAT only; the new copy test (PRT:827-846) checks strings, not lines |
| 6c | Re-adopted on every navigation that is not a stamped own write; the tab switch PUSHes a bare path; the prune is the second defense | DELIVERED | LL:209-218, 320 | LLT:615-647 |

Non-DELIVERED (3): D5 is N/A (process); 3.2-skip and 6a are PARTIAL.

Behavior the code has that the note does not state, none of it a defect:

- The skip is fail-open when `history.state.idx` is absent: MemoryRouter, a hash-only
  navigation, or a future react-router change (LL:98-106).
- A ctrl/cmd-click on a row (opening it in a new tab) still runs `onOpen`, so the search
  is saved to the current URL as a stamped REPLACE (LL:116).
- When a write is skipped, its local change stays on screen until the pending
  navigation commits and is adopted (LL:262-264). This is implied by "that navigation
  wins".

## Findings

### R3-1 - LOW - The committed history index lags the commit, so the skip also drops writes made just AFTER a navigation commits

- **Mechanism.** `committedIdx` is set in `useEffect(..., [location.key])` (LL:241-244).
  React runs a transition commit's passive effects in a later Scheduler task whenever
  the commit outlasts the 5 ms slice - a long list on a slow phone. An input event
  queued during that commit runs first.
- **What breaks.** `persist` sees `historyIdx()` (new) differ from `committedIdx` (old)
  and returns (LL:252), even though the navigation has already committed. The chip is
  applied locally but never written.
- **Probe.** The URL stays `/listings/deleted` while 2-BR shows pressed. Changing only
  LL:242 to `useLayoutEffect` gives `/listings/deleted?voucher=2`.
- **Blast radius.** The note's rule is "skipped while a PUSH or Back/Forward is still
  PENDING", so this over-skips. The URL lacks an on-screen choice until the next write
  or a row open (both re-serialize the full selection). A reload in between loses it.

Suggested fix: `useLayoutEffect` for the committed-index capture. It runs inside the
commit, before any later event handler. Optionally pin it with the window probe's
MutationObserver technique.

### R3-2 - LOW - The perf source-ledger citations went stale in this very wave (watch item 6a)

- 82b6bc69 grew LL by about 60 lines and did not touch `PR`. PR:776-777 still read
  `ListingsList.tsx:240,349-367` and `:240,349-358`.
- Watch item 6 requires those citations to follow moved lines. PRT:422-455 validates
  only their format, and the new copy test (PRT:827-846) validates strings, so nothing
  caught it.

Suggested fix:

- Set `'/listings'` to `ListingsList.tsx:298,404-422` and `'/listings/deleted'` to
  `ListingsList.tsx:298,404-413`.
- Optionally extend the copy test to require each cited line to contain an expected
  token (`styles.title`, `emptyTitle`, `aria-label="Properties"`, the empty-line copy).

### R3-3 - LOW - Two stated rules have no test, and a third has only a joint one (mutation-proven)

- "Back/Forward always" (3.2-adopt): mutant B, which does NOT adopt a POP onto a stamped
  entry, passes all 48 shipped tests.
- "while a view loads nothing is pruned" (3.2-inv): mutant A, which prunes while
  loading, passes all 48.
- The loading tab test (LLT:789-794): it fails only when both the ternary and the
  `chosen`-based tab link revert. Mutants A and C each pass on their own.

Suggested fix: add the two probe tests from the method section - the chip, count, Back
sequence and the blur while loading. With those, A and C are each caught.

### R3-4 - LOW - The A2-5 ruling describes a different mechanism from the one that shipped

- `review-adjudications-r2.md`:38 says the write is skipped "while
  `window.history.state.key` differs from the committed `location.key`". The code
  compares the history INDEX, `idx` (LL:98-106, 241-252).
- The shipped choice is the correct one. react-router mints a new key on every REPLACE,
  so a key test would skip the second of two rapid own writes and reopen A5.
- A reader who "fixes" the code to match the record would do exactly that.

Suggested fix: correct the ruling's wording to "index (`idx`)".

## Fix diff reviewed cold - checked and fine

- Stamp plumbing: react-router keeps `state` in `history.state.usr`, and `location.state`
  restores it on POP. A REPLACE keeps `idx`, a PUSH increments it, and a POP restores
  it, so `idx` is the right pending-signal and the stamp survives reloads harmlessly
  (mount ignores it).
- The global ImageViewerProvider's same-URL REPLACE only fires on a viewer marker, so it
  never strips the stamp.
- Row save ordering: the user `onClick` runs before the Link's own navigate. The
  `/listings` entry is REPLACEd with `q` (stamped, idx unchanged, so not skipped), then
  the PUSH. A preceding blur write only duplicates it.
- The pending-skip test's jsdom history pollution is reset in `afterEach` (LLT:811-813),
  and it is the file's last block.
- `AuthoritySummary` is presentation-only again (AS:1-11, 38-66). The removed `onCount`
  leaves no dangling props.
- `.clear` moves to `--c-brand-hover` (`ListingsList.module.css`, about 5.5:1 on
  `--c-bg`), so both Clears and "Show all statuses" pass AA.
- `docs/issues/tenant-filters-clear-focus-contrast.md`: its citations
  `TenantFilters.tsx`:72-81 and `TenantFilters.module.css`:80-88 match the code.
- Dates are now 2026-10-01 in the issue, the plan banner and both adjudication records.
- SPEC step 5 (SPEC:156-174): `fill` then a row click saves `q` through the blur, the row
  save, or both. The two regexes are anchored on `[?&]` and `(&|$)`. Code-traced; the
  gate is running.

## Round-2 adjudications - contest or concede

- A2-1/C2-3: fix conceded. The "Test added" pins the pair jointly, not each rule (R3-3).
- A2-2/C2-4: stamp conceded. Its "Back/Forward always" clause has no test (R3-3).
- A2-3/C2-1/C2-2: conceded. Mutants E and R prove the new tests pin the stamp and
  foreign/same-URL adoption.
- A2-4: conceded. The row save is pinned (mutant G), the idle-timer rejection is
  reasoned, and the limitation is in 3.2.
- A2-5: contested - the record names key/key, but the code uses idx (R3-4); the idx is
  captured one passive effect late (R3-1).
- A2-6/C2-5: conceded. Focus is pinned (mutant H); color is visual.
- A2-7: conceded. The filed issue is accurate.
- C2-6: conceded for 1-3. This wave's line moves left the 6a ledger stale (R3-2).
- C2-7: conceded.

## Round-2 items (mine) - closure

| r2 item | Status | Evidence |
|---|---|---|
| R2-1 same-URL count unpinned | CLOSED (by design change) | `onCount` removed; a same-URL count is adopted through the stamp rule; LLT:777-787 (mutant R fails it) |
| R2-2 guard pinnable | CLOSED | LLT:752-764 (mutant E fails it) |
| R2-3 tab link drops `ha` while loading | CLOSED | LL:228-231, 289-292; LLT:789-794 (joint pin - R3-3) |
| R2-4 adoption wording vs code | CLOSED | 3.2, 6c and the LL:7-36 / 209-211 comments now match LL:217 |
| R2-5 Show-all-statuses focus | CLOSED | LL:423-434; LLT:738-746 (mutant H fails it) |
| R2-6 test gaps 1-3 | CLOSED | PRT:827-846; UST:76-89; SPEC:156-174. Item 4 (visual) conceded |
| R2-7 dates | CLOSED | `unit-voucher-size-readers-diverge.md`:8, the plan banner, `review-adjudications-r1.md`:7 |
