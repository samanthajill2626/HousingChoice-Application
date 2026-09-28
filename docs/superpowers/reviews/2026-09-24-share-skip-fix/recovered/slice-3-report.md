> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/slice-3-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Slice 3 report - Tasks 8 and 9 (share-skip-fix D5 / I3 / I4)

Run state (git-ignored, not committed). Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\share-skip-fix`, branch `feat/share-skip-fix`, start HEAD 871bb3a8.
Started 2026-09-25 15:03:49, done 15:13:18 (about 10 min of the 75 min timebox).

| Task | Commit | Subject |
|---|---|---|
| 8 | f199dc4c | fix(broadcasts): a skipped slot never counts as already sent (spec D5) |
| 9 | ea0f5318 | fix(dashboard): seeded and hand-added rows stay checked through Select all; note copy (spec D5) |

Final HEAD: ea0f5318. Working tree clean. Nothing under `.superpowers/` committed;
nothing created under `docs/superpowers/`. MERGE_HEAD absent before both commits
(checked via `git rev-parse --git-path MERGE_HEAD`; `.git` is a file in this worktree).
Explicit paths only; bare `git status` read before each commit.

---

## Task 8 - "Already sent" ignores skipped slots (commit f199dc4c)

Files: `app/src/repos/broadcastsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/broadcastsRepo.integration.test.ts`, `app/test/broadcastApi.test.ts`.

Stop-and-report check: the harness double's `priorRecipientContactIds` had exactly the
shape the plan assumes (loop over `broadcasts.values()`, filter `unitId` + `sent`/`sending`,
`Object.keys(b.recipients ?? {})`). No stop.

### Red (seen before any source change)

- `npx vitest run test/broadcastsRepo.integration.test.ts` -> EXIT=1, `1 failed | 20 passed (21)`:
  ```
  AssertionError: expected [ 'c-both', 'c-failed', ...(3) ] to deeply equal [ 'c-both', 'c-failed', 'c-sent' ]
  + "c-legacy",
  + "c-skipped",
  ```
- `npx vitest run test/broadcastApi.test.ts` -> EXIT=1, `1 failed | 66 passed (67)`:
  ```
  share-skip-fix D5: a tenant whose only earlier slot was SKIPPED is NOT "already sent"; a failed one still is
  AssertionError: expected true to be false // Object.is equality
   > test/broadcastApi.test.ts:1227  expect(byId.get(skipped.contactId)?.alreadySentThisProperty).toBe(false)
  ```
  (Exactly the plan's stated red: c-skipped / c-legacy in the union; `alreadySentThisProperty`
  true for the skipped tenant.)

### Implementation

- Repo inner loop: `for (const [key, slot] of Object.entries(b.recipients ?? {}))`, `if
  (slot.status === 'skipped') continue; prior.add(key);` with the plan's comment verbatim.
  `failed` still counts (interim rule, spec D5).
- Interface doc: ONLY `priorRecipientContactIds`'s doc (current :354-362; was :315-322 per N3)
  - its first sentence now says "the recipient keys with a NON-SKIPPED slot ... (`failed`
  still does)". `listByUnit`'s doc untouched. The untouched line with a pre-existing em dash
  (":359 ... (nothing flagged) - the") stays as it was.
- Harness double: the plan's body verbatim (same skip exclusion as the real repo).
- No route change (`app/src/routes/broadcasts.ts` untouched): both readers (per-candidate
  flag and `priorRecipientContactIds` in the response) come from the one repo call.

### Green

- broadcastsRepo.integration.test.ts: EXIT=0, `Tests 21 passed (21)`.
- broadcastApi.test.ts: EXIT=0, `Tests 67 passed (67)`.
- `npm run typecheck` (post-Task-8): EXIT=0. `npx eslint` on the four files: EXIT=0.
- ASCII (added lines, 4 files): 0 / 0 / 0 / 0.

---

## Task 9 - review list: seeded rows stay checked, hand-adds are seeds, the note (commit ea0f5318)

Files: `dashboard/src/routes/broadcasts/RecipientPreview.tsx`, `RecipientPreview.test.tsx`.

Stop-and-report checks: `renderPreview` / `previewOf` / `candidate` / `tenant` all accept
the plan's options unchanged. The `resolvedFor` tests stayed green before and after.

### Red (seen before any source change) - EXIT=1, `3 failed | 33 passed (36)`

1. The REPLACED pin. Old test `annotates a manually-added tenant already-sent via
   priorRecipientContactIds (unchecked)` (asserted `not.toBeChecked()`) replaced by
   `share-skip-fix D5: a hand-added tenant who is already-sent is flagged AND starts CHECKED
   (a hand-pick is a seed)`:
   ```
   Error: expect(element).toBeChecked()
   Received element is not checked:
     <input aria-label="Prior Sent - already sent" class="_checkbox_1dd163" type="checkbox" />
    > RecipientPreview.test.tsx:304  expect(within(row).getByRole('checkbox')).toBeChecked();
   ```
   (the aria-label's dash is the component's pre-existing em dash; transliterated here)
2. `share-skip-fix D5: Select all keeps SEEDED already-sent rows checked (preview seeds and
   hand-adds), still skips unseeded ones`:
   ```
   Error: expect(element).toBeChecked()
   Received element is not checked:  <input aria-label="Seeded - already sent" ... />
    > RecipientPreview.test.tsx:244  expect(box('Seeded')).toBeChecked(); // a preview seed
   ```
3. `share-skip-fix D5: the note states the seeded-row rule`:
   ```
   TestingLibraryElementError: Unable to find an element with the text: Flagged tenants you
   picked stay checked; "Select all" skips the others..
   ```
   (Exactly the plan's stated red.)

### Implementation (plan Step 3, with the adjudicated changes)

- `Row.seeded: boolean` (after `added?`), plan doc verbatim.
- `initialRows`: `seeded: c.seeded,` after `hasConsent`; `checked` line unchanged
  (`c.has_consent && (c.seeded || !c.alreadySentThisProperty)`).
- `selectAll`: `checked: r.hasConsent && (r.seeded || !r.alreadySentThisProperty)`, plan doc.
- `addTenant` appended row: `checked: true`, `seeded: true`, plan comment verbatim.
- Note: `Flagged tenants you picked stay checked; &quot;Select all&quot; skips the others.`
  (renders byte-exact as the Global Constraints string; the test's exact getByText passes).
- Header comment (N1): SPLICED - kept "(auditable: staff can see who's left out and re-check
  them)." and "A live selected count drives "Send to N tenants", which posts the EXACT checked
  contactIds.", replaced only the already-sent sentence with the plan's 5 lines.
- `initialRows` doc (orchestrator addition, was :66-67 with an em dash): one ASCII sentence -
  an already-sent row starts UNCHECKED unless SEEDED (stays checked, D5), a no-consent row is
  never checked, everyone else starts checked.
- Test file header (plan "lines 2-7"): lines 3-5 reworded (UNLESS seeded; Select-all skips
  UNSEEDED already-sent rows; a hand-add is a seed). Lines 1 and 7 (pre-existing non-ASCII)
  untouched.

### Green

- RecipientPreview.test.tsx: EXIT=0, `Tests 36 passed (36)`. Verbose run confirms all 4
  `resolved 1:1 audience guard` tests pass and the 3 D5 tests pass.
- Whole folder `npx vitest run src/routes/broadcasts`: EXIT=0, `Test Files 11 passed (11)`,
  `Tests 147 passed (147)` (resolveTemplate 7, broadcastFormat 12, useBroadcastResults 5,
  StatChips 12, AudienceFilters 9, MessageEditor 5, BroadcastResults 11, BroadcastsList 11,
  BroadcastComposer.prefill 2, RecipientPreview 36, BroadcastComposer 37).
- `npm run typecheck` (post-Task-9): EXIT=0. `npx eslint` on the two files: EXIT=0.
- ASCII (added lines): 0 / 0.

---

## Final verification on HEAD ea0f5318 (verbatim exit codes)

- `npm run typecheck` -> TYPECHECK_EXIT=0
- `npm run smoke` -> SMOKE_EXIT=0 (`smoke-dist: OK - 1413 import specifier(s) across 248
  emitted file(s) resolve under plain Node.`)
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js'
  '*.mjs' '*.cjs')` (merge base bbaad87d, 28 files) -> ESLINT_EXIT=1, output verbatim:
  ```
  W:\tmp\share-skip-fix\app\src\lib\seed\matrix.ts
    134:7  error  'DEADLINE_TYPES' is assigned a value but only used as a type. Allowed unused vars must match /^_/u  @typescript-eslint/no-unused-vars

  W:\tmp\share-skip-fix\app\test\importApply.integration.test.ts
    745:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
    824:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any

  3 problems (3 errors, 0 warnings)
  ```
  All three are the KNOWN pre-existing baseline errors named in the brief. ZERO errors in
  any slice-3 file (broadcastsRepo.ts, twilioWebhookHarness.ts, broadcastsRepo.integration
  test, broadcastApi test, RecipientPreview.tsx, RecipientPreview.test.tsx). No new error.
- ASCII, `git diff -U0 bbaad87d..HEAD -- <file> | grep '^+' | grep -v '^+++' | tr -d
  '\11\12\15\40-\176' | wc -c`: broadcastsRepo.ts 0, twilioWebhookHarness.ts 0,
  broadcastsRepo.integration.test.ts 0, broadcastApi.test.ts 0, RecipientPreview.tsx 0,
  RecipientPreview.test.tsx 0 (also 0 for each over 871bb3a8..HEAD).
- Not run (per brief): full `npm test`, `npm run e2e`, `npm run e2e:session`.

## Deviations (all comment-only) and why

1. Task 8: also refreshed the 4-line comment at the TOP of the repo method
   `priorRecipientContactIds` (it said "union of every sent/sending broadcast's recipients
   KEYS", stale after D5) - now "..., skipped slots excluded (share-skip-fix D5, below)".
   Reflowing it touched the pre-existing arrow line, so that line was rewritten ASCII
   ("->"). Keeps the method comment in step with the double's reworded comment.
2. Task 9: the kept "A live selected count drives ..." sentence is reflowed onto two lines
   (content unchanged) because the old lines 10-11 split it mid-line after the replaced text.
3. Commit trailer is `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
   (the model the session's attribution reminder names; matches the slice-2 commits).

## Noticed, not changed

- `dashboard/src/api/types.ts:3002-3004` (PreviewCandidate doc): "`alreadySentThisProperty`
  is a SOFT flag (a prior sent/sending broadcast for this unit already included them)" is now
  imprecise - a skipped slot no longer counts. Outside Task 8/9's file lists; suggest the
  whole-branch review or a later task that touches types.ts add "in a non-skipped slot".
- `addTenant` dedupe edge (pre-existing, plan silent): picking, via "Add a tenant", a tenant
  who is ALREADY listed as an unseeded flagged (unchecked) filter row is a no-op - the row
  stays unchecked and unseeded, and no seed PATCH is sent (so the server does not see it as a
  seed either). Spec D5's "a hand-picked tenant is a seed from the moment staff add them"
  could be read to cover this; flag for the planner/reviewer, not changed here.
- Stale comments reserved for Task 12 left alone (current lines): RecipientPreview.tsx:68
  (resolvedFor doc "Hi Brianna, ..."), :130 ("the body names ONE tenant"), :444 ("written for
  one named tenant"); RecipientPreview.test.tsx:542 (resolved describe comment).
- e2e (read-only check, not run): broadcasts.spec.ts:171-187 (Tasha = unseeded flagged ->
  unchecked; a non-prior added row -> checked) and matching-entry-points.spec.ts:222-228
  (added row -> checked) still hold under the new rule; no spec pins the old note copy.
- `app/src/routes/broadcasts.ts:543` TODO (phone#-keyed hand-add annotation edge) unchanged
  and still true.
