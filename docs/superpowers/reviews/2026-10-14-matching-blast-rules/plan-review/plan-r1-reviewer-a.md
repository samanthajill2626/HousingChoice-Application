# Plan review round 1 - reviewer A (adversarial) - matching blast rules

Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md` (PLAN v1, tip ccc32a88)
Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` (rev 5)
Repo read at: `W:\tmp\matching-blast-rules` (branch base main @a2b3d80d; 0 behind main at review time)
Method: read sections 0-4 in full, every slice task in full (S1-S4), and checked
the task code and old_strings against the real files. Nothing was edited except
this file; no test, e2e or server was run.

## Verdict in one paragraph

The plan is unusually complete. Every spec decision (D1-D10, D3a, D3b), every
section 6 test item and every section 7 "places to update" entry maps to a
task, and the cross-slice seams I checked hold: the S1 -> S2 edits to
`app/src/routes/broadcasts.ts` either touch disjoint regions or carry an
explicit "re-read and apply on top" fallback (AR9, AR21, Task 2.5 C-Edit 8);
the preview wire S2 emits (`checkedByDefault` on every candidate, `tourHolds`
always present, `audienceRulesUnavailable` only when true) is exactly what S3
reads; and the copy S4's e2e asserts (caption as one element, `Reaches N
recipient(s)`, `Remove <name>` chips, the tour tag in its own span, the
lower-cased checkbox cue) is exactly what S3 renders. I found no BLOCKING or
HIGH defect. The findings below are one binding ruling with no executable
step, and several smaller literal-execution traps.

---

## 1. [MEDIUM] AR19 (lint backlog count) is binding but no task can execute it

**What is wrong.** Section 4 AR19 says: "If gate 5's baseline comparison shows
the branch REMOVED pre-existing errors (S3 expects 23 -> 21), Task 4.3 updates
the count in `docs/issues/lint-backlog-repo-wide.md` and in AGENTS.md's gate 5
paragraph". But:

- Task 4.3 (docs) runs BEFORE Task 4.4 (the five gates), so the condition
  "gate 5's baseline comparison shows ..." cannot be known when Task 4.3 runs.
- Task 4.3's file list (plan line 12217-12218) and its commit
  (`git add documentation/GLOSSARY.md RUNBOOK.md docs/issues/broadcast-audience-truncation-drops-searching-tenants.md`,
  plan line 12382) name neither `docs/issues/lint-backlog-repo-wide.md` nor
  `AGENTS.md`; no step in Task 4.3, 4.4 or 4.5 edits them.
- The S3 notes (plan line 10462) restate the same instruction as "update it in
  S4's docs pass if the count is kept current" - again with no task.

**Evidence.** AGENTS.md:222 ("reports 23 errors across 18 dashboard files");
`docs/issues/lint-backlog-repo-wide.md:20`, `:24` (the 23 count). S3 Task 3.5
Step 5 and Task 3.6 Step 5 expect `BroadcastComposer.tsx` to go from 4 to 2
`react-hooks/set-state-in-effect` errors, so the true repo count after merge is
21.

**What it implies.** A literal builder ships with AGENTS.md and the backlog
issue still saying 23 while the repo has 21 - the drift AGENTS.md itself warns
about ("When it reaches zero, promote this gate"). Either move the edit into a
step that runs after Task 4.4 Step 5 (with its own commit and the gates'
"Gate commit" note), or strike AR19.

## 2. [LOW] AR18 says sync-before-gates; Task 4.4 Step 0 still says "MAY"

**What is wrong.** AR18 (binding) makes the single main merge happen FIRST,
then the gates run once on the post-sync tree. Task 4.4 Step 0 (plan line
12395-12404) keeps the draft's wording: if main has moved "you MAY do Task 4.5
Steps 1-5 now". A builder reading Task 4.4 literally may run the full gate
script pre-sync, then sync in Task 4.5 and run the whole script again (Task 4.5
Step 6, "re-run the gates when anything merged").

**Evidence.** Plan lines 457-462 (AR18) vs 12395-12404 (Task 4.4 Step 0) and
12626-12631 (Task 4.5 Step 6).

**What it implies.** Not a correctness problem (the reported run is post-sync
either way) but a possible extra ~40-minute full gate run, which AR18 exists
to prevent. Replace "MAY" with "MUST" in Task 4.4 Step 0.

## 3. [LOW] DynamoDB Local start rule contradicts itself across S1 and AR2

**What is wrong.** The S1 preflight (plan line 668-669) says "If nothing
answers, ask the human before `npm run db:start`". AR2 (binding) says "start
it with `npm run db:start` if it is not up (a START is fine; never RESTART the
shared container)", and Task 4.4 Step 1 runs `npm run db:start`
unconditionally.

**Evidence.** `scripts/db.mjs:179-205`: `db:start` is an idempotent start
(running -> no-op, stopped -> start, absent -> run), so AR2 is safe.

**What it implies.** A builder that follows S1's preflight stops and waits for
a human that AR2 says is not needed; in an unattended mission that is a stall.
Align the preflight with AR2.

## 4. [LOW] S2's commands are PowerShell but the section never says so

**What is wrong.** S1 and S4 declare Git Bash and use `cd "W:/tmp/..."` /
`cd /w/tmp/...` with heredoc commits. S3 states "Commands are PowerShell". S2
uses PowerShell syntax (`cd W:\tmp\matching-blast-rules\app; npx vitest run
...`, `git -C ... commit -m @'...'@`, `Test-Path ...`) in unlabeled code
blocks, interleaved with blocks explicitly labeled "(Bash)".

**Evidence.** Plan lines 4451-4453, 4887-4911, 5114-5116, 5309-5335 (S2,
unlabeled PowerShell) vs 4870-4876 ("ASCII check (Bash)").

**What it implies.** Run in the Bash tool, `cd W:\tmp\...` loses its
backslashes and the `@'...'@` here-string is not a commit message. A builder
will notice and adapt, but this is exactly the kind of literal-execution trap
the plan otherwise works hard to avoid. One sentence at the top of S2 fixes it.

## 5. [LOW] An unrepaired e2e test captures the FIRST draft create, and S3 adds a second async input to the filter

**What is wrong.** `e2e/tests/dashboard-next/broadcasts.spec.ts:398-440`
("compose a draft, see it in the Drafts list, delete it") opens
`?unitId=unit-0001`, fills the message, captures the FIRST `POST
/api/broadcasts` response and expects THAT draft in the Drafts list. The
composer deletes a superseded throwaway draft when a newer one lands
(`dashboard/src/routes/broadcasts/useComposerDraft.ts:209-221`, "Clean up the
PREVIOUS throwaway draft"). Today only the property load changes the filter
after mount (the voucher prefill). After S3 Task 3.5 the derived filter also
changes when the ORGANIZATION LIST lands (unit-0001 accepts Atlanta Housing
Authority, so the authority prefill appears then). If either GET lands more
than the 600 ms debounce (`useComposerDraft.ts:28`) after the fill, the first
draft is superseded and deleted and the test fails.

**Evidence.** Task 4.1 repairs only test 1 and test 2 of
`broadcasts.spec.ts`; F21 (plan line 10621-10627) does not mention this test;
the D3 settle gate (Task 3.5 Step 8) gates Preview, not draft creation.

**What it implies.** A pre-existing race window, widened by one more async
dependency. Low probability on a quiet lane, higher under a full gate-4 run.
Either have the test wait for the prefill (the `Remove Atlanta Housing
Authority` chip, or Preview enabled) before filling the message, or capture
the LAST create before asserting.

## 6. [LOW] The compose-step 503 alert outlives the draft it was about

**What is wrong.** Task 3.5 adds `rulesUnavailable` state, set on a Preview 503
and cleared only when the next Preview starts (Step 15, `onPreview`). An edit
to the message or a filter after the 503 recreates the draft, but the alert
"Couldn't check tours and Not interested replies, so the recipient list can't
be shown yet." and its Try again button stay on screen for the new draft.

**Evidence.** Plan lines 9743-9758 (state), 9953-9970 (only clear site),
10096-10115 (render).

**What it implies.** Cosmetic; Try again previews the current draft, so
nothing wrong is sent. The spec (D7) does not require clearing it; a one-line
clear in `onFilterChange` / on a draft-key change would make the alert
truthful.

---

## Checked and found sound (so the next round need not re-check)

- **S1 old_strings and anchors** all exist at the cited lines on the branch
  base: `broadcastApi.test.ts:248` (share-skip-fix D4 title), `:2172`
  (`filterFor` doc), the caseworkers banner line (unique), `:289-303` and
  `:2549-2550` / `:2598-2600` (declineLabelsUnavailable assertions);
  `toursRepo.ts:217-219`, `:436-447`; `broadcasts.ts:137-171`, `:392-394`,
  `:420-422`, `:536-567`, `:635-650`, `:697-699`.
- **The Task 2.5 grep gate** prints exactly the 7 stale lines the plan expects
  (run on the branch base).
- **The rewritten `audienceResolution.test.ts` fake** implements all 29
  `ContactsRepo` methods (compared against the interface), so it typechecks;
  the page-bound cases agree with `contactsPartitionFake.ts:100-200`
  (limit-reached cursor, status-then-contactId sort, soft-delete filtered after
  the slice).
- **`orgNames.checkList`** returns the first failing member's 422 with `text` =
  that trimmed member (`app/src/lib/orgNames.ts:302-326`, `:275-290`), as Task
  1.4 and AR20 assume; `orgNotOnListBody` returns the body (not the text), as
  Task 3.5 Step 11 assumes (`dashboard/src/routes/orgs/orgCopy.ts:367-382`).
- **`broadcastsRepo.create`** stores `stats.audience` only when
  `estimatedAudience` is a number (`broadcastsRepo.ts:722`, harness twin
  `twilioWebhookHarness.ts:3695-3697`), so D8's "stats.audience 0" on an
  omitted estimate needs no repo change.
- **No other reader or writer of the filter shape**: `audience_filter` is read
  or written only in `broadcasts.ts`, `broadcastsRepo.ts`, `seed/matrix.ts`
  and `seed/performance.ts` (the latter has no authority); the PATCH and
  stats-view responses carry no filter; SSE payloads carry no filter; the
  dashboard reads it only through `audienceSummary`.
- **No other dashboard test renders the composer pieces** beyond the five
  files S3 runs; no other app suite asserts a candidate object with `toEqual`
  besides the one Task 2.1 T-Edit 2 updates; no once-mocked read used by
  create's new path is set before a draft create (create would otherwise
  consume it).
- **e2e specs outside Task 4.1** that use the property picker or the review
  step (`share-skip-fix`, `partner-share`, `share-sent-outcome`,
  `matching-entry-points`, the `sending-unit` scenario via `teamSendsListing`)
  all publish their units Available first and either use seeded rows or match
  the checkbox by a name prefix, so D9 and the new tour cues do not break them.
- **Deploy skew**: the app image serves `dashboard/dist`
  (`Dockerfile:18-30`), so a new dashboard never meets an old server; the old
  open tab + new server direction is covered by D2's legacy body.
