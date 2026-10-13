# Code review R3 (terminal) - orchestrator adjudications

Round 3 on `fix/caseworker-integrity` @2bbc6799 (fix range d640cfb4..2bbc6799:
fix wave 2 - FW2a backend, FW2b dashboard/docs - implementing R2's rulings and
Cameron's Q4/Q5). Two FRESH re-reviewers in parallel under the TERMINAL RULE:
a LOW or INFO finding is filed; only a MEDIUM+ defect (above all a fix-wave-2
regression) reopens the code.

- `R3-backend.md`: 0 BLOCKER, 0 HIGH, 0 MEDIUM, 2 LOW, 3 INFO; FW2-1..FW2-4,
  FW2-11, FW2-12 all REAL by mutant; no regression.
- `R3-dashboard.md`: 0 BLOCKER, 0 HIGH, 0 MEDIUM, 1 LOW, 4 INFO; FW2-5..FW2-10,
  FW2-13 all REAL by mutant; no regression.

Gates on the reviewed commit 2bbc6799 (orchestrator, bare): typecheck 0,
smoke 0, npm test 0 (app 459 files / 9516 passed + 1 skipped, dashboard 4472,
e2e-ws 503, fake-twilio 275, fake-twilio-web 111), e2e 0 (345 passed,
22.0 min).

Nothing reopens the code under the terminal rule. Two LOW/INFO items in the
brand-new Q5 restore code are one-line, revert-provable corrections, so the
orchestrator folds them, with the doc drift, into a micro-wave (FW3) it
verifies itself by revert checks (no further review round); everything else
is filed.

## Dispositions

| # | Finding | Sev | Ruling | Lands in |
|---|---|---|---|---|
| R3B-A1 | The sole-landlord promotion treats a SOFT-DELETED contact as eligible: it can automatically make a deleted contact the primary contact, and a deleted one blocks promoting the one live landlord-typed contact (deleting a contact never removes its seats) | LOW | FIX (micro-wave): one clause - a soft-deleted contact is not eligible - with the reviewer's F3a/F3b route tests; verified by revert check | FW3-1 |
| R3B-A2 / C-1 | "The cleared landlord was the primary" ignores the routing fallback: on a list with no row flagged, the landlord of record IS the property contact everywhere, yet clearing them never promotes - the property comes back with nobody reachable (legacy shape; conformant to the spec's definition) | LOW | FILE with R3D-C2 in a new issue for Cameron (`restore-without-landlord-can-leave-nobody-reachable`); the reviewer's one-disjunct fix recorded there | FW3-4 |
| R3B-A3 | The restore route reads `stored.contacts` for `expectContacts` AFTER awaiting the type reads; FakeWorld's `getById` returns the live object, so a list change during those reads is a silent stale promotion in the fake (production answers 409) | INFO | FIX (micro-wave): read the list once before the awaits and use it for both the decision and `expectContacts`; the reviewer's F1 as the regression test | FW3-2 |
| R3B-A4 | Spec L1 on both fix-wave-2 decisions (a contact re-typed between the type read and the write is still promoted / auto-promoted) | INFO | NO ACTION (documented L1, RUNBOOK; a read of a different record) | - |
| R3B-A5 | Doc drift: the POST contacts route doc (`units.ts` ~:1106-1115) and `unitsRepo.ts` comments (~:63-65, :326-333, :495-497) still describe the old codes / the scalar as a routing target | INFO | FIX (comments) | FW3-3 |
| R3D-A1 / C1 | FW2-5 guards the hook's `setUnit` only: a restore answer for property A landing after a Back to B still overwrites B's local roster state via `applyRosterUnit`; a later re-role on B can post a stale primary flag; a late answer can close B's own restore dialog (pre-existing code, not a fix-wave-2 regression) | LOW | FILE: append to `listing-detail-dialogs-survive-property-navigation` (fix: bind the callbacks to their property or key the route element by unit id) | FW3-3 |
| R3D-A2 | That issue's FW2-5 note overclaims ("the in-flight half is fixed at the root") - only the spinner is | INFO | FIX (issue text) | FW3-3 |
| R3D-A3 | The `selectors.md` restore-dialog row's example second alert cannot appear beside the load error | INFO | FIX (doc) | FW3-3 |
| R3D-A4 | The `restoreUnit` doc (`endpoints.ts`) lacks the revision-5 sole-landlord promotion and the new cause of 409 `unit_roster_conflict` | INFO | FIX (doc) | FW3-3 |
| R3D-A5 | `contact-type-refusal-copy-edge-cases.md` line refs moved by fix wave 2 | INFO | FIX (re-derive) | FW3-3 |
| R3D-C2 | After Q5, "Restore without a landlord" with zero or two-plus landlord-typed contacts left still leaves nobody reachable and says nothing; no issue records it | - | FILE with R3B-A2 (same new issue) | FW3-4 |

Challenges agreed or noted: R3 backend agreed with B-1, with conditioning
every `{ landlordId: null }` restore on the list read, and with FW2-10;
C-2 (spec section 10's "a soft-deleted contact still exists" was set for
refusals, not for automatic promotion) is accepted - it is the basis of FW3-1.

## FW3 verification (orchestrator, revert checks - no further review round)

FW3 landed d7a01893..71a49bc5 (+ report 78d8b2cc). The orchestrator re-ran
the two behavior fixes' revert proofs itself on 78d8b2cc, each reverted and
restored with the Edit tool (`app/src/routes/units.ts` sha256 `c9a3a458...`
before and after):

- FW3-1 reverted (the soft-deleted clause removed from the sole-landlord
  eligibility): `test/unitsRestoreLandlord.test.ts` 2 failed / 27 - exactly
  F3a and F3b. Restored: 27/27.
- FW3-2 reverted (`expectContacts: stored.contacts` re-read after the type
  reads): 1 failed / 27 - exactly F1 (the list change during the type reads).
  Restored: 27/27.

Spec revision 5's Restore paragraph gains one clause recording FW3-1 (a
soft-deleted, missing or routing-pointer contact is not eligible) as a build
clarification from this round. Review closed: no MEDIUM+ open.
