# Code review R2 - orchestrator adjudications

Round 2 on `fix/caseworker-integrity` @d640cfb4 (fix range f11e46fb..d640cfb4:
fix wave 1 FW-1..FW-13 and the human-ruled scope addition SA-1 auto-primary).
Two FRESH re-reviewers in parallel, each briefed with the round-1 report,
`R1-adjudications.md`, the FW1 and SA1 reports and the fix diff, charged in
order: what round 1 missed, the fix diff cold, adjudication challenges, then
fix verdicts by mutant.

- `R2-backend.md`: new findings 0 BLOCKER, 0 HIGH, 0 MEDIUM, 3 LOW, 3 INFO;
  FW-1..FW-7 and SA-1 (repo, fake, per-attempt decision, scalar) all REAL by
  mutant; challenges B-1 (fix B1 now), B-3 (SA-1's type scope needs a
  ruling), B-4 (FW-5's scope missed the contact-list add).
- `R2-dashboard.md`: new findings 0 BLOCKER, 0 HIGH, 0 MEDIUM, 2 LOW, 5 INFO;
  FW-8..FW-13 and SA-1 (dashboard, e2e) all REAL by mutant; challenges on
  FW-11's scope (an in-flight write) and SA-1's rationale vs a restore that
  keeps other contacts.

Gates on the reviewed commit d640cfb4 (orchestrator, bare): typecheck 0, smoke
0, e2e 0 (345 passed, 22.3 min); npm test exit 1 - ONE failure, `connect
ENOBUFS 127.0.0.1:65533` (an OS socket-buffer error, not an assertion) in
`app/test/unitsApiRosterTypeChecks.test.ts`; that file re-run alone twice by
the orchestrator: 17/17 and 17/17 (logs `p4-isolate-rostertype-1/2.log`).
Environmental; the final gate re-runs the full suite.

## Dispositions

| # | Finding | Sev | Ruling | Wave |
|---|---|---|---|---|
| R2B-A1 | The contact-list add's `unit_contact_added` audit row records the REQUEST's `primaryContact`, so an auto-primary add is durably audited as not primary | LOW | FIX: audit (and log) the EFFECTIVE flag from the written unit, plus `autoPrimary` | FW2-2 |
| R2B-A2 / B-3 | Auto-primary is type-agnostic: a tenant, unknown or non-caseworker partner added to an ownerless, primary-less property becomes the property contact of OTHER tenants' relay groups and tour messages (introduced by SA-1; reproduced through the real `resolveRoster`) | LOW | QUESTION Q4 - the SA-1 ruling named roles, not contact types | pending |
| R2B-A3 / B-4 | The contact-list add still treats a routing POINTER row as a contact (a landlord claim answers 409 instead of 404; a `pm` seat seats the pointer, and SA-1 can make it primary) - FW-5's sibling | INFO | FIX: the route's contact read answers 404 `contact_not_found` for a pointer (the codebase's own pointer test, as FW-5) | FW2-3 |
| R2B-A4 / R2D-A2 | "Restore without a landlord" clears every primary flag; contacts left on the list are never promoted, so a property whose old landlord was the primary can come back with nobody reachable, silently - SA-1 fires only for a NEW seat | LOW | QUESTION Q5 (both reviewers ask for a ruling; the dialog copy is spec-approved) | pending |
| R2B-A5 | Stale texts: the B1 issue's line refs and outcomes; RUNBOOK's "reads, not locks" paragraph does not name the contact-list window; the voice-leg comment in `unitsRepo.ts` (~:873-878) | INFO | FIX (docs/comment), consistent with FW2-1 below | FW2-4 |
| R2B-A6 / B-1 | SA-1 widens both B1 races: the re-seated caseworker (I4) and the tenant claimant (I3) now also become the property's PRIMARY contact | LOW | ACCEPT the challenge: FIX B1 in this branch (below) | FW2-1 |
| B-1 | Challenge to R1's B1 ruling (FILE): SA-1 already put a per-attempt contact-list rule inside `addContact`'s loop and its fake and computes both predicates; the spec's "both before the repo call" fixes the ORDER of the answers, which keeping the route pre-checks preserves; SA-1 widened the outcome | - | ACCEPTED. R1's grounds were that the fix is a design change in the shared roster write and that ruling S4-1 kept the checks route-side "with the repo untouched"; SA-1 (Cameron) has since made exactly that change, and B1's window is not the spec's L1 (index lag - both route reads are consistent). FIX: keep the route pre-checks; re-check per attempt in `addContact` (a caseworker never takes a NEW seat; a vacant-slot claim needs a contact typed landlord) with typed errors the route maps to the same 409s; mirror the fake; resolve the issue filed in FW1 | FW2-1 |
| R2D-A1 / FW-11 scope | A property write that lands after a history move to another property leaves that property on a permanent spinner: `useListing.setUnit` stamps its own unit id unguarded (the contact page's `useContact.setContact` is guarded). The restore dialog's two writes are new instances of a pre-existing class | LOW | FIX: the one-line forId guard in `useListing.setUnit` (the `useContact` precedent) - it closes the branch's new paths and the pre-existing writers at the root; note it on `listing-detail-dialogs-survive-property-navigation` | FW2-5 |
| R2D-A3 | FW-8's abort guard is load-bearing under StrictMode (without it "Couldn't load the landlords." shows on every dev/e2e open) and unpinned | INFO | FIX (test only) | FW2-6 |
| R2D-A4 | FW-11's test does not pin the late-409 behavior FW-11 claims (an effect-based reset survives), and its "never restores u2" assertion cannot fail | INFO | FIX (test only) | FW2-7 |
| R2D-A5 | The ownerless notice's doc comment says "only" making someone primary restores routing; re-roling a seated contact to Landlord also does (it claims the vacant slot) | INFO | FIX the comment. The sentence itself is Cameron's ruled copy (SA-1) - incomplete, not false; left as ruled | FW2-8 |
| R2D-A6 | Doc drift: `e2e/support/selectors.md` restore-dialog row ("one alert" - FW-8 allows two); `endpoints.ts` `addUnitContact` doc lacks auto-primary and the two new 409s | INFO | FIX (docs) | FW2-9 |
| R2D-A7 | The Activity card reads "Property restored" for a restore that replaced or cleared the landlord of record (the audit carries it) | INFO | FILE: append to `contact-type-refusal-copy-edge-cases` (new copy; the spec asks only for the audit fields) | FW2-10 |
| R2B note | FW-1's write condition is `attribute_exists(deleted_at)`, not "the stamp I read" (an A-B-A restore + re-delete between read and write is last-writer-wins) | INFO | NO ACTION (not a defect; delete vs restore is last-writer-wins everywhere) | - |

Round-1 rulings the reviewers checked and agreed with: B2/FW-1, B3/FW-2, B4,
B5, B7, B8, B9 (REJECT), B10 (REJECT wire change), D2, D4, D10, D11, and SA-1's
"new seat only" interpretation.

## Questions sent to the planner (2026-10-12)

- Q4 (R2B-A2, B-3): auto-primary for every contact TYPE, or only for contacts
  typed `landlord`? A property manager or owner is a contact typed `landlord`
  with a role in this codebase, so "landlord-typed only" still covers Cameron's
  rationale (add a PM after "Restore without a landlord"). As built ("any
  type"), staff adding a tenant, an unknown or a partner (any role) to an
  ownerless property with no primary makes that person the property contact in
  other tenants' relay groups and tour messages (privacy), where before it took
  a deliberate "Make primary". Recommendation: landlord-typed only.
- Q5 (R2B-A4, R2D-A2): after "Restore without a landlord" on a property whose
  old landlord was the primary, contacts still on the list are not promoted, so
  nobody is reachable and nothing says so. Options: (a) the restore promotes the
  remaining contact when exactly one (eligible, per Q4) contact remains, in the
  same conditional write; with two or more, nobody is promoted; (b) leave the
  behavior and FILE it (staff use Make primary; the page shows no "(primary)");
  (c) new copy in the dialog or a page notice (spec-approved dialog copy
  would change). Recommendation: (a), else (b).
