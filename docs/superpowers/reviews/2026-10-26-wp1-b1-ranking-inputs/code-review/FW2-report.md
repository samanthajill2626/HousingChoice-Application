# FW2 report - WP1 B1 code review R2 fix wave (implementer, 2026-10-27)

Scope: the binding list FW2-1, FW2-2, FW2-3 in `R2-adjudications.md` (this
directory); source findings R2-1, R2-2, R2-3 in `R2-review.md`. Base
512cf98d. Nothing else changed; FW-9 is untouched. Status: DONE - all 3
items.

## Commits

| Commit | Items |
|---|---|
| e385c6b5 | FW2-1 |
| 8e19c05c | FW2-2 |
| 13674070 | FW2-3 |
| f7d4a94f | FW2-2 follow-up: the form's two new comment tags read "WP1 B1 FW-11" / "WP1 B1 FW2-2" (comment only) |
| (this report) | records |

## How RED and the reverted-fix proof were taken

- Every app vitest run was prefixed `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`
  (G1). No probe run, no API call; ANTHROPIC_API_KEY was never read or printed.
- RED: the new tests were written first and run against the unfixed code;
  the reason was read from the failing assertion. GREEN: the fix, with the
  tests unchanged.
- Reverted-fix proof: after GREEN, the fix lines were put back to their
  pre-fix form with the Edit tool, the same files re-run, then restored
  with the Edit tool and re-run green. Every new regression test failed
  with its fix reverted; the only passes in those runs are the tests marked
  PIN (green on arrival by design).

## FW2-1 (R2-1 MEDIUM) - the Notes retry guard compares whole lines

What changed (HEAD line numbers):
- `app/src/services/extraction/apply.ts:218-222` `LEADING_AUTO_PREFIX =
  /^\[Auto - [^\]]+\]/` - the shape `lib/caseworkers.ts` AUTO_PREFIX also
  reads.
- `apply.ts:306-313` the guard: the existing notes are split into lines,
  each trimmed, its leading prefix removed, trimmed again, and the lines
  fenced by `\n` on both sides; a candidate (each of its own lines trimmed,
  fenced the same way) is present only when that fenced block occurs in the
  fenced existing lines. A one-line candidate is dropped only when it EQUALS
  a whole line; a candidate holding a line break must match a run of whole
  lines.
- `apply.ts:284-297` rule 4 of the doc rewritten (whole lines, what is
  kept, the exact-words flip back that stays dropped); `:237`
  `existingNotes` doc; `:239-245` `prefix` doc.
- `app/src/services/extraction/prompt.ts:181-184` the change-of-mind bullet:
  "a CHANGE of mind is / a new noteLine that SAYS the view changed, e.g.
  "now likes it" or / "back on the fence" - a line identical to an earlier
  notes line is / never written again, so a change back worded as before is
  lost." ASCII; the existing pin "a CHANGE of mind is" stays on one line, as
  does every new pinned phrase.
- `app/scripts/extraction-prompt-probe.ts:283-289` `PROBE_NOTE_PREFIX` doc
  (comment only: it described the old `<prefix> <line>` lookup).
- Tests: `app/test/extractionNoteLines.test.ts:101-161` new describe, 5
  tests (3 RED, 2 PIN); `app/test/extractionApply.test.ts:1783-1791` (1
  RED, the Notes box as written); `app/test/extractionSchema.test.ts:867-873`
  (1 RED, the prompt wording).
- Comment-only edits to existing tests, assertions unchanged:
  `extractionNoteLines.test.ts:67-68` and `extractionApply.test.ts:1771-1772`
  said the guard matches a single letter inside "seed" - stated reason in
  each: "written for the substring guard ... FW2-1 compares whole lines; the
  words stay."

No existing assertion changed. The existing guard tests all pass unchanged:
the WI5 cap slot, the bare-line drop (D4 C1), the F1 retry idempotency
(apply twice, nothing the second time), the D5.3 appendedLines guard (Jul 15
line, Jul 16 run), and extractionJob's feedback counts (Jul 16 line, Jul 17
run).

RED (new tests, unfixed code): `extractionNoteLines`, `extractionApply`,
`extractionSchema` -> 5 failed / 195 passed, exit 1. The four guard tests
received `[]` (the substring test dropped the contained line); the prompt
test found no "a new noteLine that SAYS the view changed". The two PINs
(identical earlier line under any date, same-run retry) passed on arrival.
GREEN: 200 / 200, exit 0.

Reverted-fix proof: the guard put back to
`existingNotes.includes(`${prefix} ${line}`) || existingNotes.includes(line)`
and the old bullet "a new noteLine." restored -> the same 5 failed (5 / 195,
exit 1). One more check: a naive per-line equality guard (no handling of a
candidate holding a line break) failed exactly the line-break retry PIN (1
failed / 16 passed) - the PIN guards that choice. Restored -> green.

Divergences:
1. "The two R2-1 reproductions append" cannot hold literally together with
   the ruling's mechanism. Reproduction (b) is used verbatim (an Oct 20 "112
   Oak St, Decatur: likes it" line, the candidate "12 Oak St, Decatur: likes
   it" - now appends). Reproduction (a) as R2 wrote it (Oct 20 "on the
   fence", Oct 22 "likes it", Oct 27 "on the fence" again) is a flip back to
   EXACTLY the Oct 20 words, which the ruling drops ("an identical earlier
   line (any date) ... dropped"; For Cameron: "a flip back to EXACTLY an
   earlier line's words is still dropped"). I followed the mechanism: the
   append test for (a) uses R2-1's own contained form ("412 Oak Ave,
   Decatur: likes it" after an Oct 20 "... likes it, worried about the
   commute" and an Oct 22 "... on the fence" - a change of mind contained in
   earlier wording), and R2's verbatim (a) is PINNED as dropped, beside "...
   back on the fence" appending. Keeping the verbatim flip would need R2's
   same-date-only guard, which gives up verbatim-repeat dedupe across dates.
2. The prefix removed is `[Auto - <anything but ]>]`, not strictly
   `<Mon D>`: a superset that matches every autoPrefix output and agrees with
   `lib/caseworkers.ts`. A staff-typed `[Auto - ...]` prefix is removed too
   (harmless).
3. A candidate holding a line break is handled (fenced runs of whole lines):
   the parser keeps text unmodified, so the model can emit a `\n`, and plain
   per-line equality would let a retried run append that line twice -
   breaking F1, which the ruling says holds. Pinned.
4. `NoteLineFilterInput.prefix` stays REQUIRED though the guard no longer
   reads it: plan PR30 fixes the S6 seam (the probe passes
   `PROBE_NOTE_PREFIX`), and removing it would change that seam and the
   test helper for no behavior. Documented on the field. A reviewer may call
   it dead input; removal is a small follow-up across apply.ts, the probe's
   `writtenLines` and the test helper.
5. No guard-drop counter on the run record: R2 suggested one; the binding
   FW2-1 does not include it.

Risks:
- A staff Notes line that contains a candidate now gets the AI line
  appended beside it (the accepted trade-off; pinned).
- The comparison is exact apart from the trim: an earlier line differing
  only in case or inner spacing is not a duplicate (the substring test was
  exact too).
- The prompt text changed, so the extraction prompt fingerprint changed.
  Both gate runs must be on the post-FW2 commit (FW1 report: no record
  exists yet).

## FW2-2 (R2-2 LOW) - the browser refuses an unparseable portion first

What changed:
- `dashboard/src/routes/contact/ContactEditForm.tsx:292-301` the FW-11
  comment: defense in depth only; the form sets no `noValidate`, so native
  validation refuses an entry the number input cannot parse (value '' with
  `validity.badInput` set) with the browser's own message (Chromium: "Please
  enter a number.") before Save runs - no role="alert", no request; only a
  form or test that skips native validation reaches the check; parseable bad
  values (12.5, -5, 20001) reach Save and show the server's copy in the
  form's role="alert".
- `ContactEditForm.tsx:490-494` the onSubmit comment says the same in one
  line.
- `e2e/support/selectors.md:60` the portion text now reads: a PARSEABLE bad
  value (12.5, -5, 20001) is refused at Save in the form's `role="alert"`
  with the server's copy (`tenant-matching-inputs.spec.ts` drives the
  fraction); an unparseable entry is refused by the BROWSER's native
  validation bubble before Save (no `role="alert"`, no request; R2-2);
  Chromium drops most unparseable keystrokes as typed (`1,200` lands as
  `1200`, `abc` types nothing), `1e` stays unparseable; FW-11's
  `validity.badInput` check is defense in depth. Still one table row (4
  pipes), ASCII (the line was ASCII before).
- f7d4a94f: the form already carries the unknown-inactive mission's "code
  review R2 FW2-2" (568402b4, Save off after a 409), so a bare "FW2-2" was
  ambiguous; the two new tags now read "WP1 B1".

RED / reverted-fix: not applicable (comments and docs only; no behavior).
`ContactEditForm.test.tsx` 131 / 131 before and after.

Not changed (scope; named so nobody re-diagnoses them):
- `dashboard/src/routes/contact/ContactEditForm.test.tsx:2213-2217`, the
  FW-11 test comment, still lists "1.2.3" and "a typed 1,200 in some
  browsers" as unparseable entries; R2 saw Chromium land them as 1.23 and
  1200. The two jsdom tests' names ("stops Save with the server's message")
  are true where they run (jsdom).
- `dashboard/src/routes/contact/tenantMatchingInputs.ts:104-113`
  (buildTenantMatchingPatch's doc) - accurate for the function.
- The Chromium behavior in selectors.md is R2's observation (Chromium
  155.0.8059.12, R2-review.md R2-2 proof a), not re-run here; Firefox not
  observed.

## FW2-3 (R2-3 LOW) - the probe's git checks certify the measured code only

What changed (`app/scripts/extraction-prompt-probe.ts` at HEAD):
- `:92` `spawnSync` replaces `execFileSync` (a `diff --quiet` exit 1 is an
  answer, not an error).
- `:1200-1245` new exports: `GitRunner` (`git -C <root> <args>` -> `{ status,
  stdout }`, throws only when git cannot start), `GitInfo`,
  `MEASURED_PATHS = ['app/src', 'app/scripts']`, `gitInfoOf(git, root)`
  (`rev-parse HEAD` plus `status --porcelain --untracked-files=no -- app/src
  app/scripts`; a non-zero exit or a git that cannot start still reads
  'unknown (git failed)', not dirty) and `measuredCodeChanged(git, root,
  before, after)` (dirty flag flipped -> change; same commit -> no change;
  moved commit -> `diff --quiet <before> <after> -- app/src app/scripts`,
  non-zero or a throw -> change). `checkoutChanged` is gone (no other user).
- `:1310-1312` `NeverWrittenRecordInput.after` is set only when the measured
  code changed; `:1348` the renderer prints it whenever set (it can no
  longer judge the change without git).
- `:1585-1586` `ProbeCliDeps.git` replaces `gitInfo`; `:1611-1616` `runGit`;
  `:1649` the default dep.
- `:1711-1715`, `:1764-1765`, `:1780` the never-written run; `:1814` each
  `--baseline` side, same scope.

Tests (`app/test/extractionPromptProbe.test.ts`):
- `:62-103` `fakeGit` / `FakeCheckout`: one mutable checkout per root (a
  test changes it mid-run from its driver answer); a pathspec after `--` is
  honored as git honors one (the path or anything under it); a diff answers
  from per-commit-pair changed files, or a fixed exit code; an unknown
  command throws.
- `:149` the harness default dep, migrated.
- Migrated FW-6 tests `:1150-1200`, intent unchanged, reason stated in each
  test (the stub is now git commands, not `{ commit, dirty }`): the
  read-before-and-after test asserts the read pair (rev-parse, status) first
  and last and 4 git commands (no diff for an unmoved commit) instead of 2
  `gitInfo` calls; "a commit that changes during the run" now moves the
  commit with an app/src change; "tracked files modified during the run"
  modifies an app/src file.
- New `:1202-1282` (never-written): the record appended mid-run -> exit 0,
  a clean Commit line (RED); docs modified before the run -> no "(tracked
  files modified)" (RED); a docs-only commit mid-run -> exit 0 (RED); the
  exact git commands: rev-parse, `status ... -- app/src app/scripts`, twice,
  then `diff --quiet <A> <D> -- app/src app/scripts` (RED); PIN a moved
  commit changing app/scripts fails; PIN a diff git cannot answer (128)
  fails.
- New `:1487-1511` (`--baseline`): docs modified on both sides -> neither
  the Branch nor the Baseline line is marked (RED); PIN app/src modified on
  the baseline still marks it.

Refactor first (git reads behind the injected runner, no scope change,
existing tests migrated): 119 / 119, exit 0 - R2's own count. RED (new
tests, unscoped checks): 5 failed / 122 passed, exit 1 - the three
records-only runs exited 1 or carried the label, and the Branch line was
marked; the argv test failed on the run's exit 1 (the commit move counted).
GREEN: 127 / 127, exit 0. Reverted-fix proof: pathspecs dropped from the
status read and the diff step bypassed (a moved commit = a change, as
before) -> the same 5 failed (5 / 122, exit 1); restored -> green.

Real-git sanity (plain git reads in this worktree, no probe run):
`git diff --quiet e385c6b5 8e19c05c -- app/src app/scripts` (FW2-2's
dashboard + e2e commit) exit 0; `git diff --quiet 512cf98d e385c6b5 --
app/src app/scripts` (FW2-1) exit 1; a bad revision exit 128; the scoped
status listed only `app/scripts/extraction-prompt-probe.ts` while it was
modified.

Divergences:
1. The injected dep changed shape (`gitInfo` -> the raw `git` runner) so the
   tests can see the pathspecs and drive the diff - what "tests through the
   injected git dep" needs. The three FW-6 tests and the harness default
   were migrated (intent unchanged; reasons in the tests).
2. The label is unchanged: "(tracked files modified)" now means a tracked
   file under app/src or app/scripts. Not renamed (an existing assertion
   and the plan text use it; the ruling names no label); a modified doc no
   longer shows it, which is the point.
3. A moved commit with no measured difference: the record certifies the
   BEFORE commit and prints no "after" line. A diff git cannot answer fails
   the run (conservative).

Residual risk (pre-existing FW-6 behavior, not changed): a checkout already
dirty under app/src before the run and edited further during it reads
dirty at both reads, so the check sees no change; the record already marks
such a run "(tracked files modified)".

## Commands (all exit codes as shown)

| Command | Result |
|---|---|
| vitest `extractionNoteLines`, `extractionApply`, `extractionSchema` - FW2-1 RED | exit 1, 5 failed / 195 passed |
| same - FW2-1 GREEN | exit 0, 200 / 200 |
| same - FW2-1 fix reverted | exit 1, 5 failed / 195 passed |
| vitest `extractionNoteLines` - naive per-line guard | exit 1, 1 failed / 16 passed (the line-break PIN) |
| vitest 11 extraction files after FW2-1 (`extractionNoteLines`, `extractionApply`, `extractionSchema`, `extractionJob`, `extractionPromptProbe`, `extractionAdapter`, `extractionDecisions`, `caseworkers`, `extractionJobDraftGuard`, `contactExtractionRun`, `extractionProbeNeverWritten`) | exit 0, 594 / 594 |
| dashboard vitest `ContactEditForm.test.tsx` after FW2-2 | exit 0, 131 / 131 |
| vitest `extractionPromptProbe` - FW2-3 refactor only | exit 0, 119 / 119 |
| same - FW2-3 RED | exit 1, 5 failed / 122 passed |
| same - FW2-3 GREEN | exit 0, 127 / 127 |
| same - FW2-3 fix reverted | exit 1, 5 failed / 122 passed |
| final: the same 11 app files at 13674070 | exit 0, 602 / 602 |
| final: dashboard `ContactEditForm.test.tsx` at f7d4a94f | exit 0, 131 / 131 |
| `npm run typecheck` (bare, root) after FW2-1, after FW2-3, and at f7d4a94f | exit 0 each, 0 TS errors |
| `npx eslint` per item, then once over every touched .ts / .tsx (`git diff --name-only --diff-filter=d 512cf98d HEAD -- '*.ts' '*.tsx'`) | exit 0 |
| ASCII: `git diff -U0 512cf98d HEAD \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c` | 0 |
| `\u` escapes in the touched app files (`grep -cF '\u'`) | 0, as at base |

Not run (per the dispatch): root `npm test`, `npm run e2e`.

## For Cameron (from R2-adjudications, now built)

Spec D4 keeps "the verbatim retry guard" as is; FW2-1 changes it from a
substring test to a whole-line test, because the substring form silently
dropped feedback D5.2 requires. Both purposes hold (a retried run appends
nothing; a verbatim repeat is not written twice). One case stays: a flip
back to EXACTLY an earlier line's words is dropped; the prompt now asks the
model to word a change of mind as a change ("now likes it", "back on the
fence").

## Next step (orchestrator)

A fresh R3 reviewer on 512cf98d..HEAD. Open for a ruling only if wanted:
removing the now-unread `NoteLineFilterInput.prefix` (FW2-1 divergence 4),
and the FW-11 test comment's browser examples (FW2-2 "Not changed").
