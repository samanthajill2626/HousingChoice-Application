# Fix wave 1 - report (feat/matching-blast-rules, code review round 1)

- Scope: `r1-adjudications.md` FIX rows (ADV-3, ADV-5, ADV-9, CONF-2, CONF-3,
  CONF-6) plus the three FILE rows (ADV-1, ADV-2, ADV-4/CONF-4). CONF-1 stays
  the orchestrator's (lint record after the final gates).
- Base: 888d587c (tree clean, no MERGE_HEAD). Commits: 5bc9cfa8, 2b503eed,
  b58e5daf, af46ff63, 763c7d24, then this report alone.
- Run logs (gitignored): `.superpowers/sdd/fw1-*.log`, `fw1-eslint.json`.
- Not run, by instruction: root `npm test`, `npm run e2e`, smoke (the
  orchestrator re-runs every gate).

## Per item

| # | Finding | Commit | RED evidence | GREEN evidence | Files |
|---|---|---|---|---|---|
| 1 | ADV-5 | 5bc9cfa8 | `audienceResolution.test.ts` 1 failed / 23 passed: `expected [ 'c-mover', 'c-mover', 'c-o1' ] to deeply equal [ 'c-mover', 'c-o1' ]` | 24/24 | `app/src/services/audienceResolution.ts:150-151`, `:177-180`, `:199-207`; test `app/test/audienceResolution.test.ts:250` |
| 2 | ADV-3 | 2b503eed | `RecipientPreview.test.tsx` 1 failed / 55 passed: `TypeError: Cannot read properties of undefined (reading 'map')` at `RecipientPreview.tsx:167:27` | 56/56, no controlled/uncontrolled warning left in the log | `dashboard/src/routes/broadcasts/RecipientPreview.tsx:139-143`, `:169-170`; test `RecipientPreview.test.tsx:1161` |
| 3 | CONF-2 (tests only) | b58e5daf | mutant M8: 2 failed / 153 passed - exactly the two new tests, `expected 400 to be 503`; identity copy 155/155 | real module 155/155 | `app/test/broadcastApi.test.ts:3741`, `:3761` |
| 4 | CONF-3 (test only) | b58e5daf | mutant M9 (run with `repoPagingWiring.test.ts`): 1 failed / 10 passed - the new test, `expected [ 't1' ] to deeply equal [ 't1', 't2' ]`; identity copy 11/11 | real module 11/11 (the two files) | `app/test/toursRepoListByStatusRange.test.ts:59` |
| 5 | CONF-6 (comment) | af46ff63 | n/a | n/a (comment only; lint 0) | `app/src/routes/broadcasts.ts:524-526`, `:727-730` |
| 6 | ADV-9 (one line) | 763c7d24 | n/a | n/a | `docs/issues/unknown-queue-cap-starves-needs-review.md:29` |
| 7 | FILE ADV-1, ADV-2, ADV-4/CONF-4 | 763c7d24 | n/a | `npm run issues` exit 0, no warnings; all three indexed (med bug, med decision, low bug) | `docs/issues/matching-default-check-stale-bundle-window.md`, `docs/issues/matching-prefill-org-list-failure-fails-open.md`, `docs/issues/matching-composer-422-unmatched-member-clears-filter.md` |

### Mutant method (items 3 and 4)

A COPY of the module under a throwaway `app/src/zz-fw1-mut/` (the original's
depth, so its relative imports resolve; `cmp` proved each copy identical
before mutating), wired in by a throwaway `app/zz-fw1-vitest.config.ts` that
spreads `vitest.config.ts`, drops `globalSetup` (both files are in-memory:
FakeWorld and a recording doc client) and adds ONE `resolve.alias` -
`^\./broadcasts\.js$` (the one importer, `src/routes/api.ts`) or
`^\.\./src/repos/toursRepo\.js$`. Each mutation was applied by a scratchpad
script that refuses unless its anchor occurs exactly once (M8: the empty and
truncated refusals inserted right after
`const audience = await resolveAudience(broadcast.audience_filter);` in path
(c); M9: `} while (lastKey !== undefined && from !== undefined);` in
`listByStatus`). Order per mutant: identity copy green, mutant red, copy
deleted. The copies, the directory and the config are deleted; no tracked
module was edited; `git status` showed only the two test files afterwards.

## Final checks (on 763c7d24)

- App, together once: `audienceResolution`, `broadcastApi`,
  `blastAudienceRules`, `toursRepoListByStatusRange` - 4 files, 233 passed
  (24 + 155 + 49 + 5), exit 0.
- Dashboard `src/routes/broadcasts/` once - 16 files, 312 passed (311 + 1),
  exit 0.
- `npm run typecheck` (root, bare) - exit 0.
- ESLint JSON on every touched `.ts`/`.tsx` (`audienceResolution.ts`,
  `broadcasts.ts`, `audienceResolution.test.ts`, `broadcastApi.test.ts`,
  `toursRepoListByStatusRange.test.ts`, `RecipientPreview.tsx`,
  `RecipientPreview.test.tsx`): 0 errors, 0 warnings each. Re-measured
  alongside: `BroadcastComposer.tsx` exactly 2
  `react-hooks/set-state-in-effect` (`:394:5`, `:413:5`) and
  `useComposerDraft.ts` exactly 1 `react-hooks/refs` (`:151:3`) - unchanged,
  both pre-existing. eslint stderr empty.
- ASCII: every added line of every commit (grep `[^\x00-\x7F]` on `+` lines:
  none); the three new issue files 0 non-ASCII bytes each.

## Judgment calls and findings (none silently taken)

1. ADV-5 - where the de-duplication sits. The `seen` check runs AFTER every
   fence, right before the push, so "first row wins" means the first RESOLVED
   row. A mover whose searching-read row was fenced out (say opted out at that
   instant) and whose onboarding-read row passes resolves from the later
   read; otherwise the searching row wins, as the test pins (`status:
   'searching'`). This follows the brief's "de-duplicate the resolved
   audience". The opposite move (onboarding to searching mid-walk, possibly
   missed in both reads) is documented in the comment, not pinned by a test
   (a pin would assert the miss as a fact).
2. ADV-3 - both halves are load-bearing, and the second half closes a defect
   of its own. With only the `tourHolds` guard applied, the regression test
   was still RED at the Select all assertion (`RecipientPreview.test.tsx`
   after a hand check): `checked: undefined` makes the checkbox
   UNCONTROLLED, React logged "changing an uncontrolled input to be
   controlled" and back, and after Select all the box stayed visibly checked
   while `checkedCount` did not count it. `=== true` fixes both. The fail
   safe also starts a SEEDED row unchecked on an old-server payload (no
   client rule reintroduced, as ruled); the test pins that. The `tourHolds`
   guard has the one-line rollback-window comment; the `checkedByDefault`
   line extends the existing D5 comment to three lines. The wire type is
   unchanged.
3. CONF-2 - beyond the brief's assertions, each test also spies
   `queueAdapter.enqueue` and asserts it was never called (a direct "nothing
   enqueued"), plus `world.sent` empty after `settle()`.
4. CONF-6 - WIDENED by one site, comment only: the identical wrong sentence
   also sat in `buildReviewRows`' doc comment (`broadcasts.ts:727-730`), so
   both are corrected; leaving one would have the file contradict itself.
   The plan's binding 2.5 comment still says the old order - not edited (a
   binding contract document, outside this wave).
5. ADV-9 - exactly one added line, as instructed; the issue's `updated:`
   frontmatter (2026-08-26) was NOT bumped, to keep it one line. Bump it if
   the convention should win.
6. Filed issues - refs cite the line numbers AFTER this wave. The ADV-1 issue
   adds one reading of the reviewer's marker option: it covers this window
   only if it ships in the same deploy as the rule move. The ADV-2 issue
   paraphrases spec D3's failed-list sentence (it cites
   `spec:288-290`) rather than nesting the notice copy inside a quote.

## Post-merge note to carry into the handback

- Reload every open dashboard tab after the deploy (ADV-1,
  `matching-default-check-stale-bundle-window`).
- Cameron's eye: `matching-prefill-org-list-failure-fails-open` (spec D3's
  explicit fail-open; hold + Try again vs verbatim prefill).

## Not done

Nothing in scope. Out of scope by ruling: CONF-1 (orchestrator, after the
final gates); ADV-6 rejected; ADV-7, ADV-8, CONF-5 notes.
