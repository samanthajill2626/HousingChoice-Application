# Spec review r4 - reviewer B (adversarial, final round)

Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
at `ccf74ebd` (revision 4). Inputs: `adjudications.md` (round 3: 7 of 7
accepted) and the diff `bfec445a..ccf74ebd`. Read and grep only; no suite run.
Spec citations are `spec:<line>` at `ccf74ebd`.

**Verdict: precision-only round.** No finding below changes a decision, a
surface or an invariant. Each is a rule or a field a plan can absorb. None is
above LOW.

The revision 4 changes were reviewed cold:
- The rewritten COMPOUND test (spec:261-274) now does what it says. Exact
  equality wins. Spans are longest-first and non-overlapping. One shared
  spelling is ambiguity. I re-ran every Appendix A row and the four worked
  examples against it, and none misclassifies.
- Merge's all-spellings transfer (spec:456-462) is correct: it keeps "AHA"
  shared when Augusta is merged into a third entry, and makes it unique only
  when Augusta is merged into Atlanta.
- The cleanup lock release and the no-Run-again rule for `cleanup`
  (spec:440-443, 741-748) close round 3's finding 3.
- The `/__dev/org-fixture` seam (spec:696-701) and the list-block drop order
  (spec:335-337) are sound.

---

## 1. [LOW] `lastRewrite` has no slot for Split's agency name, so "Run again" cannot re-run a Split (precision)

Split takes two names: `name` and `agencyName` (spec:418-423, 655-657).
`lastRewrite` stores only `toName?` (spec:602-612). D11 records the
definition as "from-texts, to-name, fields, action" and "Run again
re-enqueues the same definition" (spec:436-443). A failed or stalled Split
would therefore re-run without its agency half. Add `agencyName?` (or a
`toNames` map) to the stored definition.

## 2. [LOW] Split is defined only for contact fields, though compound values also sit in property lists and agency fields (precision)

Split targets "compound housing authority values". Its writes are the contact
fields `housingAuthority` and `agency` (spec:418-423). `accepted_authorities`
is also a housing-authority field, and the cleanup leaves compound property
members alone (spec:734). Units have no agency field, so Split there would
mean "keep the authority half". A compound agency-field value (an agency plus
an authority) has no Split at all, and the two Move actions need a value that
"match[es]" one entry (spec:410-417). State which rows offer Split and what
settles the other two cases: Use for properties; a mirrored Split, or Use, for
agency values.

## 3. [LOW] An entry whose name is longer than the spelling cap can never be merged (precision)

Names may be 120 characters (spec:488). Spellings may be at most 100
(spec:490). Merge must transfer the merged entry's NAME as a spelling, and
refuses any transfer that breaks a D13 cap (409 `org_spellings_full`,
spec:456-462). So every merge of an entry with a 101-120 character name is
refused; the only way out is to rename it first. Align the two caps, or let
the merge drop the over-long name with a report, as rename already does under
D12's skip rule (spec:478-483).

## 4. [LOW] A compound text is refused as a spelling but accepted as a new NAME (precision)

D12 refuses compound spellings (spec:473-477). Nothing checks a new name:
- the add route refuses a name only when it equals an existing name or
  spelling (spec:646-648);
- D6's "Yes, add it" is open to every signed-in user (spec:302-304);
- the admin's Add as new is available on any row (spec:424-425).
A name like "DCA HUD-VASH" becomes a list entry and an exact match. It is then
never compound (spec:261-262) and cannot be Split. Its holders form a second
DCA audience that a DCA filter misses - the drift this feature exists to stop.
Apply D4's compound test to new names: refuse, or have "Is this really new?"
offer the authority-plus-agency split.

## 5. [LOW] (B) Unstamped triage means a re-import still reverts every in-app triage of imported `unknown` contacts (precision - or a decision if triage should be protected)

Revision 4 stamps `type_source: 'manual'` only on overrides of tenant,
landlord or partner, not on triage from `unknown` (spec:571-574). The
importer SETs `type` on every run (`app/src/lib/import/apply.ts:966-967`). The
triage PATCH does not stamp `status_source` (`app/src/routes/contacts.ts:1489-1498`).
So a re-import puts every triaged imported contact back to `unknown` with an
import-derived status. Most imported threads were `unknown_1to1` (621 of 634,
`RUNBOOK.md:339`). This is pre-existing behavior, but D21 is titled "Type
changes keep threads and imports consistent" (spec:565). Either state the
reversal as accepted, as D9 does for a re-filled clear, or protect triage
where the importer's type is `unknown`.

## 6. [LOW] Stale cross-reference: D9 points to D20 for the importer's type rule (precision)

Spec:379 reads "B adds a `type` rule to the importer, D20". The rule is D21
(spec:565-578); D20 is direct shares (spec:552).

## 7. [LOW] An entry used only by deleted records shows zero uses, yet delete and kind change refuse it with nothing to look at (precision)

Usage rows count ACTIVE records (spec:386-388). Delete and kind change count
deleted ones too (spec:427-428). Only "Not on the list" rows expand into
records (spec:394-399). An admin sees "0" and gets 409 `org_in_use`, with no
way to see which deleted contacts or properties hold the name. Have the 409
(or the row) report the deleted-record count; merge remains the way to clear
it.

---

## Adjudication contest

None. All round-3 rulings stand. Round 3 finding 5's fix took the option I
offered ("triage from unknown does not stamp"); finding 5 above only asks that
its consequence be stated.

## Fix checks (round 3)

Correct: R3-1 (COMPOUND, re-derived on Appendix A), R3-2, R3-3, R3-6, R3-7.
Correct but incomplete: R3-4 (findings 1 and 2), R3-5 (finding 5).
