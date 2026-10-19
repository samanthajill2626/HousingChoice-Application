# Fix wave 2 - report (feat/matching-blast-rules, planner handback review round 1)

- Scope: `.superpowers/sdd/briefs/fix-wave-2.md` items 1-6 - AR44 (spec
  revision 7 D3 Timing, Cameron 2026-10-19: a failed prefill read HOLDS with
  Try again; conformance R27 folded in), conformance I2, adversarial PA-5,
  conformance R55, conformance I6, FILE PA-1 and PA-3, UPDATE the prefill
  issue.
- Base: 619af70a (tree clean, no MERGE_HEAD). Commits: f0b33c94, da45d910,
  088a12f8, 44a0263a, c0a3bc9c, 9b0bea63, then this report alone.
- Run logs (gitignored): `.superpowers/sdd/fw2-*.log`, `fw2-*-eslint.json`.
- Not run, by instruction: root `npm test`, `npm run e2e`, `e2e:session`,
  Playwright, smoke (the orchestrator runs the gates).

Abbreviations: BC = `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`,
BCT = its `.test.tsx`, AF / AFT = `AudienceFilters.tsx` / `.test.tsx` (same
folder). Lines are at 9b0bea63.

## Per item

| # | Item | Commit | RED evidence | GREEN evidence | Files |
|---|---|---|---|---|---|
| 1 | AR44 hold + Try again (and R27) | f0b33c94 | BCT + AFT: 9 failed / 95 passed (104). AFT: `Objects are not valid as a React child (found: object with keys {text, onRetry})` (base renders the notice prop as a string). 7 BCT tests: `Unable to find an element with the text: Couldn't load the property, so its housing authorities and voucher size can't be filled in yet.` (or the organization-list sentence) - base settles with the old copy and no Try again. The no-authority test: `expected document not to contain element, found <p ...>Couldn't load the organization list, so housing authorities were not filled in from the property.</p>`. The extended AbortError test is a PIN, green at base (killed by M1 below). | 104/104; mutants M1-M6 each killed (below) | BC:69-76, :137-139, :227-251, :378-399; AF:12-19, :49-55, :76-79, :229-236; `AudienceFilters.module.css:115-130`; `useComposerDraft.ts:52-58`, `:284-286` (comments); BCT:823-849 (describe note, copy constants, `expectHeld`), :979, :990, :1007, :1021, :1046, :1060, :1085, :1096, :1126; AFT:295 |
| 2 | I2 "Not used" period | da45d910 | 5 failed / 99 passed (104), each `Unable to find an element with the text: Not used (not on the organization list): Nowhere Board, Old Name HA.` / `...: Nowhere Board.` / `...: Nowhere Board. This blast is not limited by housing authority.` | 104/104 | AF:69-70, :221-227; AFT:274, :282, :292; BCT:860, :876; `e2e/support/selectors.md:148` |
| 3 | PA-5 no `audience_filter` | 088a12f8 | app: `expected 500 to be 200` on `GET /api/broadcasts` (cause probed with tsx: `wireAudienceFilter(undefined)` throws `TypeError: Cannot read properties of undefined (reading 'bedroomSize')`); dashboard `broadcastFormat.test.ts` 1 failed / 27 passed, the same TypeError | app `broadcastApi` + `blastAudienceRules` 205/205; dashboard format + list + results 79/79 | `app/src/lib/blastAudienceRules.ts:215-225`; `app/src/routes/broadcasts.ts:447-450`, `:478-480` (comments); `app/test/broadcastApi.test.ts:2811`; `dashboard/src/routes/broadcasts/broadcastFormat.ts:57-67`; `dashboard/src/api/types.ts:3340-3341`, `:3421-3422`; `broadcastFormat.test.ts:50` |
| 4 | R55 (test only) | 44a0263a | mutant copy (hold dropped from the `rowAlready` condition, `RecipientPreview.tsx:571`): 1 failed / 56 passed - the new test, `Expected the element to have class: _rowAlready_1dd163 / Received: _row_1dd163`; identity copy 57/57 | real module 57/57 | `RecipientPreview.test.tsx:37`, `:1042` |
| 5 | I6 (comment) | c0a3bc9c | n/a | n/a (comment only; lint 0; `seedOrgNames.test.ts` green in the final app run) | `app/src/lib/seed/matrix.ts:1260-1263` |
| 6 | FILE PA-1, PA-3; UPDATE the prefill issue | 9b0bea63 | n/a | `npm run issues` exit 0, no warning; indexed low debt open, low decision open, low decision open | `docs/issues/tour-hold-reading-disagrees-with-tours-page.md` (new), `docs/issues/already-sent-read-fails-open-in-default-check.md` (new), `docs/issues/matching-prefill-org-list-failure-fails-open.md` (updated; cites f0b33c94) |

### Mutants (item 1 on a BC copy; item 4 on a `RecipientPreview.tsx` copy)

| Id | Mutation (in the COPY) | Killed by (prefill describe, 17 tests) |
|---|---|---|
| M1 | an AbortError counts as a failed load | BCT:1007 only - `expected document not to contain element, found <p class="_prefillNotice_..."> Couldn't load the property, ...` |
| M2 | a failed list read holds a property that accepts NO authority | BCT:1096 only (Preview never enabled for 12 Oak St) |
| M3 | the load is not kept with its id (`loaded = unitLoad`) | BCT:1126 (R27, notice still shown after another pick) and BCT:902 |
| M4 | a failed property load settles again (pre-AR44 gate) | BCT:979, :1021, :1046 (a draft is created) |
| M5 | Try again clears the failed state while its read runs | BCT:1021 only (notice gone mid-retry) |
| M6 | `unitRetry` dropped from the load effect's deps | BCT:1021, :1046 (no second read) |

Method: a same-folder scratch copy (`*.fw2mut.tsx`, so its relative imports
resolve; `cmp` identical before mutating) wired in by a throwaway
`dashboard/vitest.fw2mut.config.ts` that merges `vite.config.ts` and adds
ONE `resolve.alias` for the test's `./BroadcastComposer.js` (or
`./RecipientPreview.js`). Each mutation came from a scratchpad script that
refuses unless its anchor occurs exactly once. Identity copies green first
(BCT 78/78, RPT 57/57). Copies and config deleted; no tracked module was
edited in place.

## The contract shipped (AR44)

- Copy (plan 1.1, exact): `Couldn't load the property, so its housing
  authorities and voucher size can't be filled in yet.` /
  `Couldn't load the organization list, so housing authorities can't be
  filled in from the property yet.`; each notice is a plain `<p>` (no role,
  as before) under the picker holding a `<button type="button">Try again`
  (`getByRole('button', { name: 'Try again' })`, `within` the notice). The
  picker's own `role="alert"` `Couldn't load housing authorities` stays.
- AF exports `PrefillNotice { text: string; onRetry: () => void }`;
  `prefillNotices?: readonly PrefillNotice[]` (was `readonly string[]`).
- Gate (BC:242-251): `prefillPending = prefillGated && (unit === null ||
  orgLoading || orgListHold)`, `orgListHold = orgError &&
  orgListUnknown(orgList) && unitAcceptsAuthority`, where the property
  accepts an authority when `authoritiesOf(unit)` has a non-blank member.
  `hold: prefillPending` into the draft hook as before (no create, reach
  pending, Preview disabled, hint `Sizing the audience` + U+2026).
- Property Try again: `setUnitRetry(n => n + 1)` from the click; `unitRetry`
  is a dep of the load effect (BC:399); state still set only in `.then` /
  `.catch`. List Try again: `orgList.reload` (BC:251); `useOrgList` not
  forked - its `error` stays true until a read succeeds.

## Final checks (on 9b0bea63)

- Dashboard `src/routes/broadcasts` - 16 files, 320 passed (312 + 8), exit 0.
- Whole dashboard - 250 files, 4820 passed (planner gate 4812 + 8), exit 0.
- App `broadcastApi`, `blastAudienceRules`, `seedOrgNames` - 3 files, 215
  passed, exit 0; no `[dynamoAdmin]` line.
- `npm run typecheck` (root, bare) - exit 0, 0 `error TS`.
- ESLint JSON on all 13 touched `.ts`/`.tsx` (`git diff --name-only
  619af70a..HEAD`), compared per (file, rule) with the pre-wave baseline: 3
  errors, 0 warnings, NEW 0 - BC `react-hooks/set-state-in-effect` x2
  (`:414`, `:433`, the two message-prefill effects) and `useComposerDraft.ts`
  `react-hooks/refs` x1 (`:152`), all pre-existing (lines moved by the added
  code/comments).
- ASCII: every added line of every commit clean; the three issue files 0
  non-ASCII bytes; `grep -cF '\u'` 0 in every touched source file; LF.

## Judgment calls (none silently taken)

1. The list-failure hold needs a LOADED property that accepts an authority
   (the brief's condition is unknown before the property loads). While the
   property is loading or failed, its own state holds; if BOTH reads failed,
   the property notice shows first and the list notice appears once the
   property's Try again succeeds - the "re-evaluated for the new property"
   rule, pinned both ways by BCT:1096.
2. Try again is not disabled while its read runs: a second click aborts the
   in-flight read (ignored as an AbortError) and starts another; the notice
   and hold stay throughout.
3. During a failure hold the reach line still reads `Estimating reach` +
   U+2026 and the hint `Sizing the audience` + U+2026 with the spinner, as
   AR44 says ("the reach line pending as for any unsettled prefill"). No new
   copy invented. UX note for Cameron: on a failure hold the spinner turns
   while nothing is loading; the notice and its Try again carry the meaning.
4. A re-pick of the same failed property on the picker entry still resets
   the failed state and re-reads it (pre-existing `pickProperty`, BC:504-512)
   with no notice during that read - a new attempt, unlike Try again.
5. R27 test (BCT:1126) holds the other property's load pending, so "a
   property change clears it" is proven before that property loads (an
   instant load would only prove "clears when the next property loads").
6. PA-5 follows the brief (field ABSENT, mirroring main), not the
   adversarial's "default tenant shape". `wireAudienceFilter` gained an
   overload so the create echo stays typed non-undefined. The dashboard wire
   types `BroadcastSummary.audience_filter` / `BroadcastResults.audience_filter`
   are now optional (honest to the wire; the two `audienceSummary` calls are
   the only readers). The app test also reads the row's results (both
   projections share the fix).
7. `selectors.md:148`: beyond the period, one sentence on the AR44 hold
   notice and its Try again (that row documents the prefill).
8. Left as history: the plan's slice code blocks (`plan.md:8252-9514`,
   `:8651`, `:11973`) and the mission review records still quote the old
   note and notices - superseded by plan 1.1 / AR44 (section 4 rulings win
   over slice text); the spec already carries the period.
   `authorityPrefill.ts:9` quotes the note with "..." - left.
9. Issues: refs cite lines at HEAD after this wave (`broadcasts.ts` moved +2
   past :449; adversarial.md's `:784-799`, `:739-741`, `:1029-1033` are
   `:786-801`, `:741-743`, `:1032-1035`). PA-1 typed `debt` and its direction
   keeps spec D4's holds (convertible first; a claim in flight holds) - only
   the words would change. PA-3 typed `decision` (spec D5 kept the soft hint
   on purpose). The prefill issue keeps its id and `type: decision`, status
   open for the stale list, severity med -> low, `updated: 2026-10-19`, the
   filed text kept under a dated "History" heading.
10. `useComposerDraft.ts` comments (the `hold` doc and the derived
    `reachPending` note) said a failed load settles the hold - corrected,
    comment only.

## Not done

- No e2e spec for the AR44 hold: not in the brief, and the brief forbade
  Playwright. A spec could fail `GET /api/organizations` with `page.route`
  (500) and assert the notice, the disabled Preview and Try again - the
  orchestrator's call.
- Nothing else in scope.
