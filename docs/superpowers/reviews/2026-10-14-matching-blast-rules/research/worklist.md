# Matching blast rules - P1 research worklist (orchestrator merge)

Build orchestrator, 2026-10-18. Merges the four live-tree drift checks of the
PLAN v2 FINAL (`docs/superpowers/plans/2026-10-14-matching-blast-rules.md`)
against `feat/matching-blast-rules` @01782138 (code == main @a2b3d80d):

| Reader | Slice | Findings file | Result |
|---|---|---|---|
| R1 | S1 app foundations (Tasks 1.1-1.5) | `R1-s1-app-foundations-findings.md` | 0 BLOCKING, 2 CORRECTION, 0 GAP, 3 NOTE |
| R2 | S2 app rules in routes (Tasks 2.1-2.5) | `R2-s2-app-routes-findings.md` | 0 BLOCKING, 2 CORRECTION, 0 GAP, 2 NOTE |
| R3 | S3 dashboard (Tasks 3.1-3.6) | `R3-s3-dashboard-findings.md` | 0 BLOCKING, 6 CORRECTION, 1 GAP, 2 NOTE |
| R4 | S4 e2e, docs, completion (Tasks 4.1-4.5) | `R4-s4-e2e-docs-findings.md` | 0 BLOCKING, 1 CORRECTION, 0 GAP, 3 NOTE |

Byte-exact backing (anchor tables, importer and invariant tables, baselines)
is gitignored run state: `.superpowers/sdd/R<n>-*-reference.md`.

Headline: every plan anchor (S1 21, S2 all but one, S3 102, S4 42) is FOUND
byte-exact and unique on the base or produced exactly by an earlier task; every
"Facts the tasks rely on" bullet holds (line hints drift by one in a few
places; the quoted text is the anchor, AR21). The invariant sweeps (stored
`audience_filter` writers/readers; tour-hold inputs; `estimatedAudience` /
`stats.audience`; every recipient-deciding path; every default-check site in
the dashboard; the whole e2e tree) found NO plan-unlisted surface except one
open issue file (R3-7). The real gap is that S3's task text predates the
binding rulings AR23-AR41 in several places (R3-1..R3-6), and S4's task text
predates AR22 (R4-2).

Baselines at base (all green, exit 0): the 8 S1-touched app files 149/149;
`app/test/broadcastApi.test.ts` 109/109; dashboard `src/routes/broadcasts`
14 files / 265 tests. Gate-5 baseline in the S3 files: exactly 5 errors
(`BroadcastComposer.tsx:205/:230/:249/:271` react-hooks/set-state-in-effect,
`useComposerDraft.ts:140` react-hooks/refs). Repo-wide `npx eslint .` at base:
22 errors across 17 files (AR38's premise holds). Mutation catalog unchanged
(no new mutating dashboard client call; count 121 at
`e2e/performance/mutationCatalog.test.ts:382`).

Environment fact (2026-10-18): the shared DynamoDB Local container had
EXITED with the host (tmpfs data already gone); the orchestrator STARTED it
(`npm run db:start`, exit 0, args current, no recreate) per AR2/AR29.

## Orchestrator rulings (BINDING on the implementers, next to plan section 4)

Section 4 rulings still win over slice text; these rulings say HOW the slice
text changes where a reader found it wrong or silent. Ids are cited in the
slice briefs and commit messages.

### S1

- **OR-S1-1 (R1-1, AR2/AR29).** Task 1.2 Step 7's "stop and ask the human" is
  void, as is the preflight's. DynamoDB Local is running. If a run proves it
  unreachable (globalSetup fails on the endpoint), run `npm run db:start` once
  (a START - never stop/restart the container) and re-run. Never run a
  DynamoDB-backed step with `ALLOW_SKIP_DYNAMO_TESTS=1`; that escape is for a
  pure-file red/green step only (AR2). Skip the preflight `npm ci` (AR1;
  installed 2026-10-14, lockfile unchanged).
- **OR-S1-2 (R1-2).** Task 1.3 Step 3: the leaky-index case is RED on the old
  resolver because it resolves `c-placing` (no status fence) - it returns
  `['c-s','c-o','c-placing']` with NO duplicates. Do not stop on the plan's
  "and duplicates" wording.
- **OR-S1-3 (R1-3, AR3).** ADD one table-driven case to Task 1.4's new
  describe pinning the three AR3 parse rules: `{ housing_authorities: null,
  housing_authority: 'atlanta_housing' }` -> 201, stored
  `housing_authorities: ['Atlanta Housing Authority']` (null = absent);
  `{ housing_authority: '  ' }` and `{ housing_authority: 7 }` -> 400
  `audience_filter.housing_authority must be a non-empty string`;
  `{ housing_authorities: 'x', housing_authority: 'y' }` -> 400
  `audience_filter: use housing_authorities only` (decided before shape).
  Record which rows are RED at base and which are PINs.
- R1-4 (projections dereference the filter; unreachable) and R1-5 (S2's
  stale note): no change.

### S2

- **OR-S2-1 (R2-1, AR32).** Task 2.3 T-Edit 1 (plan ~5545) and I-Edit 2
  (plan ~5859) use EXACTLY
  `audience resolution was truncated - the audience could not be read completely`
  (plain string, no count). The over-cap message stays AR8's.
- **OR-S2-2 (R2-2, AR9).** Task 2.5 C-Edit 8's old_string cannot match after
  S1 Task 1.5 Step 6. Re-anchor on the two lines that are identical before
  and after S1 and unique in `app/src/routes/broadcasts.ts`:
  `// Opted-out + unreachable are ALWAYS excluded. The send fans out through the`
  / `// SHARED A2P throttle (the broadcast.send job + worker a2pBucket).`
  and replace them with R2-2's six-line text INCLUDING the fail-closed clause
  (AR9 names a "tour-hold / fail-closed sentence"). S1's D1/D2 lines above
  stay untouched (insert only, never rewrite S1's text).
- **OR-S2-3 (R2-3).** Task 2.1 I-Edit 1 always takes its "merge into the
  existing import" branch (S1 Task 1.4 Step 4 adds
  `import { authoritiesOfFilter, MAX_FILTER_AUTHORITIES, wireAudienceFilter } from '../lib/blastAudienceRules.js';`);
  Task 2.1 T-Edit 1 is the plain insert. Line hints that drift by one:
  `contactsRepo.ts:1397-1398` (C-Edit 6), `seedOrgNames.test.ts:84-89` and
  `:141-146`. Hand-down: S1 owns `broadcasts.ts:14-28` (AR9) and edits the
  201 echo `:697-699`; S2's anchors `:695-696` stay byte-identical.
- **OR-S2-4 (R2-4).** In Task 2.5 (comment-only), add one ASCII clause to the
  `listingSendsRepo` and `toursRepo` dependency doc comments
  (`broadcasts.ts:124-130`) saying they also feed the open-tour holds / decline
  reads of `buildReviewRows` (preview and the create estimate) and send path
  (c). Re-run Task 2.5's grep gate afterwards; its output must stay exactly the
  predicted lines.

### S3

- **OR-S3-1 (R3-1, AR23/AR35).** Task 3.5 adds `hold` to `useComposerDraft`:
  `ComposerDraftInput` gains `hold?: boolean`; insert
  `if (input.hold === true) return;` as the first statement of the CREATE
  effect, anchored on the unique `    if (!hasBody) {` (never on
  `  useEffect(() => {`, which matches twice; do not retype the U+2192 comment
  line above it); add `input.hold` to that effect's deps; return
  `reachPending: input.hold === true || reachPending` (derived, never a stored
  flag set from `hold`); the composer passes `hold: prefillPending`.
- **OR-S3-2 (R3-2, AR34/AR40).** Rewrite the two Task 3.5 tests that wait for
  "Reaches 5 recipients" while the gate is closed, per AR34 with AR40's
  fixture; match the pending text with `/Estimating reach/` (the live text
  ends in U+2026); keep the ABORTED test's message-typing step so the
  no-create assertion proves the HOLD, not the empty-body exit.
- **OR-S3-3 (R3-3, AR39).** Replace Task 3.5's `rulesUnavailable` boolean and
  `rejectAuthority`'s fallback slot with AR39's mechanism: a `refusal` record
  (`{ draftId, key, unitId, kind: 'rules_unavailable' }`, set from the
  `previewed` object in the catch, cleared at onPreview start) rendered only
  while `refusal.draftId === draft.draftId && refusal.key === draft.key &&
  draft.draftKey === draft.key`; the 422 removal as
  `setEdits(prev => prev.unitId === <captured unitKey> ? {...} : prev)` with NO
  fallback slot; `authorityNotice` stored as `{ unitId, text }` and rendered
  only for the current `unitKey`. No `useEffect`, no ref written in render.
- **OR-S3-4 (R3-4, AR25/AR39).** Add AR25's test ("after a 503, changing the
  voucher size removes the alert") and AR39's required late-422 test; extend
  the plan's `deferred<T>()` helper with `reject`.
- **OR-S3-5 (R3-5, AR24/AR37/AR41).** Task 3.6 adds
  `unitsRead: 'loading' | 'loaded' | 'failed'` (initial `'loading'`), set ONLY
  in the read's `.then` / `.catch`; an AbortError (`controller.signal.aborted`
  or `name === 'AbortError'`, as `useOrgList.ts:91-92`) sets nothing; never
  reset it in an effect body. Render: failed -> `Couldn't load the properties.`;
  loaded with none -> `No Available properties. A property must be Available to send.`;
  loading -> nothing. Add AR41's three tests; the pending and AbortError tests
  also assert today's `No properties yet - add one from the Properties page.`
  is absent so they are RED at base.
- **OR-S3-6 (R3-6).** With the ruling tests the counts become: Task 3.5 RED
  13 failed / 54 passed (67), GREEN 67; Task 3.6 RED 6 failed / 66 passed (72),
  GREEN 72; folder 16 files / 311. Deltas caused by the ruling tests are not
  a stop condition; any OTHER unexpected failure is.
- **OR-S3-7 (lint).** S3 ends with exactly 3 errors in its touched files
  (`BroadcastComposer.tsx`: the two `setMessage` set-state-in-effect effects;
  `useComposerDraft.ts`: the pre-existing refs error) and no new error of any
  rule (count rule ids from `--format json`, severity 2 - see OR-S4-4).
- **OR-S3-8 (AR43, Cameron 2026-10-18, planner commit f62cc62f).** The
  `requested` tour label is `Tour requested <d>, no date yet` (no `at`:
  `Tour requested, no date yet`); `tourHoldLabel` returns
  `` `Tour requested${at}, no date yet` ``; its accessible-name cue is the label
  lower-cased (`tour requested oct 12, no date yet`); the Add a tenant note
  shows it as displayed. Plan section 1.1, Task 3.2's `tourHoldLabel` code and
  tests and Task 3.3's Add a tenant test are already edited; AR43 (plan
  section 4.4) is the authority if any copy disagrees. Label text only - no
  rule, kind, order or wire change.

### S4

- **OR-S4-1 (R4-2, AR22).** Task 4.1 also repairs the draft-delete test
  (`e2e/tests/dashboard-next/broadcasts.spec.ts` ~:404-416): arm a
  `page.on('response')` recorder of `POST /api/broadcasts` before the
  `page.goto`, wait for `Preview recipients` enabled, take the LAST create
  and read its JSON before navigating away; add `type Response` to the
  `@playwright/test` import. Sketch: R4 reference section 9. A red
  draft-delete test before this repair is the known AR22 race, not a stop.
- **OR-S4-2 (R4-3).** Task 4.3 Step 1 adds ONE sentence to the new GLOSSARY
  "Who a blast reaches" text: if tours or Not interested replies cannot be
  read, a filter blast's review waits with Try again (and the API's no-body
  filter send answers 503 `audience_rules_unavailable`), while a direct send
  from a contact's page goes ahead with a notice that the labels could not be
  loaded.
- **OR-S4-3 (R3-7).** Task 4.3 also refreshes
  `docs/issues/composer-org-422-offer-renamed-entry.md` (status stays open):
  its quoted copy and refs describe the whole-filter clear that D3b replaces;
  update them to the new behavior (the 422 removes only the named member with
  "<text> is no longer on the organization list, so it was removed from the
  filter."), keep the still-open "offer the renamed entry" improvement, set
  `updated:`.
- **OR-S4-5 (AR43).** S4's copy follows AR43: `e2e/support/selectors.md`'s
  tour-label text and the new spec's `requestedLabel`
  (`` `Tour requested ${date}, no date yet` ``, its checkbox cue lower-cased)
  are already edited in the plan (f62cc62f); AR43 is the authority.
- **OR-S4-4 (R4-1, R4-4, AR18/AR27/AR28/AR38/AR42).** Tasks 4.4 and 4.5 (sync,
  gates, gate-5 comparison, lint record, handback) are the ORCHESTRATOR's.
  Gate 5 is compared per rule id from `--format json` (severity 2) on BOTH
  sides, so bare core rules (`no-var`, `prefer-const`, `prefer-rest-params`,
  `prefer-spread`, `no-restricted-syntax`) are seen; the lint record counts
  files from JSON `errorCount > 0`, never from stylish path lines.

## Slice hand-downs (orchestrator-verified against git)

- **S1 -> S2/S3** (S1 tip 28b600a3; tree clean; S1 set 343/343, typecheck 0,
  smoke 0 per `build/S1-report.md`). The shipped contract is the report's
  "Contract S1 shipped" section (blastAudienceRules exports at binding 2.1
  exactly; `AudienceRulesUnavailableError` is S2's, AR6; wire filter
  `{ contact_type, housing_authorities? (non-empty only), bedroomSize?,
  excludeOptedOut, excludeUnreachable }`, never `housing_authority`). S2
  anchors verified by the orchestrator on the S1 tip: the import S2 merges
  into is `app/src/routes/broadcasts.ts:90`; OR-S2-2's two lines are `:19-20`
  (each unique); the 201 anchors `estimatedCount: estimatedAudience,` are
  `:732` (log), `:735` (audit) and `:741` (the 201 body). The router header
  S1 wrote is `:14-35` (AR9: S2 only inserts).
