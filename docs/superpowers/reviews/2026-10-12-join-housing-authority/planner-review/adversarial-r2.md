# Adversarial review, round 2 - feat/join-housing-authority

Reviewer: the same plan-blind adversarial reviewer as round 1. Scope:
- the whole change again;
- the fix wave, `git diff 15c1676f 0eb44652` (the code is unchanged up to HEAD
  f563e68d);
- the round-1 adjudications.

Read-only: no suite, script, database or network was touched. Line numbers
refer to the tree at 0eb44652. The backfill script was read at that commit
(`git show 0eb44652:app/scripts/backfill-join-housing-authority.ts`).

Result: 0 BLOCKING, 0 HIGH, 1 MEDIUM and 2 LOW new findings. All three are in
the fix wave's backfill changes. The new Settings help line (D12) is correct
and complete.

---

## 1. [MEDIUM] An interrupted --apply leaves some --skip exclusions unrecorded, and the RUNBOOK then tells the operator to drop --skip and apply again

**What is wrong.** An --apply records exclusions one lead at a time, inside the
same oldest-first loop that writes the targets. A --skip lead's exclusion is
appended only when the loop reaches that lead.

If the process dies part-way, two things are true at once:
- every target before the kill point has been written;
- every --skip lead after it has NO exclusion.

A hard kill means Ctrl-C, a closed terminal, a crash, or the laptop sleeping.
Errors the script catches are already handled: they print a FAILED line
telling the operator to keep the lead in --skip. A kill prints nothing.

The RUNBOOK then routes the operator straight into the hole:
- Step 2 says to keep the --skip value only "until the first --apply on that
  environment".
- Step 4 says "Re-run the dry run (the --skip value is no longer needed)" and "A
  lead that shows up again had its write SKIPPED or FAILED in step 3: apply
  again".

The unprotected --skip lead does show up again in that dry run, and the
documented response is an apply without --skip.

**Evidence.**
- app/scripts/backfill-join-housing-authority.ts:775-813: one loop. :797 calls
  recordExclusion when the loop reaches a --skip lead; :813 writes a target
  when it reaches one. Leads come in sign-up order (scan.leads sorted, :544),
  so exclusions and writes are interleaved.
- :683-704: recordExclusion is per lead.
- RUNBOOK.md:480 ("Keep that `--skip` value until the first `--apply`").
- RUNBOOK.md:489 ("the `--skip` value is no longer needed"; "A lead that shows
  up again ... apply again").

**Failure scenario.** The operator applies on prod with --skip for three
DeKalb holders. The terminal is closed after the 40th of 120 leads. One
DeKalb holder signed up later than lead 40, so their exclusion was never
appended. Following step 4, the operator runs the dry run without --skip. That
holder is listed as a target, and the operator applies again. That person now
holds Atlanta Housing Authority, which is the exact outcome round-1 finding A4
was fixed to prevent. Mitigation: step 4 also says the skipped leads should
appear under "Left out" as "excluded on an earlier run". An operator who
checks that list closely would notice one missing.

**Suggested fix.** Record exclusions in a first pass, before any write:
1. Loop over the --skip candidates and call recordExclusion for each.
2. If any append failed, stop before the write loop (exit 1).

Then no apply can have written anything while an exclusion is still
unrecorded. Optionally, make step 4 say: if a lead you named in --skip shows
up as a target, pass --skip again.

## 2. [LOW] The backfill writes Atlanta Housing Authority to a lead where staff permanently dismissed that very value

**What is wrong.** When staff dismiss a suggestion, the system records the
rejected value in a dismissal record that it treats as permanent: that value
is never suggested to that contact again. The AI suggest path checks the
dismissed value and every spelling that names only that entry.

The backfill never reads dismissal records. Its audit-history rule does not
count the `ai_suggestion_dismissed` event either, and that event carries no
value anyway. So a candidate on which staff dismissed "Atlanta Housing
Authority" is an ordinary target, and the dry run shows nothing unusual. The
apply then writes, outright, the value a human explicitly rejected.

The RUNBOOK covers only the case where the dismissal happens during this
workflow. It says "dismissing it does NOT keep the backfill away", so the
behavior is known. A dismissal recorded months ago is invisible to the
operator.

**Evidence.**
- app/src/repos/extractionRepo.ts:253-259: the dismissal is "PERMANENT by
  ruling".
- extractionRepo.ts:722-743: putDismissal and hasDismissal.
- app/src/services/extraction/apply.ts:831-850: the suggest path checks the
  value and its `alsoDismissedAs` spellings (built at :252-290).
- app/src/services/suggestionResolution.ts:255-262: dismissing writes
  `ai_suggestion_dismissed { actor, target }`, with no value.
- backfill :168-182: `touchesHousingAuthority` returns false for that event
  type.
- backfill :596-604: only the pending-suggestion record is read.
- RUNBOOK.md:461.

**Failure scenario.** This is rare. A housing authority suggestion appears on a
lead with no authority only when the AI's write was downgraded to a
suggestion, for example on a phone transcript where the speakers were
uncertain. Suppose an earlier call made the AI suggest "Atlanta Housing" (a
spelling that names only AHA) for a DCA holder, and staff dismissed it. The
backfill gives that person Atlanta Housing Authority and puts them in AHA
blasts.

**Suggested fix.** In leftOutReasonFor, after the pending check, call
`hasDismissal(contactId, 'housingAuthority', key)`:
- for the normalized name (normalizeSuggestionValue, schema.ts:301-304);
- and for each AHA spelling that names AHA alone (the same rule as
  apply.ts:252-290).

If any dismissal exists, leave the lead out with a new reason ("Atlanta Housing
Authority was dismissed for it"). This adds one or two GetItems per would-be
target.

## 3. [LOW] The pending-suggestion read misses an accept or dismiss that is in flight or was abandoned

**What is wrong.** The new check treats "a suggestion record exists" as
"pending". Its comment says accept and dismiss delete the record. In fact the
record is deleted when staff CLAIM the suggestion, before the accept or
dismiss finishes. The claim is one transaction that deletes the suggestion
record and creates an active resolution record holding the suggestion and its
plan.

So between the claim and the commit, getSuggestion returns nothing, the lead
looks clear, and the backfill writes Atlanta Housing Authority. When the
accept then commits, its guard expected the field to be empty. It finalizes as
`superseded_by_human_edit`: the authority staff accepted is discarded, and the
suggestion is gone.

In the live case the window is milliseconds. An ABANDONED claim (the process
crashed during resolution) is recovered only lazily, the next time someone
opens that contact's suggestions. Such a claim can sit for a long time, and
the backfill will always go through it.

**Evidence.**
- app/src/repos/suggestionResolutionRepo.ts:668-692: the claim transaction
  puts the journal and deletes the `sugg#` row.
- app/src/services/suggestionResolution.ts:194-207: the accept guard expects
  the value the contact held when the plan was built.
- suggestionResolution.ts:580-585: a changed field means
  `superseded_by_human_edit`.
- app/src/routes/suggestions.ts:116-129: lazy recovery of abandoned
  resolutions.
- backfill :589-604: the read, and the comment ("A suggestion row exists only
  while it is pending").

**Suggested fix.** Also read the resolution record for (contactId,
'housingAuthority'), the suggestionResolutionRepo `get` used at
suggestionResolution.ts:588. Leave the lead out while that record is `active`;
report it as "has a pending housing authority suggestion" too. Correct the
comment.

---

## Round-1 rejections

- A1: the owner ruled "ignore". Not re-litigated.
- A2: concede. The default and the carry-over are approved decisions. Nothing
  reads a provenance stamp today, so there is no concrete harm to point at.
- A3: concede. The status and the default are decisions. The volume amplifier
  is tracked on the X-Forwarded-For issue.
- A6: concede; D8 is by design. Optional, not pressed: the new rename note on
  Atlanta Housing Authority would be a free place to mention that a rename
  turns off the /join default.
- A10: the owner ruled "add it". Implementation reviewed below; no finding.
- A11: concede; the owner accepted the limit.
- A12: concede; no live gap. Finding 2 is not an audit-shape gap: dismissals
  live in their own records, and their audit payload carries no value.

## Are the fixes correct?

**FW-1 (persisted exclusions, typo refusal).** The rule is correct: an
exclusion is recorded for each --skip CANDIDATE on --apply, and every later
run honors it (:196-212, precedence :775-806). The typo refusal is correct and
safe:
- the set of contact ids comes from the full consistent Scan, deleted contacts
  included and pointer rows not (:531-546);
- the refusal is raised after the Scan and before any history read or write
  (:755-764);
- main turns it into exit 1 with the message printed.

It cannot refuse a run it should not: every candidate's id is in that set. The
one defect is the ordering in finding 1.

Not a finding, and documented at RUNBOOK.md:481: a --skip id that names a real
but WRONG contact is not refused, and neither is a non-candidate, such as a
deleted lead that is later restored. The dry run is the mitigation.

**FW-2 (pending suggestion).**
- Correct: the read targets `sugg#<contactId>#housingAuthority`
  (extractionRepo.ts:268 and :703). It is consistent, uses the stage's table
  through the stage env (:317-319, buildBackfillDeps), and is made only for
  leads nothing earlier has left out.
- A dismissal is a separate tombstone, so a dismissed suggestion correctly
  counts as not pending (extractionRepo.ts:722-735).
- Gaps: findings 2 and 3.

**FW-3 (failure wording).** Correct. Only a lost condition is "skipped"; any
other write error is reported as "may or may not have landed" (:640-654), and
a failed read stays "nothing written".

Nit, not a finding: the post-write audit warning still says "could not be
written" (:660, :662 and RUNBOOK.md:488). An append can land and then error,
which is exactly the ambiguity FW-3 fixed for the exclusion event.

**FW-4 (the Settings help line, D12).** It shows exactly when an entry is, or
is about to become, a housing authority, and nowhere else.

Where a name can enter the housing authority list:
- **Add, through NewOrgDialog.** `addOrg` has a single caller,
  NewOrgDialog.tsx:172 (endpoints.ts:2979). The note shows while the chosen
  kind is housing_authority (NewOrgDialog.tsx:147-157, :259-266), in every
  mode, the AI-suggestion mode included.
- **"Not on the list" > Add as new.** The note shows for action `add` with
  kind housing_authority (NotOnListSection.tsx:331-335, :470-474). This is the
  only settle action that adds an entry: move and split require existing
  entries (orgRewrite.ts:514-526), and only `add` appends (:533-551).
- **Rename of a housing authority.** The note shows (OrgEntryDialogs.tsx:290-292,
  :348-352).
- **Kind change from agency to housing authority.** The note shows unless the
  move is blocked (OrgEntryDialogs.tsx:467-471, :518-522).

What does not get the note, correctly:
- spellings: they are never served on the public list (publicOrgList.ts:40-50);
- merge: same kind only (orgRewrite.ts:414-415), so no new name becomes
  public;
- agency adds and renames.

One trivial point: while the usage counts are still loading, `blocked` reads
false (orgCopy.ts:677-681), so the kind-change note shows and can then vanish.
That follows the button's existing enabled state.

## Checked again on the whole change, nothing new

- The public route, mount order, list check and D4/D5/D6 paths are unchanged
  since round 1.
- No other code reads contact audit history, so the new exclusion event type
  affects nothing else (only these files call `listByEntity`: aiRuns,
  contactTimeline, statusTransition, tours and units, plus this script).
- The extraction job has no status condition, so starting /join leads at
  `onboarding` changes only the AI status-advance suggestion
  (apply.ts:535); that consequence was raised in round 1.
- Every CSS class the new UI uses exists (FlyerPage.module.css:69,
  OrgPicker.module.css:191, OrgListSection.module.css:105).
