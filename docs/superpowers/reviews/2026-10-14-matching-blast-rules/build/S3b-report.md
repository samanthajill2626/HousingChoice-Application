# S3b - Dashboard second half (Tasks 3.5-3.6) - build report (feat/matching-blast-rules)

Implementer S3b (Claude Opus 5.5), 2026-10-18. Plan section 7, Tasks 3.5-3.6,
with the binding rulings AR16, AR23, AR24 (refined by AR37/AR41), AR25 (its
test; mechanism AR39), AR33, AR34, AR35, AR37, AR39, AR40, AR41 and worklist
OR-S3-1..8. AR26 (superseded by AR33) and AR36 (superseded by AR39) are NOT
implemented: Change stays enabled; there is no `rulesUnavailableFor`. Base
70b0f8e6 (S3a report). Run logs (gitignored): `.superpowers/sdd/S3b-*.log`,
`S3b-*-eslint.json`. Paths below: BC = `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`,
UCD = `.../useComposerDraft.ts`, T = `.../BroadcastComposer.test.tsx`; line
numbers are at c0db6987.

## Commits

| Task | Commit | One-liner |
|---|---|---|
| 3.5 | 188c7a8e | composer: property prefill derived in render and owned by the property; settle gate with NO draft while it holds (`hold`); a 422 removes only the named member (property-keyed); a 503 is a refusal record shown with Try again |
| 3.6 | c0db6987 | property picker: Available only; `unitsRead` loading/loaded/failed; failed and empty states |

## RED / GREEN evidence

- Base: the two composer files 53/53 (51 + 2), exit 0 (`S3b-baseline.log`);
  lint on the four S3b files exactly 5 errors (BC :211/:236/:255/:277
  set-state-in-effect, UCD :140 refs) (`S3b-baseline-eslint.json`).
- 3.5 RED (`S3b-3.5-red.log`): 1 failed | 1 passed files; 13 failed / 54
  passed (67) = OR-S3-6: the plan's 11 names + AR39's late-422 test + AR25's
  test. Reasons: no prefill chips / notes / notices (D3b x3, prefill x6); both
  AR34 rewrites fail on `expected "spy" to not be called at all` (base makes a
  draft while the gate is closed - exactly the hold); the 503 alert reads the
  raw `audience_rules_unavailable`; AR25's test cannot find the 1.1 sentence.
  The 3 PINs green.
- 3.5 GREEN (`S3b-3.5-green.log`): 2 files, 67/67.
  BroadcastComposer.prefill.test.tsx unchanged, 2/2. AR33's test (T:1326, `a
  property changed while the preview loads: ...`) is byte-identical to base
  (cmp of its 24-line body) and green.
- 3.6 RED (`S3b-3.6-red.log`): 6 failed / 66 passed (72) = OR-S3-6: bare and
  ?contactId= (12 Oak St listed), the empty-state test (sentence absent), the
  pending and AbortError tests (base shows `No properties yet - add one from
  the Properties page.`, T:1478 / T:1497), the failed-read test (sentence
  absent). The PIN green.
- 3.6 GREEN (`S3b-3.6-green.log`): 72/72.
- Mutation proof of the ruling tests (each edit undone, files re-run green
  after): (1) the plan's original 422 code (fallback slot + unkeyed notice)
  -> AR39 test RED on the notice; (1b) an unguarded removal on the current
  slot -> AR39 test RED on the chips; (2) the 503 alert shown unkeyed -> AR25
  test RED; (3) `hold: false` -> both AR34 tests RED (a create while held);
  (4) an AbortError counted as a failure -> AR41 AbortError test RED; (5) the
  empty state shown while loading -> AR41 pending test RED.
  (`S3b-3.5-mut*.log`, `S3b-3.6-mut*.log`)
- Slice end: folder `src/routes/broadcasts` 16 files / 311 tests, exit 0
  (`S3b-end-folder.log`) = OR-S3-6; whole dashboard 250 files / 4811 tests,
  exit 0 (`S3b-dashboard-all.log`); root `npm run typecheck` EXIT=0, 0
  `error TS` (`S3b-end-typecheck.log`); dashboard typecheck 0 after each task.
- Lint end state, all 15 S3-touched .ts/.tsx files (`git diff --name-only
  182c349c...HEAD`, `S3b-end-eslint.json`), compared per (file, rule id) at
  severity 2 with R3's base JSON: 3 errors, 0 warnings, NEW 0, REMOVED 2
  (BC set-state-in-effect 4 -> 2) - OR-S3-7.
- ASCII: added lines grep clean before both commits; `grep -cF '\u'` 0 in
  every touched file; every touched file LF.

## Final lint errors (all pre-existing)

- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:394` react-hooks/set-state-in-effect (resolved-mode `setMessage` effect; S3b base :236, main :230)
- `dashboard/src/routes/broadcasts/BroadcastComposer.tsx:413` react-hooks/set-state-in-effect (multi-recipient `setMessage` effect; S3b base :255, main :249)
- `dashboard/src/routes/broadcasts/useComposerDraft.ts:151` react-hooks/refs (`disposableRef.current = ...`; S3b base and main :140)

Removed by S3b: BC base :211 (`setUnit(null)` effect, main :205) and :277
(voucher `setFilter` effect, main :271).

## Ruling table

| Ruling | Where (file:line) | Pinned by (T:line) |
|---|---|---|
| AR16 derived prefill, edits owned by the property, load kept with its id, AbortError neither, different property empties at once, lint 4 -> 2 | BC:81 `UnitLoad`, BC:88 `FilterEdits`, BC:185-220 (`loaded`, `unit`, `authorityPrefill`, `propertyVoucherSize`, `edits`, `unitKey`, `filter` memo), BC:363-379 load effect (setState only in .then/.catch; abort guard :375), BC:484 `pickProperty`; voucher effect and `setUnit(null)` deleted | T:868 staff edits win, T:887 same / DIFFERENT property, T:840, T:856, T:991 aborted |
| AR23 no draft while unsettled | BC:228-232 gate (`prefillGated`, `prefillPending`, `prefillNotices`), UCD:57 `hold?`, UCD:176 first statement of the create effect, BC:306 `hold: prefillPending`, BC:568 `!prefillPending` in `canPreview` | T:938 (no create while the list is pending, then exactly ONE carrying the prefill), T:991 |
| AR25 (test) after a 503, a voucher change removes the alert | via AR39 (BC:591) - no effect | T:1080 |
| AR33 Change stays enabled; late 422/503 discarded | Change button BC:755-763 unchanged (no `disabled`); lateness via AR39 | T:1326 unchanged; T:778 |
| AR34 the two gate tests rewritten | - | T:938, T:991 (names unchanged) |
| AR35 hold shape: dep, early return before the no-message exit, derived reachPending | UCD:176, UCD:277 deps, UCD:285 `reachPending: input.hold === true \|\| reachPending` | T:938, T:991 |
| AR37 picker states | BC:163 `unitsRead`, BC:340-357 read effect (set only in .then :344-347 / .catch :348-355), BC:672-678 render | T:1438, T:1470, T:1481, T:1489 |
| AR39 refusal as data; 422 property-keyed, no fallback slot; notice `{ unitId, text }` | BC:105 `PreviewRefusal`, BC:115 `AuthorityNotice`, BC:243 state, BC:256-268 `rejectAuthority` (`setEdits(prev => prev.unitId === owner ? ... : prev)`), BC:527 `setRefusal(null)`, BC:538 422, BC:543 503 `setRefusal({ ...previewed, unitId: unitKey, kind })`, BC:591 `currentRefusal` (the `currentPreview` predicate), BC:740 notice only for `unitKey`, BC:786 alert | T:778 (late 422 on B), T:750 (control: current draft), T:1022, T:1080 |
| AR40 fixture | - | T:938 (`getUnit` accepts Atlanta, list resolves `ATLANTA`, one create with `['Atlanta Housing Authority']`) |
| AR41 aborted units read stays 'loading' | BC:353 | T:1470 pending, T:1481 ApiError, T:1489 AbortError |
| OR-S3-1 | = AR23/AR35 (anchor note: Deviations 1) | T:938, T:991 |
| OR-S3-2 | = AR34/AR40; `/Estimating reach/`; typing kept in the aborted test | T:938, T:991 |
| OR-S3-3 | = AR39 | T:778, T:750 |
| OR-S3-4 | `deferred()` gains `reject` (T:89-103) | T:1080, T:778 |
| OR-S3-5 | = AR37/AR41 | T:1470, T:1481, T:1489 |
| OR-S3-6 | counts met exactly (67 / 72 / 311) | - |
| OR-S3-7 | 3 errors, nothing new | - |
| OR-S3-8 | no tour-label copy in S3b's files (S3a shipped AR43) | - |

## Deviations from the plan text

1. OR-S3-1 anchor: the hold check was inserted with the unique ASCII anchor
   `  useEffect(() => {` + `    // No message yet` (1 match; the U+2192 line
   is not retyped) instead of `    if (!hasBody) {`, so the hold block and its
   comment sit ABOVE the no-message comment instead of between it and its
   `if`. Same program: the check is the effect's first statement.
2. The AR34 rewrites read the pending reach by text (`getByText(/Estimating
   reach/)`), not `getByRole('status')`: while pending, the Spinner beside
   Preview is a second `role="status"` (N1).
3. Test helpers: `deferred()` returns `reject` too (OR-S3-4); a new
   module-level `outlastCreateDebounce()` (800 ms in `act`) makes the AR34
   no-create assertions outlast the 600 ms debounce (that is what makes them
   RED at base).
4. Plan items 9/15/16/22 (`rulesUnavailable` boolean) and item 10's fallback
   slot + string notice are replaced by AR39 (OR-S3-3). Item 23's
   `|| prefillPending` in the hint chain is kept (redundant with the derived
   `reachPending`, harmless - R3-1).
5. The voucher-effect deletion removes one surrounding blank line too (the
   plan text would leave two blank lines - R3, cosmetic).
6. `Couldn't load the properties.` renders as `<p className={pickerHint}
   role="alert">` (AR37 gives the copy only); `No Available properties. ...`
   is a plain paragraph as the line it replaces was.
7. The plan's 503 test is verbatim; AR25's test is self-contained after the
   PIN in the same describe.

## Surprises / notes

- N1: while the reach is pending - now also while the prefill holds, which
  lasts until the list and the property have loaded - the compose step has
  TWO `role="status"` elements: the reach line (unnamed, in the Audience
  section) and the Spinner beside Preview (name `Loading`). A bare
  `getByRole('status')` is ambiguous then (true during the 600 ms debounce
  before S3 too); read it after it settles, or by text.
- N2: R3-9 holds as built: a 422 landing while staff are on the property
  step (Change clicked, nothing picked) applies to that property's edits and
  its notice returns if the same property is picked again; a pick of a
  different property clears it.
- N3: the AR39 fixture: A (77 Peachtree St) accepts only X (DeKalb), B
  (12 Oak St) only Atlanta, so A minus X ([]) differs from B's prefill - the
  chip assertion catches an unguarded removal, the notice assertion the
  plan's original code (mutations 1, 1b).
- N4: the create-path 422 calls the latest committed render's
  `rejectAuthority` (the hook reads it through its ref); a create whose
  inputs changed is superseded by the hook's generation check before it can
  call back, so that render's property and list are the ones it carried.
- N5: R3's prediction for BroadcastComposer.prefill.test.tsx held: exactly
  one create in both variants, unchanged file.

## Contract S3b shipped (S4 consumes)

### useComposerDraft

`ComposerDraftInput.hold?: boolean` (no create, no delete while true);
`onOrgNotOnList?: (err: ApiError) => void`; the returned `reachPending` is
derived as `hold || <create pending>`. The composer passes
`hold: prefillPending`.

### Compose step (filters on) - copy and accessible names

- Picker: combobox `Housing authorities` (exact), placeholder `Any housing
  authority`; chips are buttons `Remove <entry name>`; a picked name is hidden
  from the options. Voucher: group `Voucher size`, chips `Studio`, `1-BR`,
  `2-BR`, `3-BR`, `4+ BR` (`aria-pressed`), the property's chip tagged
  ` - matches property`.
- Prefill (with a property and the filters on): the property's accepted
  authorities that map (exact names or unique spellings, property order)
  are chips once the property and the list have loaded; `Not used (not on the
  organization list): <names joined ", ">` (plain p) and, only while none
  mapped AND the list is empty, ` This blast is not limited by housing
  authority.` appended.
- Failure notices (plain p, no role, under the picker): `Couldn't load the
  property, so its housing authorities and voucher size were not filled in.`
  / `Couldn't load the organization list, so housing authorities were not
  filled in from the property.` (the latter beside the picker's own
  `role="alert"` `Couldn't load housing authorities`).
- 422 (create or Preview), the picker's `role="alert"` (the combobox's
  description): `<member> is no longer on the organization list, so it was
  removed from the filter.`; a body with no text: `That housing authority is
  no longer on the organization list, so it was removed from the filter.`.
  Only that member is removed (an edit); shown only while its property is on
  screen; the next filter change clears it.
- 503 on Preview: `<p role="alert">` with `Couldn't check tours and Not
  interested replies, so the recipient list can't be shown yet.` and inside
  it `getByRole('button', { name: 'Try again' })` (the alert's text content
  ends ` Try again`). Compose and the message stay; Try again re-runs Preview;
  any filter, message or property change removes the alert. A late 422/503
  (another property on screen) shows nothing.
- Reach line (`role="status"`, unnamed): `Estimating reach` + U+2026 while a
  create is pending OR the prefill holds; `Reaches <n> recipient(s)`;
  `Reach estimate unavailable` (estimatedCount omitted); suffix ` - the list
  is incomplete`. Spinner `role="status"` name `Loading` beside Preview while
  pending (N1).
- Preview: button `Preview recipients` (`Loading` + U+2026 while busy);
  disabled-hints `Write a message to enable the preview.`, `Pick the housing
  authority from the list, or clear the text.`, `Sizing the audience` +
  U+2026 (pending reach, no draft yet, or the prefill holding).
- `Change property` (aria-label; text `Change`) stays enabled during a
  Preview; a late 200 still shows `The audience changed - preview again.`.

### Property step (bare and ?contactId= entries)

- Heading `Send a property`, `Choose the property to send.`, combobox
  `Property`, list `Properties` of buttons whose name starts with the short
  address. Only `status === 'available'` properties are offered (browse and
  search).
- `Couldn't load the properties.` (`role="alert"`) after a failed read; `No
  Available properties. A property must be Available to send.` (plain p)
  only after a read that landed with none; nothing while loading or after an
  aborted read; `No properties match that search - clear it to browse them
  all.` unchanged. The old `No properties yet - add one from the Properties
  page.` is gone.
- ?unitId= keeps any status: the `This property is <Status>, so its flyer
  link won't work. ...` banner and the Send-time `Property isn't Available`
  dialog are unchanged.

### Draft-create timing (POST /api/broadcasts)

- Gate scope: a property attached, the filters on, not ?draftId=. While the
  property load (loaded or failed; an aborted load does not count) or the
  org list read (loaded or failed) has not settled: NO POST and no DELETE;
  the reach reads pending; Preview disabled with `Sizing the audience`.
- ?unitId=X: GET /api/organizations and GET /api/units/X start at mount in
  parallel. The first POST fires 600 ms (debounce) after the LATER of the
  two settles (the message prefill lands with the unit), and already carries
  the prefilled `housing_authorities` (omitted when none mapped) and
  `bedroomSize` - there is no earlier POST without the prefill. Property load
  failed: no message prefill, so no POST until staff type (600 ms after the
  last keystroke), filter `{ contact_type: 'tenant' }`. List read failed:
  POST with `bedroomSize` only.
- Bare entry: GET /api/organizations + GET /api/units (all pages) at mount;
  no POST before a pick; after a pick GET /api/units/<id>, first POST 600 ms
  after it (and after the list, if that is still pending).
- ?contactId= (seeds-only, filters off): not gated - POST 600 ms after the
  picked property loads (resolved message, `seedContactIds`, no
  `audience_filter`); after `Add more tenants by filters` it is gated (both
  usually settled) and recreates 600 ms later with the filter.
- ?draftId=: never gated; no POST until staff type.
- A DIFFERENT property: filters empty at once; no POST until its load
  settles; a create in flight for the old inputs is discarded and DELETEd
  when it lands. The SAME property again: not held; a POST 600 ms after the
  message refills (a new draft; the previous one is DELETEd after it lands).
- A POST refused 422: the member is removed and a POST with the rest follows
  600 ms later.
- In dev StrictMode the first mount's GETs are aborted and repeated; an
  aborted read never settles the gate. For AR22: `Preview recipients`
  enabled implies the gate settled and the current draft matches the
  screen; take the LAST create response received by then.

## Not done

Nothing in Tasks 3.5-3.6. No root `npm test`, no e2e (per the brief).
`docs/issues/composer-org-422-offer-renamed-entry.md` still quotes the old
422 copy - its refresh is S4's (OR-S4-3). Final root typecheck exit code: 0.
