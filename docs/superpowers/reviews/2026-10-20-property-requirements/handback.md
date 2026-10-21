# Handback - feat/property-requirements (tracker #11 + #12: landlord requirements and property fields)

Worktree `W:\tmp\property-requirements`, branch `feat/property-requirements`,
cut from main @1d7a4667; synced ONCE with main @3df43172 (merge 738a2b4e,
8 commits, no conflict, no `npm ci`). Spec
`docs/superpowers/specs/2026-10-20-property-requirements-design.md` revision 6
(APPROVED 2026-10-20); plan `docs/superpowers/plans/2026-10-20-property-requirements.md`
v3. Records in this folder: `build-research/` (P1 drift check + worklist with
OR-1..OR-28), `build/` (13 unit reports U1-U13, the RED-by-mutation record,
fix-wave reports FW1a, FW1b, FW2, FW3, FW4), `code-review/` (rounds 1-3 +
`adjudications.md` with OR-29..OR-35), `self-qa.md`, this file.

## Verdict

MERGE-READY @e59362bb on feat/property-requirements (W:\tmp\property-requirements),
0 behind main @3df43172, UNMERGED (human gate). NO infra, NO data migration,
NO new dependency. Gates on the final code (typecheck 0, npm test 0, smoke 0,
e2e 0 - 367 passed in 20.6m, lint 1 = 5 pre-existing errors, branch-attributed
0). The tip after e59362bb adds this handback record only.

## Gates (final run 'final3' on e59362bb; code = 1c6af57d, records after it only)

`.superpowers/gates/final3/summary.txt` (verbatim):

```
label final3 commit e59362bbd754a25ec429c96613f1b957d66aac41 main 3df431720d10931e8d23e671abd511497c2bcc37 start 2026-10-21T07:12:20-04:00
gate1 typecheck exit=0
gate2 test exit=0
gate3 smoke exit=0
gate4 e2e exit=0
gate5 lint exit=1
end 2026-10-21T07:35:53-04:00
```

- Gate 2 per workspace: app 522 files, 10891 passed + 1 skipped
  (`staticSmoke.test.ts`, which skips itself when no dashboard build exists -
  the same in every run); dashboard 263 files, 5340 passed; e2e 22 files, 508
  passed; fake-twilio 34 files, 275 passed; fake-twilio-web 13 files, 111
  passed. `[dynamoAdmin]` lines: 0.
- Gate 3: `smoke-dist: OK - 1717 import specifier(s) across 300 emitted file(s) resolve under plain Node.`
- Gate 4: `367 passed (20.6m)` - the 365 of main plus the new spec's 2.
- Gate 5: exit 1 on 5 errors, all pre-existing (below).

Earlier full runs, all green on gates 1-4 (gate 5 = the same 5 pre-existing
errors each time): 'final' on 738a2b4e (after the sync; e2e 367 passed,
18.8m), 'fw1' on 83ec4ee3 (after fix wave 1; e2e 367, 18.8m), 'final2' on
1009a5e1 (after fix wave 2 + the self-QA micro-wave; e2e 367, 21.1m). No e2e
failure, flake or retry in any of the four full runs; `[dynamoAdmin]` 0 in
every `npm test`; no AWS key exported in this environment.

Gate 5 (no new lint errors in touched files) is exit 1 on FIVE PRE-EXISTING
`react-hooks/*` errors, attributed by the baseline compare
(`.superpowers/gates/<label>/5-lint-compare.txt`: branch-attributed 0,
removed-by-branch 0): `dashboard/src/routes/broadcasts/BroadcastComposer.tsx`
react-hooks/set-state-in-effect x2, `dashboard/src/routes/broadcasts/useComposerDraft.ts`
react-hooks/refs x1, `dashboard/src/routes/public/FlyerPage.tsx`
react-hooks/set-state-in-effect x2 - the same statements at the merge base,
moved by added lines. Task 7.9 Step 8 (lint backlog count) skipped: the
branch removed none.

## Main sync (Task 7.8)

One merge, 738a2b4e, of main @3df43172: c1bbd67b (extraction prompt probe
script), 1c8d2380 (extraction voucherSize prompt fix, tracker #32), 452189c0,
b13d458d, 15532983, 1456261b, 3df43172 (docs / records / e2e churn tools),
and b222a4ac (dashboard `client.ts`: a signalled request waits one microtask
and is dropped if aborted in that tick). No file changed on both sides
(merge-tree preview clean); no package file changed, so no `npm ci`. b222a4ac
is a behavior change for every signalled read this branch adds (the Apply
dialog's reads, the property page's landlord re-read, the New form's locked
landlord read); all three ignore an aborted read, and gates 2 and 4 ran green
after the sync four times. Main has not moved since (0 behind at handback).

Drift watch: `fix/contact-file-double-fetch` (MERGE-READY, unmerged) changes
`useContactFile`, whose `refetch()` the landlord page's Apply wiring uses
(Task 6.12). If it lands on main first, re-run
`src/routes/contact/ContactDetail.test.tsx` and
`src/routes/contact/useContactFile.test.tsx` on the merged result (worklist
OR-23).

## Work map - shipped / deviated / skipped

Every slice shipped; nothing skipped. Strictly sequential, one opus
implementer per unit, TDD, a required mutant pass per unit (real gaps found
and pinned in U1, U2, U3, U4, U9, U10, U11).

| Slice | Tasks | Commits | Deviations (all recorded) |
|---|---|---|---|
| S1 app foundations | 1.1-1.7 | d49384c4 a0b629ee f8b086e4 23040ea7 dfba1959 (U1); 49ca3555 347838e5 8e39ed6e 2a949b6e 4bb75fbc 5362db0a (U2) | OR-2 (snapshot landlordId '' = shape 400) |
| S2 app property writes | 2.1-2.6 | c79dfd4a 2ec26f20 1c379b0b f4ec3095 (U3); 32fb1af4 a1a9e640 361a2f08 4d5a969d dae28864 52406c81 (U4) | OR-1 (import split); OR-29 later widened the fence (below) |
| S3 app landlord + Apply | 3.1-3.3 | 7418dd6b 65c67208 c70628d0 a8aca813 (U5) | OR-7 (seed map writer stamps updated_at) |
| S4 Matching | 4.1-4.6 | ab3fb405 989d42d2 26ff4a57 63ceb8b8 140f8013 (U6); fa3c864a d31345ff 0d0ab8aa (U7) | none |
| S5 dashboard property forms | 5.1-5.9 | c01d962d ee562867 f205516c 96ca4e8f 737cefe4 (U8); baa0ebce 9f7f3945 c00563b7 a88a9e48 9c47b74e (U9); 00cdfce9 16c80bf1 dc2088bd c10b47e2 (U10) | OR-12 (mirror tests copy all three app files) |
| S6 dashboard pages | 6.1-6.12 | 3ddf7298 fbf76544 dd715ef0 d45b3fd6 d0c36922 b4227e7a 023a8c9a 1bf50472 (U11); cf52d52d c5a5aaff 230ccae4 261bbcf4 c56504a2 d239b79a 7c9249cd (U12) | OR-17 (Apply keeps staff's choices across a re-read - later amended by OR-32 / 34 / 35), OR-18, OR-22 |
| S7 e2e, docs, completion | 7.1-7.10 | 522da370 e1bf8582 68b7c118 bef5e671 d714c8d3 44d96660 de9d11e5 (U13); 738a2b4e (7.8 sync); this handback (7.10) | OR-26 (landlord Notes selector `/^Notes/`), OR-27, OR-5 (new issue typed `improvement`: the registry has no `gap` type) |
| Review fixes | - | FW1a e5818609 988f4208 8567c4dc 052175df e76fa262 2aa30812; FW1b 5da7a721 bcdf8e58 b1430f24 c3f6d323 9f6e5db7 468649a8 b41ff078 9298e206 24d0e53b 88251c90 58aa89d8 a0ca6ff2 64722b16 83ec4ee3; FW2 5dcbaef0 696e63fb 8fc45f8a 63d9562c 1d357edd f3d5dd31 95b6acea 508f34fa b5b97a70 7c0f2a3e; FW3 a34ce83c 77abd659 9ac92b17; FW4 29dc15b3 e649bbd8 1c6af57d 574cc70c | see Review |

e2e: the new spec `e2e/tests/dashboard-next/property-requirements.spec.ts`
(2 tests: pre-fill, set-here / landlord-updated tags, Apply defaults incl. the
No pets + Cats OK own value, the flyer, a two-size Matching pre-fill and a
6-bedroom tenant under 4+), proven RED by mutation
(`build/S7-new-spec-red-by-mutation.md`: M1 planUnitApply skipping blank keys
-> the flyer reads "No pets (Cats OK)"; M2 exact voucher matching -> no
6-bedroom tenant; M3 an always-checked Apply row -> row A starts checked;
GREEN after the reverts). Repaired: `e2e/scenarios/steps.ts` (picker B, list
storage, the landlord Notes collision), `contact-detail.spec.ts`,
`broadcasts.spec.ts`, `listing-activity.spec.ts`; run unchanged and green:
public-pages, matching-blast-rules, properties-available-view (AR43). Catalog:
`applyLandlordRequirements` (S5, count 121 -> 122).

## Review (three rounds, fresh reviewers every round; `code-review/adjudications.md`)

- Round 1 (at 738a2b4e): spec conformance RC - every decision D1-D13 / D10a
  CONFORMS (0 blocker/high/medium); plan-blind adversarial RA (server) 1
  MEDIUM, RD (dashboard) 1 MEDIUM. Fixed: RA-1 (the requirements fence did not
  cover the item VALUES - a race could record a wrong source, store both
  deposit forms on the public flyer, or let Apply overwrite a colleague's edit;
  OR-29), RA-2 (landlord PATCH checks fenced to its write; OR-30), RA-3 (an
  inherited-name hole in the unit field allowlist, `__proto__` / `toString`),
  RA-7, RC-1, RD-1 (Apply dead-ended on 409 deposit_conflict; OR-31), RD-2,
  RD-4 (dialogs survived a contact change), RD-5, RD-6, RD-7, RD-8, RD-9,
  RD-10, RD-12, RC-11. Rejected: RA-4 (spec D5 decides the importer fill).
  Filed: RD-3.
- Round 2 (at 83ec4ee3): R2A (server) 0 medium - every FW1a fix proven real;
  R2D (dashboard) 1 MEDIUM - R2D-1 (a re-read re-checked a property staff had
  unchecked; OR-32). Fixed with it: R2D-3, R2D-4 (OR-33), R2D-5 (the
  Application fee box disabled itself mid-typing), R2D-6, R2D-7, R2D-8, R2D-9,
  R2D-13. Filed: R2D-2.
- Live self-QA (`self-qa.md`) between rounds 2 and 3: QA-1 (a tag 9px outside
  the property card at 320px) fixed and re-measured; QA-2 (cosmetic join) fixed
  then reverted in round 3.
- Round 3 (at 1009a5e1): R3 (dashboard) 1 MEDIUM - R3-1 (a first-request 409
  requirements_changed still reset staff's choices; OR-34); with it R3-3
  (OR-35) and R3-2 (revert QA-2). Terminal: the FW4 diff was verified by the
  orchestrator (two independent mutants killed) instead of a fourth round.
- Every fix was TDD (RED on the old code) and mutant-checked; the fake units
  repo and the real one were fixed together wherever the fake mirrors a rule.

## Divergences for Cameron's eye (nothing silent)

1. OR-29 overrides plan ruling AR11 on evidence: the fence now also holds
   every key of each requirement item a write touches (spec D5 / D8 describe
   the fence as landlordId + map; the code is stricter, never looser). No
   product behavior changes outside a race.
2. The Apply dialog keeps staff's choices across EVERY re-read inside one
   open dialog (OR-17 / OR-32 / OR-34 / OR-35): an item or property staff
   unchecked is never re-checked; an item that turned blank since the click is
   unchecked (no surprise "Clears"); a deliberate "Clears" of an unchanged
   blank stays checked; a hand-checked row must be checked again. The spec does
   not say either way; this never writes more than staff chose.
3. New copy: the Apply notice for a landlord holding both deposit forms -
   `This landlord's deposit is set to both one month's rent and a fixed amount. Close this, fix it with Edit requirements, then open Apply to properties again.`
   (on a later batch it follows D8's stop sentence); the property page's tour
   card empty state `No application process recorded yet.` (the card keeps the
   title "Tour & application process" - retitle it "Application process"?);
   the flyer says "an" before 8 and 11 ("Fits an 8-bedroom voucher").
4. The landlord name in "<L> has no requirements recorded yet." and the New
   form's lines is exactly the contact page header's name (plan 1.1): a
   company-only landlord reads as its phone, as the header does. A
   company-first name across the dashboard is a separate product change. (A
   phones[] list with no primary can still name differently in the New form's
   picker - rare.)
5. "No application fee" is now its own form flag (set only by its checkbox);
   typing "0.50" no longer ticks it.
6. Values are shown as stored: "No pets; Service animals only.; pet fee $300"
   keeps the period (dropping it hid a real difference under a tag).
7. Residue the spec binds (no change): a landlord re-typed to another contact
   type keeps its req_ keys, and the D2 gate refuses the null that would
   clear them (invisible off the landlord page; they return with a re-type to
   landlord). A soft-deleted landlord's page still offers Apply to properties
   (and Add a property / Edit, as today).
8. Known limits noted, not changed: money has no upper bound (a value past
   2^53 500s, the pre-existing class); requirement text has no length cap (an
   Apply over 100 properties with ~99k characters of text would exceed the
   body limit); sub-cent amounts display rounded.

## Issues

- Resolved: `unit-voucher-size-readers-diverge`,
  `broadcast-4plus-exact-match-underreach`; partly resolved:
  `unit-onboarding-fields` (king-bed fit and square footage stay open).
- Filed: `import-washer-dryer-not-mapped` (the Airtable "Washer Dryer?" column
  is parsed and dropped), `apply-stopped-run-drops-earlier-skips` (RD-3),
  `contact-detail-inflight-actions-cross-contact` (R2D-2, pre-existing class).
- No e2e sighting to append (no failure in any run).

## Post-merge (deploy is Cameron's)

NO infra, NO terraform, NO secrets or SSM, NO backfill or migration, NO
importer change, NO new dependency, NO env change. After the deploy, reload
open dashboard tabs and relaunch installed dashboard apps: an already-open
flyer keeps the old fields until it reloads, and an old composer page shows a
multi-size draft as its first size (D11, D12). Expected on day one: every
existing deposit, pets, application fee, tour type and tour process shows
purple "Set on this property / Landlord: blank" until its landlord is filled
in (D6, spec section 4). Owed elsewhere: the Improvements Tracker items #11
and #12; the full-profile demo world shows the requirements landlord (Delia
Okonkwo) on its next full reseed.

## Open questions

None blocking. The "for Cameron's eye" list above holds the judgment calls.

## Net diff

133 files changed, 18067 insertions(+), 1153 deletions(-) vs main (excluding
`docs/superpowers/`): app 39 files +7391 / -231, dashboard 76 files +9821 /
-863, e2e 10 files +624 / -26, docs/issues + documentation 8 files +231 / -33.
