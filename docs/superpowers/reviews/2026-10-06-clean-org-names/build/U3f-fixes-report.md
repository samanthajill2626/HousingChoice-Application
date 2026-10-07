# U3f report - build rulings B-1 and B-2 (S3 service fixes)

- Implementer: U3f (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 44eab45e (U3 report + rulings) through 4cb85a4b - 2 commits,
  one per ruling. Worktree clean after the last commit. Nothing left running.
- Dashboard untouched (the `org_rewrite_target_gone` copy change is S11's).

## Per fix

| ruling | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| B-1 | 3a0c9bdd fix(org-names): check a new spelling against the entry's other spellings (compound test) | (a) "AHA DCA" on DCA: `promise resolved "{ orgId: 'org-2', ...(8) }" instead of rejecting`; (b) "Atlanta Housing Authority AHA" on Atlanta: rejected `OrgHttpError: org_spelling_refused` (default branch = compound by elimination); 2 PINs green | orgNamesService 27/27 | 4 org suites 100/100 (0), typecheck 0 |
| B-2 | 4cb85a4b fix(org-names): Run again refuses a definition whose from-text is now a listed name | (a) added name and (b) name variant: `promise resolved "{ lastRewrite: { jobId: 'id-1', ...(8) } }" instead of rejecting`; PIN green | orgRewriteService 24/24 | 4 org suites 103/103 (0), typecheck 0 |

Final at HEAD 4cb85a4b: `cd app; npx vitest run test/orgNamesService.test.ts
test/orgRewriteService.test.ts test/orgNames.test.ts test/orgRecords.test.ts`
-> 4 files, 103/103, exit 0 (baseline before U3f: 96/96). Root
`npm run typecheck` -> exit 0. Lint preview (not a required gate here):
`npx eslint` on the 4 touched files -> exit 0, no findings.

Commit checks: bare `git status` read first as its own command, no
MERGE_HEAD, explicit paths only (the two files of each fix), ASCII message
(0 non-ASCII chars each) ending with the `Co-Authored-By: Claude Opus 5.5
<noreply@anthropic.com>` trailer (verified with `%(trailers)`). Added diff
lines: 0 non-ASCII. DynamoDB Local was up (vitest globalSetup); never
started, stopped or restarted. Logs: `.superpowers/sdd/u3f-*.log`.

## What changed

- B-1, `app/src/services/orgNames.ts` updateSpellings: (1) trim, drop blanks,
  de-duplicate normalized (first wins) into `kept`; (2) the 20 cap on `kept`;
  (3) each `kept` spelling NOT already on the entry is checked with
  `checkOrgSpelling` against a probe of the entry whose spellings are `kept`
  minus the one under test. Existing spellings skip the check; confirmShared
  and every refusal shape unchanged.
- B-1 tests (`app/test/orgNamesService.test.ts`, on the real starting list
  the fake creates on first read): (a) "AHA DCA" on DCA -> 409
  org_spelling_refused problem compound, nothing written (also asserts POST
  /check already says compound); (b) "Atlanta Housing Authority AHA" on
  Atlanta accepted, and then resolves to Atlanta; (c) PIN every starting entry
  re-sent unchanged with no confirm (AHA and MHA are shared); extra PIN: an
  entry AT the 20 cap swapping one spelling for a new one is accepted (a probe
  carrying the CURRENT spellings would refuse it too_many).
- B-2, `app/src/services/orgRewrite.ts` runAgain, inside the same
  `list.mutate` after the target check and before the re-queue: 409
  `{ error: 'org_rewrite_target_gone' }` when any stored from-text
  normalizes equal to the NAME of an entry whose kind
  `KINDS_FOR_FIELD[f]` accepts for some stored `f` in `fields`, unless that
  entry's name is `toName`. Interface JSDoc on `OrgRewriteService.runAgain`
  and the in-body comment updated to say so.
- B-2 tests (`app/test/orgRewriteService.test.ts`, failed state seeded as the
  existing runAgain tests do; the list as it changed since is seeded too):
  (a) failed Clear of agency "Hope House" (not on the starting list), agency
  "Hope House" now on the list -> 409, nothing enqueued, lastRewrite still the
  failed one, version 1; (b) the same for value "hope-house" (name variant)
  -> 409; (c) PIN a failed Use of "atlanta housing authority" -> Atlanta
  re-runs with the same definition under id-1 and enqueues it; extra PIN case:
  a HOUSING AUTHORITY named "Hope House" does not block re-running the agency
  Clear (D3: the agency field accepts no housing authority).

## Divergences / decisions

1. B-1 moves the 20-cap check BEFORE the per-spelling checks (it was after).
   Reason: the probe now carries the other requested spellings, so for a
   21-spelling request it holds 20 and `checkSpelling` would answer
   `too_many` itself (same 409 org_spellings_full body). Cap-first keeps that
   path unreachable and the outcome deterministic. The accepted set is
   unchanged; only a request that is BOTH over 20 and carries a refused new
   spelling now reports org_spellings_full first (before: the spelling's own
   refusal).
2. Test values: B-1 uses the starting list (dispatch: "the starting list");
   B-2 uses "Hope House" because "Mercy Care" is ON the starting list.
3. Two extra PIN assertions beyond the dispatch's (c) - the cap swap (B-1)
   and the other-kind entry (B-2) - each pins a deliberate property of the
   new rule (entry as it will be; kind scoping per D3).

## Out of scope, noticed (no change made)

1. The plan still describes only the target check for
   `org_rewrite_target_gone`: plan 3.4 interface comment (plan line 356),
   the error table row (line 423) and the run-again route line (line 449).
   The worklist B-2 ruling supersedes them; S5 / S11 implementers transcribing
   those lines should carry the from-text case (S11's copy already does).
2. B-2's `toName` exception applies to any action carrying a `toName`, as
   ruled. It is reachable only for use / rename / merge: for move_to_agency /
   move_to_housing_authority `toName` is of the kind the field does NOT accept,
   and a split whose from-text normalizes to its `toName` would have been a
   name variant refused at start (409 org_value_is_name_variant), with
   `toName` unable to change without tripping the target check.
3. A from-text that normalizes to '' (a stored "-") can never match: no entry
   name normalizes to '' (D13, checkNewName org_name_invalid).
4. `app/src/services/orgRecords.ts:35-39` (the pass precondition: "services/
   orgRewrite.ts refuses those definitions") is now true for Run again as
   well; the cleanup script (S15) must keep to the same rule.
