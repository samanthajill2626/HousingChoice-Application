# R3 - S3 Dashboard (plan section 7, Tasks 3.1-3.6) - findings

Research reader R3, area `R3-s3-dashboard`, 2026-10-18. Tree: worktree
`W:/tmp/matching-blast-rules` @01782138 (code == main @a2b3d80d). Byte-exact
backing (anchor table, consumer and invariant tables, lint and test baselines,
the ruling sketch): `.superpowers/sdd/R3-s3-dashboard-reference.md`.

Counts: BLOCKING 0 - CORRECTION 6 - GAP 1 - NOTE 2.

Headline: the S3 text applies cleanly on the live tree (all 102 edit/write/
append items replayed in memory: every anchor FOUND and unique on base, or
FOUND-AFTER the earlier S3 step that produces it; every "Facts" bullet holds;
plan-final lint is exactly the claimed 3 pre-existing errors). What the S3 text
does NOT do is implement the binding rulings AR23/AR25/AR34/AR35/AR37/AR39/
AR40/AR41 - its code and tests contradict them in the places below, and its
expected test counts become wrong once the ruling tests are added. Every ruling
was checked implementable as worded against the live code, and a sketch of
them on top of the plan-final files lints to the same 3 pre-existing errors
(no new gate-5 error).

## Findings

### R3-1 - CORRECTION - AR23/AR35 `hold` is absent from Task 3.5

- Plan: section 7, Task 3.5 Step 3 items 1-3 (edit useComposerDraft.ts) and
  item 11 (the hook call); plan lines 9701-9758, 10014-10026.
- Live: `dashboard/src/routes/broadcasts/useComposerDraft.ts:30-50`
  (ComposerDraftInput, no `hold`), `:158-160` (create effect head; the
  no-message exit is `:160`), `:258` (effect deps), `:106` + `:264`
  (`reachPending` is stored state, returned as is).
- Correction (AR23 + AR35, in Task 3.5's commit; the file is already in its
  Files list):
  1. `ComposerDraftInput` gains `hold?: boolean` (doc: true while the D3
     prefill is unsettled - no create, no delete).
  2. Insert `if (input.hold === true) return;` as the first statement of the
     create effect - anchor on `    if (!hasBody) {` (unique, ASCII) and put
     the check before it. Do NOT anchor on `  useEffect(() => {` (2 matches,
     `:124` and `:158`), and do not retype the `:159` comment (it holds a
     U+2192 arrow).
  3. Add `input.hold` to the deps at `:258`.
  4. Return `reachPending: input.hold === true || reachPending` (`:264`) -
     derived, never a stored flag; never `setReachPending` from `hold`.
  5. The composer passes `hold: prefillPending` in the `useComposerDraft`
     call. Order verified in the plan-final file: `prefillPending` (Task 3.5
     item 8) is computed at line ~204, before the hook call at ~271.
  Task 3.5 item 23's added `|| prefillPending` in the hint chain becomes
  redundant (derived `draft.reachPending` already covers it) - harmless.

### R3-2 - CORRECTION - the two Task 3.5 tests that need a reach while the gate is closed (AR34, AR40)

- Plan: Task 3.5 Step 1 item 4, tests "with a property and the filters on,
  Preview waits for the organization list - the draft alone does not enable
  it" (plan lines 9546-9558) and "an ABORTED property load is neither loaded
  nor failed: no notice, and Preview keeps waiting" (9587-9598). Both wait for
  `Reaches 5 recipients`; under AR23 no create is made while held, so as
  written both time out.
- Correction: rewrite per AR34 with AR40's fixture
  (`getUnit.mockResolvedValue(unit({ accepted_authorities: ['Atlanta Housing Authority'] }))`
  before render; resolve the list with `ATLANTA`). Precision:
  - The pending text is `Estimating reach` + U+2026 (`AudienceFilters.tsx:181`):
    assert with a regex `/Estimating reach/` (new test lines are ASCII).
  - Keep the ABORTED test's `u.type(..., 'Hello there')` step: with no unit
    the body is otherwise empty, and the no-create assertion must prove the
    HOLD, not the empty-body exit.
  - Both names keep their RED-list entries (both still fail at base: base
    creates a draft while the list is pending / after typing).

### R3-3 - CORRECTION - AR39 replaces Task 3.5's 503 flag and its 422 update; the plan code fails AR39's required test

- Plan: Task 3.5 Step 3 item 9 (`rulesUnavailable` boolean), item 15
  (`setRulesUnavailable(false)`), item 16 (503 sets `true`; 422 calls
  `rejectAuthority`), item 22 (`{rulesUnavailable ? (`), item 10
  (`rejectAuthority`: `own = prev.unitId === unitKey ? prev : { unitId: unitKey }`,
  and `authorityNotice: string | null`).
- Live: `BroadcastComposer.tsx:120` (preview result kept as
  `{ draftId, key, result }`), `:360` (`const previewed = { draftId: draft.draftId, key: draft.key }`,
  in scope in the catch), `:404-410` (`currentPreview` predicate),
  `:333-342` (`onChangeProperty` keeps the Change button enabled; pinned by
  `BroadcastComposer.test.tsx:946-969`), `useComposerDraft.ts:70-78`
  (`key`, `draftKey`).
- Why it matters: Change stays enabled during a preview (AR33). On a late 422
  for property A after staff picked B, the plan's `rejectAuthority` (A's
  closure) maps `prev` (B's slot) to `{ unitId: 'A', authorities: ... }` -
  it REPLACES B's edits slot, so B loses any staff edits - and
  `setAuthorityNotice(string)` shows "X is no longer on the organization
  list..." on B. A late 503 sets the boolean and the alert shows on B. Both
  violate AR39; the notice assertion of AR39's required test fails.
- Correction (AR39):
  - State `refusal: { draftId: string; key: string; unitId: string | null; kind: 'rules_unavailable' } | null`;
    onPreview start `setRefusal(null)`; 503 branch
    `setRefusal({ ...previewed, unitId: unitKey, kind: 'rules_unavailable' })`;
    render the alert + Try again only while
    `refusal !== null && refusal.draftId === draft.draftId && refusal.key === draft.key && draft.draftKey === draft.key`.
  - `rejectAuthority`: `setEdits((prev) => prev.unitId === <captured unitKey> ? { ...prev, authorities: <kept, or [] per the S3 fallback> } : prev)`
    - drop the `{ unitId: unitKey }` fallback slot.
  - `authorityNotice` becomes `{ unitId: string | null; text: string } | null`;
    pass `authorityError` only while `authorityNotice.unitId === unitKey`;
    `onFilterChange` keeps `setAuthorityNotice(null)`; keep pickProperty's clear.
  - No `useEffect` and no ref (a setState-in-effect is a new gate-5 error).

### R3-4 - CORRECTION - two ruling tests are missing from Task 3.5; its test helper cannot reject

- AR25's test still stands (AR36/AR39 replaced only the mechanism): "after a
  503, changing the voucher size removes the alert" - add to the "tour and Not
  interested reads" describe.
- AR39's required test (replaces AR33's): hold a Preview on property A whose
  authorities include X, Change property, pick B, land a 422 `text: X`;
  assert B's chips equal B's prefill, no "X is no longer on the organization
  list" notice, and every create for B carries B's prefilled authorities. Add
  to the D3b describe. Fixture needs: `getAllUnits` -> [A, B] both
  `status: 'available'` (Task 3.6 filters the picker), `getUnit` by id, A
  accepting X and B accepting another list name.
- The plan's `deferred<T>()` helper (Task 3.5 Step 1 item 3, plan line
  9261) has only `resolve`; the AR39 test must REJECT a held Preview - extend
  the helper with `reject` (or hold `previewBroadcast.mockReturnValueOnce` on
  a promise whose reject is captured).

### R3-5 - CORRECTION - Task 3.6 does not implement AR24/AR37/AR41's picker read states

- Plan: Task 3.6 Step 3 items 1-2 (plan 10491-10532) filter to Available and
  swap the empty-state copy only.
- Live: `BroadcastComposer.tsx:97` (`unitCandidates` starts `[]`), `:190-199`
  (the read; `.catch(() => {})`), `:482-484` (empty line keyed on
  `unitCandidates.length === 0`). As written the D9 sentence shows while the
  read is in flight and after a failed read. `getAllUnits` propagates an
  AbortError unchanged (`dashboard/src/api/paging.ts:50`).
- Correction: `unitsRead: 'loading' | 'loaded' | 'failed'` (initial
  `'loading'`), set ONLY in `.then` (`'loaded'`, after `setUnitCandidates`)
  and `.catch` (`'failed'`, but return without setting on
  `controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')`,
  the `useOrgList.ts:92` pattern). Never reset it synchronously in the effect
  body (set-state-in-effect). Render: failed -> `Couldn't load the properties.`;
  loaded and none -> `No Available properties. A property must be Available to send.`;
  loading -> nothing. Add AR41's three tests; to be RED at base, the pending and
  AbortError tests must assert the absence of BOTH today's
  `No properties yet - add one from the Properties page.` and the new
  sentences (base shows the old line while loading). Flush the rejection
  (e.g. `await act(async () => {})`) before asserting absence.

### R3-6 - CORRECTION - expected RED/GREEN counts change once the ruling tests are added

Base (measured, `npx vitest run src/routes/broadcasts`): 14 files, 265 tests;
BroadcastComposer.test.tsx 51. The plan's counts reconcile exactly with that
base for the plan-as-written tests. Adding AR25 + AR39 (Task 3.5) and AR41's
three (Task 3.6) - the AR34 rewrites keep their count - gives:

| Plan step | Plan says | With the ruling tests |
|---|---|---|
| 3.5 Step 2 (RED) | `11 failed / 54 passed (65)` | `13 failed / 54 passed (67)` (+AR25, +AR39 tests, both RED) |
| 3.5 Step 4 (GREEN) | `65 passed (65)` | `67 passed (67)` |
| 3.6 Step 2 (RED) | `3 failed / 64 passed (67)` | `6 failed / 66 passed (72)` |
| 3.6 Step 4 (GREEN) | `67 passed (67)` | `72 passed (72)` |
| 3.6 Step 5 (folder) | `16 files, 306` | `16 files, 311` |

The implementer must not "stop" on these deltas (the steps say stop if
anything else fails); the new test names join the RED lists.

### R3-7 - GAP - an open issue quotes the 422 copy and code S3 replaces

- `docs/issues/composer-org-422-offer-renamed-entry.md` (status open, low):
  title and body (`:3`, `:17`) quote `That housing authority is no longer on
  the list - pick it again`; refs cite `BroadcastComposer.tsx:117-130` and
  `:342-345` (the whole-filter clear). Task 3.5 replaces both (D3b: one member
  removed, new copy). The plan and spec never mention this issue.
- Correction: S4's registry pass (Task 4.3) refreshes it - copy, refs, and a
  line that D3b now removes only the renamed member (the "offer the new name"
  improvement is still open) - or Task 3.5's commit does.

### R3-8 - NOTE - AR39's anchors and names (verified implementable)

AR39 cites `BroadcastComposer.tsx:119` (live: the state is `:120`, its comment
`:117-119`) and `:358` (live: `const previewed` is `:360`, comment `:358-359`);
`:404-410` is exact. `previewed`, `currentPreview`, `draft.key` (string),
`draft.draftKey` (string | null), `draft.draftId` (string | null) exist with
the meaning AR39 assumes (`useComposerDraft.ts:52-78`); `unitKey` and
`FilterEdits.unitId` are Task 3.5 item 8 names. AR35's effect shape, AR41's
`useOrgList.ts:91-92`, AR34's `AudienceFilters.tsx:181` and AR33's
`BroadcastComposer.test.tsx:946-970` (test body `:946-969`) all match.

### R3-9 - NOTE - AR39's "a late refusal shows nothing" is broader than its 422 mechanism

AR39 keys the 422 edit and notice on the PROPERTY, not the draft key. So
(a) a 422 landing while staff are on the property step (Change clicked,
nothing picked yet; `onChangeProperty` `:333-342` keeps `edits.unitId`) is
applied to that property's edits, and its notice shows again if staff pick the
same property (pickProperty keeps both for the same id); (b) a message edited
during the Preview (the message is not frozen) does not stop the removal. Both
outcomes are correct - the member did leave the list - and AR39's required
test (pick a different property) is unaffected. No change required.

## Ruling override map (S3)

| Ruling | S3 place | Status in S3 text | Implementer |
|---|---|---|---|
| AR13 | Task 3.4 `prefillAuthorities` (`orgListUnknown` early return) | REFLECTED | none |
| AR14 | Task 3.3 item 16 (`noAuthorityMapped && authorities.length === 0`), Task 3.5 item 21 | REFLECTED | none |
| AR15 | Task 3.1 items 3, 5; 3.2 item 2; 3.3 item 1 | REFLECTED | final types == 2.7 |
| AR16 | 3.3 (prop), 3.5 (derived prefill, `UnitLoad`, `pickProperty`) | REFLECTED; lint 4->2 holds with the rulings (sketch) | none |
| AR22 | e2e only (S4) | n/a | - |
| AR23 | Task 3.5 hook + tests | CONTRADICTED (no hold) | R3-1, R3-2 |
| AR24 | Task 3.6 | test REFLECTED; code CONTRADICTED | R3-5 (via AR37/AR41) |
| AR25 | Task 3.5 | mechanism replaced by AR39; TEST still required, missing | R3-3, R3-4 |
| AR26 | - | SUPERSEDED by AR33 (S3 never disables Change - correct) | do NOT disable Change; no AR26 test |
| AR33 | `:946-969` must pass unchanged | REFLECTED (traced green under plan-final + hold) | AR33's test replaced by AR39's |
| AR34 | Task 3.5 two tests | CONTRADICTED | R3-2 |
| AR35 | useComposerDraft | CONTRADICTED (absent) | R3-1 |
| AR36 | - | SUPERSEDED by AR39 (no `rulesUnavailableFor`) | follow AR39 |
| AR37 | Task 3.6 | CONTRADICTED | R3-5 |
| AR39 | Task 3.5 items 9, 10, 15, 16, 22 | CONTRADICTED | R3-3, R3-4 |
| AR40 | Task 3.5 test fixture | CONTRADICTED | R3-2 |
| AR41 | Task 3.6 | CONTRADICTED (no states, no tests) | R3-5, R3-6 |
| AR38/AR42 | lint record (S4) | n/a; base gate-5 numbers below | - |

Gate-5 baseline (measured, the 12 S3 files that exist today): exactly 5
errors - `BroadcastComposer.tsx:205/:230/:249/:271` react-hooks/set-state-in-effect,
`useComposerDraft.ts:140` react-hooks/refs; every other S3 file clean. S3
removes `:205` (the `setUnit(null)` effect) and `:271` (the voucher effect),
keeps the two `setMessage` effects and the refs error, and adds none - also
true with the ruling sketch. Mutation catalog: no new mutating client function
(`e2e/performance/mutationCatalog.test.ts:382` count 121 unchanged).
