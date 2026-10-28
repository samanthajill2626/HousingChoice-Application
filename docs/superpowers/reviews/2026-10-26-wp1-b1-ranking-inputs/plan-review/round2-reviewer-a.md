# Plan review round 2 - reviewer A

Plan: docs/superpowers/plans/2026-10-26-wp1-b1-ranking-inputs.md (v2, commit
25812156). Reviewed: the v1->v2 diff (`git diff 952b2b2e 25812156`), every
PR29-PR42 write-through against the real tree and against the S4/S5 text it
now depends on, reviewer B's round 1 report, and plan-adjudications.md.
"plan:N" = a line of the v2 plan; code cites are lines I read in this
worktree.

Summary: the round 1 fixes are mostly correct as written. The seams PR30
(probe -> S4.2/S5.3), PR31 (both ApplyOutcome pins), PR32, PR33, PR34/PR42
(the Notes lines region and its guard) and PR35 match the S4/S5 code they
call, and the commit blocks (PR29) are uniform. Two new defects come from
the fixes themselves: PR40's e2e procedure trips the harness's stale-commit
guard, and PR41 swaps false gate FAILS for false PASSES in the cases the
gate exists for.

---

## 1. [MEDIUM] PR40's "start the session once and leave it running" flow fails the e2e stale-commit preflight from the second S7 spec on

What is wrong. PR40 (plan, section 11 preamble) says to start
`npm run e2e:session` once, then run each new spec with
`npm run e2e -w @housingchoice/e2e -- tests/<path>.spec.ts` against that live
session. Each of S7.1, S7.2 and S7.3 COMMITS after its run (the "S7 commit
form"). The harness refuses a reused server that was booted at a different
commit from the checkout:
- scripts/e2e-session.mjs:133-135 reads `git rev-parse --short HEAD` at
  launch, and :279-283 stamps it on the app (`E2E_APP_COMMIT`) and the
  dashboard (`VITE_E2E_COMMIT`).
- e2e/support/preflight.ts:96-135 compares both stamps with the CURRENT
  `HEAD` on every Playwright run and throws "a STALE server is being
  reused" on a mismatch.
- `npm run e2e:restart` (which PR40 offers after a backend change) restarts
  app+worker only (e2e README "Helpers"); the Vite meta stamp is the launch
  commit, so the frontend half stays stale either way.

What it implies. S7.1 runs green and commits; S7.2's run (and S7.3's) then
dies in globalSetup with the stale-server error before a single test runs.
The builder improvises (stop/restart the session, or skip committing), and
the procedure PR40 was written to pin down is wrong as written.

Fix. In the section 11 preamble: after each S7 commit, `npm run e2e:stop`
then `npm run e2e:session` again before the next spec run; or write and run
S7.1-S7.3 against one session first and make the three commits afterwards.
State it once in the preamble.

---

## 2. [MEDIUM] PR41 swaps false FAILS for false PASSES in the cases the gate exists for; the term lists should be per case, as spec D7 says

What is wrong. PR41 removes the bare words that are the excluded fact
itself (`black`, `white`, `born in`, `moved here from`, `expecting`,
`disabled`) from the ONE union list that is checked against every line of
every case (plan S6.1 Step 2 `BANNED_TERMS`, PR21 decision 4), and puts
narrow phrases in their place. Plausible model paraphrases of a case's OWN
fact now pass the automatic check:
- race (feedback case: "we'd be the only Black family on that street"):
  "412 Oak Ave, Decatur: unsure - the street is mostly white" -> no hit
  (`white` is only banned in `white neighborhood/people/family`);
  "...worried she'd be the only Black resident" -> no hit (`black resident`
  is not in the list).
- national origin (free case: "I moved here from Guatemala two years ago"):
  "Moved to the US two years ago" / "Recently moved from Central America"
  -> no hit (`moved here from`, `born in` removed; only `us citizen`
  covers "US").
- pregnancy: "Expecting her first child" -> no hit (only `expecting a
  baby/a child/twins`, `expecting in`).
Separately, `expecting in` is itself home vocabulary that the must-not-hit
pin misses: matching is start-of-word with no end boundary for terms over
three characters (plan S6.3 `termPattern`), so "Expecting inspection
Friday" - a routine voucher-unit fact - hits.

Spec D7 says "Each case carries banned terms including paraphrases ...
matched ... against every appended line". The union across cases was a
plan choice (PR21). Under the union, a bare word has to be safe in all 29
cases. Checked per case, a bare word only has to be safe in its own case.

What it implies. A gate run can print PASS on every automatic check while
a written line states the excluded fact. Cameron's sign-off covers whether
each FEEDBACK line keeps its meaning (spec D7), not a hunt for paraphrased
leaks in every line, so a leak can get through.

Fix. Two tiers: (a) each excluded case carries a STRICT list (`black`,
`white`, `moved here from`, `born in`, `to the us`, `central america`,
`expecting`, `due`, `disabled`, ...), checked ONLY against that case's own
lines, where "black mold" or "rent due date" is implausible; (b) the
phrase-form union PR41 built, checked against every line of every case.
Replace `expecting in` with `expecting in january` ... `expecting in
december` (or drop it). Add "Expecting inspection Friday" to the
must-not-hit pin and the three leaks above to the must-hit pin.

---

## 3. [LOW] PR38's list of spec deviations is incomplete

PR38 sends rulings that "depart from spec TEXT" to Cameron and lists PR16,
PR17, PR21, PR22, PR24 and PR41. Others also depart from or narrow spec text:
- PR9: puts the postal filter into spec D4's stated order.
- PR23: replaces the spec's names (`CreateContactInput`, the `Unit` type,
  "TenantFile.tsx" as the card).
- PR25: picks persona 4, where spec 4 says "the fully filled seed tenant".
- S5 C7, which has no ruling: one-space flattening instead of the spec's
  named "toSingleLine defense" (` / `).
Under PR38's own rule ("the spec wins on any doubt" where no ruling speaks),
a strict builder could revert C7.

Fix: add PR9, PR23, PR25 to the list, and add a ruling for C7.

---

## 4. [LOW] PR42's fingerprint-only region reads "0 appended" for a run that never reached apply

With PR42 the region renders when only `sentPropertiesFingerprint` is
present: a run that read the sends and then failed at the model call.
`recordRun` writes `notedLines: draft.notedLines ?? 0`
(app/src/jobs/extraction.ts:672), and the failure path sets
`draft.notedLines = 0` (:601). So the region's first item, `<li>{run.notedLines}
appended</li>` (S4.5), reads "0 appended" on a failed run, as if apply had
run and appended nothing. PR42's own test is prose only ("Add a test: a run
with only sentPropertiesFingerprint set ...", plan S5.8 Step 3c note), with
no code or assertion text.

Fix: render the "appended" item only when apply ran (`notesBelowFloor !==
undefined`), or when `notedLines > 0` for a run recorded before B1. Write
PR42's test out in full, asserting the fingerprint item is present and no
"appended" item.

---

## Round 1 fixes checked and correct (no finding)

- PR29: all 17 S3/S4 commit blocks and the S6/S7 blocks now have the
  status read, the MERGE_HEAD `ls` and `git -C` for add and commit; the
  S7.4 merge and the gate 5 command pin git to the worktree; gate 5 asks
  for the empty-list check first.
- PR30: `sentRow` -> `selectSentRows` -> join -> `renderSentPropertiesBlock`
  matches S5.3's signatures and S5.6's join, including skipping a row with
  no display. A `flyer`-keyed counted share is what `latestCountedShareKey`
  (app/src/lib/shareLedgerKeys.ts) selects. `writtenLines` passes every
  required `NoteLineFilterInput` field and reads `append.slice(0,
  modelCount)`. S6.4's expected block (peachtree "signed up 2026-10-16",
  then birch and oak "sent") follows from the data module's dates. The
  retry-guard case proves the whole filter runs.
- PR31: the landlord pin anchor matches app/test/extractionApply.test.ts:
  269-273. Both S5.7 anchors are the post-S4 text.
- PR32 / PR33: the S4.6 case no longer pins the no-address bullet. The S6.6
  comment carries no list key; "TENANT_MATCHING_INPUTS" contains none, so
  the readers pin stays green.
- PR34 / PR42: S5.8's two anchors match S4.5's JSX verbatim. The widened
  `counted` gives every S5.8 test the region it expects, and S4.5's
  nothing-to-report PIN still sees no region with the base fixture.
- PR35 / PR36 / PR37 / PR39: `factFloor` uses S4.1's parser, and blank
  reads as 0.7 (matches S4.1). The S3.8 6b anchor matches
  app/src/services/suggestionResolution.ts:46. The RUNBOOK row and the env
  notes agree with secretsCore.mjs:253-254. Cost tests compute from the
  table and no verdict reads the cost.
- Reviewer B's other round 1 findings (F1-F10) are covered by M1-M13. I
  found nothing in B's "Verified" list that the tree contradicts.
