# Planner verdict - landlord requirements and property fields (tracker #11 + #12)

Branch `feat/property-requirements` (worktree `W:\tmp\property-requirements`),
final code commit c1cc7e80, tip a61b2d6f plus this record (docs only after
c1cc7e80). 0 behind main @3df43172; main is an ancestor, so the merge is a
fast-forward. **MERGE-READY. UNMERGED (Cameron's gate).** No infra, no
Terraform, no secrets / SSM, no backfill or migration, no importer change, no
new dependency, no env change.

## Gates (planner's own runs, bare, from the worktree)

On c1cc7e80 (`.superpowers/gates/planner2/summary.txt`):

| Gate | Exit | Result |
|---|---|---|
| 1 `npm run typecheck` | 0 | clean |
| 2 `npm test` | 0 | app 522 files 10910 passed + 1 skipped; dashboard 263 / 5345; e2e 22 / 508; fake-twilio 34 / 275; fake-twilio-web 13 / 111; `[dynamoAdmin]` lines 0; no AWS_ variable exported |
| 3 `npm run smoke` | 0 | 1717 import specifiers across 300 emitted files resolve under plain Node |
| 4 `npm run e2e` | 1, then 0 | first run 366 passed / 1 failed (22.2m): `tests/flows/email-triage.spec.ts:158` timed out at sign-in on an entirely white page - the open environmental issue `e2e-blank-first-paint-at-sign-in` (ninth sighting, recorded; the branch touches neither the sign-in nor the email-triage path). The file alone: 4 passed. Full re-run on a61b2d6f (same code): **367 passed (21.2m), exit 0** |
| 5 `npx eslint <branch files>` | 1 | 5 errors (BroadcastComposer.tsx x2, useComposerDraft.ts x1, FlyerPage.tsx x2, all react-hooks/*); the same 5 errors (same rules, same messages) when those 3 files are linted at main @3df43172: branch-attributed 0 |

Earlier: the planner's first run on 763314e5 (before FW5) went 0/0/0/0 with
e2e 367/367 (21.2m) and the same lint result; the build ran four full green
batteries of its own.

## Review history

- Build (AUTO, 13 units, zero recoveries, failure budget 0 of 2 used): three
  rounds of its own fresh reviewers (OR-29..OR-35), four fix waves, live
  self-QA. See `handback.md` and `code-review/adjudications.md`.
- Planner review: two fresh opus reviewers (spec-conformance; plan-blind
  adversarial). Round 1: 1 medium each (PA-1 Apply could overwrite an own
  value a colleague changed after the dialog read it; PC-1 the landlord form
  claimed "Tenants see this on the public flyer."). Fix wave FW5 (PR-1..PR-5,
  17 mutants killed). Round 2: 0 medium from both - terminal. Rulings:
  `code-review/planner-adjudications.md`.

## Spec decisions

Every decision D1-D13 and D10a is delivered; the conformance reviewer's
per-decision table is in `code-review/planner-conformance.md` and
`planner-conformance-R2.md`. Where the code differs from the approved text,
it is listed under "For Cameron" below - nothing differs silently.

## Conversation checklist (2026-10-20 unless noted)

| What Cameron asked for | Status | Evidence |
|---|---|---|
| #11 and #12 as one mission; every "Decided" line and dated note (14:21) | delivered | spec D1-D13, all conform |
| Label stays "No evictions while on the program" (14:21) | delivered | registry label; property card "Landlord: No evictions while on the program" |
| Voucher multi-select carried through #1, #28 / the Oct 12 note, #6 (14:21) | delivered | Properties page already list-aware; flyer, Matching pre-fill and blast read the list |
| Blast matches ANY of a property's sizes (14:38) | delivered | D12; e2e two-size pre-fill |
| 4+ means 4 or more (14:38) | delivered | e2e: a 6-bedroom tenant reached by 4+ |
| Flyer "Fits a 2- or 3-bedroom voucher"; "Fits a studio voucher" (14:38) | delivered (one addition) | self-QA flyer; adds "an" before 8 and 11 |
| Public flyer fields as proposed (14:38); subzone staff only (15:19) | delivered | toUnitFlyer is a fixed allowlist: no staff-only key, no subzone |
| Apply lets staff pick which properties, and can override exceptions (14:38) | delivered | dialog B; own-value rows start unchecked and can be checked |
| Copy at create; the New form fills in from the landlord, editable before save (14:38) | delivered | D7; self-QA New form |
| A blank landlord value counts as differing (14:38; reaffirmed 17:52 for tags) | delivered | O2: purple "Set on this property / Landlord: blank" |
| Existing pets values read as proposed; no backfill (14:38) | delivered | D1 legacy read |
| $0 application fee = "No application fee" (14:38) | delivered | checkbox records 0; flyer "No application fee" |
| Copy tour type AND tour process (14:38) | delivered | one Touring item |
| Property sizes Studio..12; landlord has none; filters stay to 4+ (14:38, 14:48) | delivered | picker B; no landlord size |
| Requirements get their own section on the landlord page (14:38) | delivered | Requirements / Qualifications card + form fieldset |
| Copy only; Apply can copy a blank to clear when checked (14:44) | delivered | "Clears" items start unchecked |
| Big-size pre-fill to 4+ is fine (14:44) | delivered | D12 |
| Apply dialog layout B (14:50) | delivered | self-QA screenshot |
| Remember where values came from (14:51) | delivered | requirement_sources |
| Property page layout A (14:57) | delivered | self-QA screenshot |
| Tags "Set on this property" (purple) and "Landlord updated" (orange) (15:00, 15:04) | delivered | self-QA screenshot |
| Values that exist today count as set on this property (15:00) | delivered | day-one purple tags (intended) |
| A copied blank the landlord later changes shows "Landlord updated" (15:03) | delivered | D6 table; tests |
| Voucher picker B (15:08) | delivered | Studio..4 + "More sizes (5-12)" |
| No Area on the forms (15:08) | delivered | none added |
| A shareable preview for Sam (15:08) | delivered earlier | https://claude.ai/artifact/5R3RhAD2BbALdMH2qc7ZTZ - no comments yet (checked 2026-10-21); its live watch was lost in the 2026-10-20 network outage |
| Make clear on the edit page what reaches the flyer; a warning under public free text (15:14) | delivered, one deviation | legend + a tag on every field + the note under public free text on the property forms; the "On flyer" tag is the app's brand blue, where Sam's preview showed amber |
| Subzone staff only, and a question for Sam about the codes (15:19) | delivered | staff-only tag; the question is on the preview |
| O1: a checkbox or choice and its details are ONE item (17:52) | delivered | 8 items; e2e "No pets + Cats OK" case |
| O2: keep the original call on blank-landlord tags (17:52) | delivered | as above |
| AUTO launch with 55-minute watchdog timers (21:27) | delivered | checkpoints every 55 min |
| Offered (14:40): log the decisions in tracker #11 / #12 | NOT done - awaits Cameron's go | tracker edits need permission |

## For Cameron (judgment calls; none blocks the merge)

Spec text vs code:
1. Spec D8's wire contract is out of date: each Apply property entry now also
   carries `seen` (the property's values as the dialog showed them), so an
   exception a colleague changed after the dialog opened is skipped instead of
   overwritten; a lost write can name "has a different landlord now" / "was
   deleted"; `ownItems` is required. Proposed: amend D8 to match (docs only).
2. The write checks are stricter than D5 / D8 describe (OR-29, OR-30): they
   also cover the item values, so races fail safe. No non-racing save changes.

Copy:
3. Landlord form legend: `On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).`
4. Apply notice when a landlord holds both deposit forms: `This landlord's deposit is set to both one month's rent and a fixed amount. Close this, fix it with Edit requirements, then open Apply to properties again.`
5. Property page tour card empty state `No application process recorded yet.` - retitle the card "Application process"?
6. Flyer: "Fits an 8-bedroom voucher" / "an 11-..."; amounts with cents print as `$1250.40` (whole amounts unchanged; the rent line, untouched, still prints raw cents).
7. "Update 1 property" / "Updated 1 property" at one.
8. Values show as stored, so a period can sit before "; " ("Service animals only.; pet fee $300").
9. The "On flyer" tag color: brand blue vs the amber in Sam's preview.

Behavior:
10. The Apply dialog keeps staff's choices across a re-read inside one open
    dialog; an item the landlord filled in since stays unchecked.
11. The New form: no "Filled in from" note when the landlord has nothing;
    Try again fills only items staff left blank; status lines can say "the
    landlord" until a name loads.
12. The landlord name in "<L> has no requirements recorded yet." is the
    contact header's name (a company-only landlord reads as its phone).
13. "No application fee" is its own flag (typing 0.50 no longer ticks it).
14. Smaller: a requirement save that changes nothing adds no Activity line;
    a raw API body with a boolean `pets` beside `no_pets` is refused; the New
    form tags its landlord field Staff only; the property page now always
    shows the Voucher sizes row; a contact change closes every open dialog on
    the contact page.
15. A blast saved before this change for a 5+ bedroom size now reads as 4+
    (drafts reach wider, per the spec; any SENT one is now summarized "4+ BR").
16. Applying Touring switches how "Interested" works on those properties
    (tour type drives auto-tours) - the dialog does not say so; a note is
    your call.
17. Spec-bound residue: a contact re-typed away from landlord keeps its
    requirements; a deleted landlord's page still offers Apply.

Filed, not fixed: `requirement-text-no-length-cap` (text has no cap; the
Apply body is the binding limit), `apply-stopped-run-drops-earlier-skips`,
`contact-detail-inflight-actions-cross-contact`, `import-washer-dryer-not-mapped`.

## After the merge (all Cameron's)

- Deploy; then reload open dashboard tabs / relaunch the installed app (an
  open flyer or composer keeps the old shape until it reloads).
- Day one: every existing deposit, pets, fee and tour value shows purple "Set
  on this property / Landlord: blank" until its landlord is filled in
  (intended, O2).
- The full-profile demo world shows the requirements landlord (Delia Okonkwo)
  on its next full reseed.
- Tracker #11 / #12 updates (on Cameron's go).
- Drift watch: if `fix/contact-file-double-fetch` merges first, re-run
  `ContactDetail.test.tsx` and `useContactFile.test.tsx` on the result.
- Cleanup of the worktree and branch on Cameron's explicit go.

## Merge command (fast-forward, from the main checkout)

```
git -C "W:\AI Projects\Housing Choice\HC Application" merge --ff-only feat/property-requirements
```
