# R5 code review - feat/today-checklist (tracker #31)

Reviewer: R5 (fresh; Claude Opus 5.5), 2026-10-25. Tree `W:\tmp\today-checklist`,
branch `feat/today-checklist`, HEAD 70c3bac1, base main @970a29b9. Scope: fix
wave 4 only (ded02c99..70c3bac1): the render-key change in
`dashboard/src/routes/today/Today.tsx`, its tests in `Today.test.tsx`, and the
filed issue `docs/issues/today-past-tours-labeling-settle-window.md`. Reviewed
cold. Inputs read: R4-adjudications.md, R4-review.md (R4-1, R4-2),
FW4-report.md, the FW4 diff package (`.superpowers/review/r5/fw4-diff.txt`,
checked equal to `git diff ded02c99..70c3bac1`), the live source of
`Today.tsx`, `TodaySection.tsx`, `buildToday.ts`, `useToday.ts`,
`useTodayPastTours.ts`, `tours/useTours.ts`, the server builders in
`app/src/routes/today.ts`, `docs/issues/README.md` + `_TEMPLATE.md`, and spec
r8 sections 2.1, 2.3, 3, 3.1, 5.2, 5.3.

Method: throwaway tests beside the suite, run bare from the dashboard
workspace (`cd W:/tmp/today-checklist/dashboard && npx vitest run
src/routes/today/<file>`), then deleted. To tell a real check from a vacuous
one, the page probes ran against three implementations in one file: HEAD's
`Today.tsx`, a throwaway COPY of the ded02c99 `Today.tsx` (`git show`), and a
throwaway mutant of HEAD whose lookup ignores the Map (`(item) =>
rowKey(item)`); the committed unit expectations also ran against a mutant
using a plain per-key counter (FW4's own mutation). No existing file was
edited, nothing was committed, no suite, e2e session or dev server was
started. Single-file and single-directory runs only.

Counts: HIGH 0, MEDIUM 0, LOW 0, INFO 0. REGRESSION 0, NOT A REGRESSION 0.

---

## 1. Findings

None. Nothing below reached the bar of a defect with a reachable failure
scenario; the measured edges are recorded in section 2 and the swept list so
nobody re-derives them.

---

## 2. FW4 code, line by line (charge 1)

`rowKeysOf` (Today.tsx:97-117), used by ItemsSection (:172 - Needs you now,
Identify these contacts, Tours to book, Placements), Tours today (:421) and
the AI line (:449); `rowKey` (:93-95) is now read only by `rowKeysOf`.

- Unique within each list on every render: yes, by construction - every
  assigned key is probed against `used` before it is added, so two distinct
  row objects of one list can never meet, whatever their refIds (a real refId
  ending in `#2` included). Probe: 2000 random lists over refIds `a`, `a#2`,
  `a#3`, `a#2#2`, `b`, `unknown?phone=`, `unknown?phone=#2` - every key set
  unique, and LimitedList's first-5 slice keeps the whole list's keys
  (TodaySection.tsx:83, :88-90 slice the same objects).
- Stable when the data is unchanged: yes. The keys are a pure function of the
  list's order, so a refetch with equal data and NEW objects (a parsed
  response, or a rebuilt fallback) yields the same strings. Probe: a fallback
  list with repeats [X1, A1, X2, C1, C2] rerendered from `structuredClone`d
  threads reuses every `<li>` node (`toBe` the previous node); the same for
  server rows. For any list with no repeated refType:refId the keys equal the
  plain `rowKey` byte for byte (200 random lists) - so the server path, which
  never repeats (see 4, divergence 1), renders exactly as at ded02c99.
- Reconciliation across a refetch that adds, removes or reorders rows: correct
  - the DOM lists exactly the load. Probes, all green at HEAD with zero
  "same key" console errors:
  - the two committed cases (fallback refetch without Al; fallback then the
    server's Bea, Cal);
  - R4's phone variant (two unlinked threads on one phone, refetch drops Al)
    -> exactly Cy Phone, Di Phone;
  - seven unlinked email threads: insert one ahead, reorder, remove the middle
    of three repeats, grow past 5, Show all, then a refetch that drops two and
    adds one -> each step exactly the load, "Show fewer" kept (spec 2.1:
    expansion is page state);
  - Tours today and the AI line fed synthetic repeated keys (no source emits
    them) across a refetch -> exactly the load;
  - a seeded random walk of 400 refetches (fallback and server loads,
    repeats, contact-id collapse, empty lists, random Show all clicks): DOM
    names and the Show all / Show fewer label equal the load at every step;
    the same walk, 200 steps, under `<StrictMode>` (the dashboard renders
    under StrictMode, main.tsx:15).
  Against the ded02c99 copy and the no-map mutant the same file fails:

      x ... - base ded02c99 > committed case 1: a fallback refetch that drops the first row
        -> expected [ 'Xena Mail', 'Xena Mail', ...(1) ] to deeply equal [ 'Xena Mail', 'Yuri Mail' ]
      x ... - base ded02c99 > committed case 2: fallback then the server load
        -> expected [ 'Xena Mail', 'Bea Server', ...(1) ] to deeply equal [ 'Bea Server', 'Cal Server' ]
      x ... - base ded02c99 > R4 phone variant: two unlinked threads on one phone, refetch drops the first row
        -> expected [ 'Cy Phone', 'Cy Phone', 'Di Phone' ] to deeply equal [ 'Cy Phone', 'Di Phone' ]
      x ... - base ded02c99 > random walk: 400 refetches ...
        -> "step 1: got [\"X3 Mail\",\"A1 Server\",\"B2 Server\",\"B1 Server\",\"Y3 Server\",\"Y1 Server\"]
            expected [\"A1 Server\",\"B2 Server\",\"B1 Server\",\"Y3 Server\",\"Y1 Server\"]"
      Tests  15 failed | 19 passed (34)   <- every failure is base or a mutant

  The base copy and the no-map mutant each fail six of the eight page probes
  (both committed cases, the phone variant, both random walks, the warning
  check); HEAD passes all eight. The insert / reorder / remove sequence and
  the Tours today / AI probe happen not to ghost on the base (they only log
  the duplicate-key warning), so they are not discriminating on their own -
  the random walks are.

- Identity among rows that share a refType:refId is positional (the n-th row
  with that refType:refId holds `#n`, the first the plain key), so when a
  refetch removes or inserts a repeat ahead of
  another, React hands the departed row's DOM node to its successor and
  updates its text in place. Nothing visible follows: `Row`, `CompactTourRow`
  and `Link` hold no state, and rows that share refType:refId share the href
  (`hrefFor`, Today.tsx:80-91), so a focused link still opens the same place.
  The alternative R4 offered (a client key = conversationId) would track the
  thread instead; output is identical either way. Not a finding.
- Other readers of these keys, of row identity or of `rowKey`: none. Grep
  over `dashboard/src` and `e2e`: Today's `rowKey` / `rowKeysOf` appear only
  in Today.tsx and Today.test.tsx; Inbox's `rowKey` is a separate function
  (`inbox/inboxListMerge.ts:32`); the Past tours (`tourId`), Relay
  (`conversationId`) and Quiet shares (`unitId`, QuietShares.tsx:194) keys are
  untouched; React keys never reach the DOM, so no e2e reads them. No code in
  the today directory compares row objects (`indexOf` / `findIndex`: none).
- The object-identity lookup: every lookup hits the Map today. Rows are a
  parsed response (`request`, api/endpoints.ts:149-167) or buildToday
  literals each pushed once (buildToday.ts:284-304; the kept contact row is
  not pushed again); `rowsOf` is a filter (Today.tsx:501); ItemsSection and
  AtAGlance hand LimitedList the same array they key, and LimitedList slices
  without cloning. No parent clones rows. StrictMode's double render is
  harmless (`rowKeysOf` is pure). The `?? rowKey(item)` fallback is never
  taken; it would only matter for a future caller that clones rows.
- Per-render cost: the Map and Set are O(n) per list. The suffix probe always
  starts at `#2`, so it is quadratic in the repeats of ONE key - measured on
  one call: 100 repeats 0.9 ms, 1000 repeats 68.4 ms, 3000 repeats 592.4 ms.
  Unreachable: repeats need contact-less unknown_1to1 threads in a 404
  fallback (effectively dead in prod); inbound email builds its thread for a
  contact (app/src/services/inboundEmail.ts:388-399, :948-950); prod's
  Identify holds 8 (spec 5.2). Not a finding. If ever wanted, a per-key "next
  suffix" Map starting the probe where the last repeat stopped keeps the
  output identical and makes it linear.
- Can the new tests fail: yes. Both page cases (Today.test.tsx:1025, :1041)
  fail on the ded02c99 copy and on the no-map mutant (quoted above). The
  taken-suffix expectation (:1095-1101) fails on the counter mutant and
  nothing else does (matches FW4's mutation proof):

      x ... - mutant: plain per-key counter > a taken suffix moves on
        -> expected [ 'contact:unknown?phone=', ...(2) ] to deeply equal [ 'contact:unknown?phone=', ...(2) ]
      v ... - mutant: plain per-key counter > repeats get #2, #3 in list order

  The `#2, #3` expectation (:1077) fails on the no-map mutant. The file's
  global beforeEach resets `state` and `past` (:144-149), so the new cases are
  order-independent. Gap (not a finding): no page test drives the Tours today
  or AI line call site, so reverting either one to `rowKey` would pass the
  suite; no source repeats a key in those lists (4, divergence 1) and the
  derivation they share is unit-pinned.
- Committed suite at HEAD: `Today.test.tsx` alone 54 passed with no "same
  key" output; `src/routes/today` 8 files / 146 passed (FW4-report's count);
  `npx tsc -p tsconfig.json --noEmit` (dashboard) exit 0; `npx eslint` on
  Today.tsx + Today.test.tsx exit 0, no output; 0 non-ASCII bytes on the
  diff's added lines.

---

## 3. Regression sweep (charge 2)

No regression. Behavior right at ded02c99 and wrong now - none found:

- Every list with no repeated refType:refId (every server load) keys exactly
  as at ded02c99 (proved above), so nothing remounts that did not before.
- Every list with a repeat was wrong at ded02c99 (duplicate keys; ghost rows
  on a refetch, R4-1) and is right now.
- `itemKey` is a new function per render; LimitedList is not memoized and
  uses it only during render (no effect dependency), so no extra work or
  reset follows. The AI line's keys are derived only while it is open.
- The lifted expansion Set (keyed by label), `collapseList`, the empty-and-
  failed past-tours branch, `allCaughtUp` and `settling` are untouched by the
  diff.
- Exporting `rowKeysOf` from a component module: 31 other dashboard `.tsx`
  modules export lowercase helpers beside components and no react-refresh
  lint rule is configured, so this is the project's norm (a dev-only Fast
  Refresh boundary matter), not a regression.

---

## 4. Verdicts

- FW4-1 (R4-1): REAL - R4-1 is closed. Every Today TodayItem list gives each
  row its own key; R4's ghost-row probes (email and phone variants), the
  insert / reorder / remove / Show all sequences and 600 random refetches
  (incl. StrictMode) list exactly the load at HEAD with no duplicate-key
  warning, and fail on the ded02c99 copy. The wire type, refIds, links, row
  text and order are unchanged (spec 3, 3.1).
- The filed issue `docs/issues/today-past-tours-labeling-settle-window.md`:
  ACCURATE.
  - Frontmatter per docs/issues/README.md: id equals the filename slug;
    title, type `bug`, severity `low`, status `open` are in the schema; area,
    created 2026-10-25; `refs` is the comma-separated path:line form (ranges
    are an established form in other issues). A read-only replica of
    `scripts/issues.mjs`'s parser reports no warning; all four ref paths
    exist; 0 non-ASCII bytes; template comments removed. INFO maps to `low`,
    the registry's floor.
  - Cited lines at HEAD: useTours.ts:328 is `setState({ status: 'ready',
    past, reloadFailed: false })`; useTodayPastTours.ts:167-178 is the
    labeling effect; :199 returns the previous `labeled.rows` with the current
    `reloadFailed`; Today.tsx:529-536 is `allCaughtUp`.
  - Problem as R4 found it: both cases (a recovery after a failed reload; an
    empty -> non-empty reload with no failure), the mechanism, spec 2.3's
    settle rule (spec :124-125) and the 5.3 sentence (spec :269-270), and the
    suggested fix all match R4-2. "Pre-existing on main's shape" verified
    (970a29b9 useTodayPastTours.ts:155-166, :187). One nuance, not an
    inaccuracy: in the no-failure case the message is already on screen
    before the reload; the window is that it stays one labeling round trip
    after the raw rows land. No overlapping issue exists (searched "All caught
    up", "labeling", "settle").
- FW4-report "Found that the adjudication did not cover":
  1. Reach (all three TodayItem lists use `rowKeysOf`): AGREE. The other two
     lists keyed by the same `rowKey`; no source repeats there (server: one
     row per Tour entity, app/src/routes/today.ts:690-708; AI rows grouped by
     ownerContactId, :1184-1201; fallback: one per Tour entity,
     buildToday.ts:244-255, no AI rows). The call sites carry no page test
     (gap noted in 2).
  2. First free suffix over a plain counter: AGREE. Uniqueness holds by
     construction; output equals a counter whenever no refId carries `#`
     (every refId today); the pin catches the counter mutant.
  3. One row OBJECT listed twice still shares a key: AGREE, and unreachable.
     Confirmed: `[x, x]` keys to `["contact:unknown?phone=#2",
     "contact:unknown?phone=#2"]`; no source lists one object twice.
  4. The issue cites Today.tsx:529-536, not R4's :507-514: AGREE (FW4 added
     22 lines above it; verified).
  5. The RelationshipsEditor duplicate key `1` is outside this branch: AGREE.
     Reproduced (`RelationshipsEditor.test.tsx` alone: the warning, 11
     passed); the branch changes nothing under dashboard/src/routes/contact
     (last touched on main, 7682e9b6).

---

## Swept, no finding

- Key uniqueness, stability, slicing and reconciliation (section 2): proven
  by construction and by probe, incl. StrictMode.
- Positional identity among repeats: benign (stateless rows, shared href).
- The suffix probe's quadratic cost: 0.9 ms at 100 repeats; the volumes that
  hurt are unreachable.
- Readers of the keys, rows or `rowKey`: none beyond the three call sites.
- Server path: keys byte-identical to ded02c99 (no repeats on the wire).
- Tests: the new cases fail on the base and on mutants; order-independent.
- Gates spot-checked: today dir 146 passed, dashboard tsc 0, eslint 0, ASCII.
- The issue file: schema, refs, cited lines, spec quotes, main's shape.
- State left: every throwaway (zz-r5-v1/v2 tests, the ded02c99 copy, two
  mutants) deleted; `git status --short` shows only this record.
