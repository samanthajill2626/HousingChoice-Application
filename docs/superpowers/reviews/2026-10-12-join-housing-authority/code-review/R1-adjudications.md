# Code review round 1 - adjudications (orchestrator)

Branch feat/join-housing-authority @67cd745c (code tip 8cb22537), merge base main @5c0d3f6a.
Reports: `R1-conformance.md` (spec-conformance, plan-anchored) and `R1-adversarial.md`
(plan-blind, standing charter). Orchestrator's own read: app.ts mount, public.ts handler,
publicOrgList.ts, HousingFairIntake.tsx, the backfill rules/paging/apply.

Conformance: 111 items - 110 CONFORMS, 1 DEVIATES (INFO), 0 PARTIAL, 0 MISSING; 9 mutation
checks run after the gate-4 marker, 8 caught, 1 survived (R1-C3).

## Fix wave 1 (one fresh implementer)

| Id | Sev | Disposition |
|---|---|---|
| R1-C1 = O-1 | LOW | FIX. The child-process CLI test (`app/test/backfillJoinHousingAuthority.test.ts` ~1380) passes `--env dev --bogus`; a test must never name a deployed environment. Use argv that fails to parse with no `--env` at all; keep the exit-2 + usage assertions; prove the test still fails if the usage path breaks. |
| R1-ADV-4 | LOW | FIX. Operator report prints public-form names raw (`leadLine`); a newline forges a report line (with a contactId the run never read), ESC sequences reach the terminal. Show control characters (code points 0-31, 127-159) escaped/visible in the report's names; everything else unchanged. Test with a newline and an ESC name. |
| R1-C3 | INFO | FIX. `IntakeForm.tsx` `if (submitBlocked) return;` is untested (mutant survived): add a direct form-submit test (`fireEvent.submit`) that fails with the guard removed. |
| R1-C4 (+ unit 1 LOW) | INFO | FIX. `public.ts` `PublicRouterDeps.orgListRepo` comment claims app.ts hands "the SAME repo" to both routers; true only when one is injected. Reword. |
| R1-ADV-2 (doc part), R1-ADV-7 | MED/INFO | FIX, RUNBOOK wording only: (a) a backfilled lead holds the authority like any held value, so an authority it states later arrives as an AI suggestion for staff (no overwrite) - same as a /join lead left on the default (spec section 4); (b) "a lead who answered 'Not sure' is never touched" -> any post-deploy sign-up with no authority ("Not sure", a list that failed to load, a page loaded before the deploy); (c) the `signed up again` bullet: a /join answer is kept only in the audit history (no staff screen shows it - issue join-repeat-signup-answer-unreachable), and a flyer re-sign-up never saw the question and is left out too, erring safe. |
| R1-C6 | INFO | FIX, doc: `documentation/STATUS-MODEL.md` landlord section's "same front door tenants and untriaged contacts land at" no longer holds for /join sign-ups (they start Onboarding); reword to name who still lands at Needs review (auto-captured contacts, flyer sign-ups). |

## Filed, not fixed on this branch (out of scope)

| Id | Sev | Disposition |
|---|---|---|
| R1-ADV-1 | HIGH (pre-existing) | FILED `docs/issues/public-rate-limit-key-spoofable-xff.md`. `clientIpOf` keys every per-IP limiter on the client-chosen FIRST X-Forwarded-For entry (CloudFront appends the viewer). Pre-existing in shared middleware; the SMS-spend fence on POST /public/housing-fair is the serious exposure and predates this branch; the new list limit merely inherits the key. The fix needs the production hop chain confirmed and its own review. SURFACED LOUDLY in the handback for Cameron. |
| R1-ADV-3 | MED | FILED `docs/issues/join-repeat-signup-answer-unreachable.md`. Behavior is exactly spec D6/D7 ("its answer is kept only in the audit") with "changing an existing contact from a repeat sign-up" explicitly out of scope (spec section 5); the gap it leaves is now recorded with the cheap and the better fix. |

## Rejected / accepted as built

| Id | Sev | Disposition |
|---|---|---|
| R1-ADV-2 (code part) | MED | REJECT code change. The backfill writing Atlanta as a held value (no provenance) is the approved design (spec D10; Cameron: authority only). The extraction consequence is already a listed spec section 4 consequence for the /join default and applies equally here; the RUNBOOK now says so (fix wave). The importer half is moot: INV research showed the Quo import cannot reach a /join contact (different contactId scheme). |
| R1-ADV-5 | LOW | ACCEPT (spec-accepted edge). The re-sign-up landing between a lead's history read and its write is spec D10's named accepted edge ("plan review 2026-10-12"); the eventually consistent Query widens it from milliseconds to about a second at most. No change. |
| R1-ADV-6 | LOW | ACCEPT (spec D1: the housing authority list is public by decision). The suggestion of a Settings note ("shown on the public /join form") is a product call: listed for Cameron in the handback. |
| R1-C2 | INFO | ACCEPT (orchestrator's call, both readings honor intent): the post-apply list re-read runs only after an apply that WROTE; with nothing written there is no record to warn about. |
| R1-C5 | INFO | ACCEPT: additions beyond the spec (select disabled while sending, `invalid_response`, empty `--skip` id is a usage error, a failed audit append after a landed write is a warning with exit 0, selectors.md + launcher notes) - none contradicts the spec; listed in the handback. |
| INV-F1 (research) | INFO | Handback consequence line (tenant list status order). |

## Gate 4 red (run1) - adjudication

`timeout 2700 npm run e2e` @67cd745c: EXIT 1, 339 passed / 1 failed (21.9m).
Failed: `tests/scenarios/landlord-onboarding.spec.ts:190` "inbound text -> not a fit ->
parked (reason)", step "App relays the lead to Team (Unknown tab, by phone)",
`e2e/scenarios/steps.ts:627` - the Unknown tab link never appeared in 15 s; the failure
screenshot is an ENTIRELY WHITE document. Artifacts preserved under
`.superpowers/sdd/e2e-results-run1/` (gitignored) before any re-run.

- The branch does not touch this path: the scenario is an inbound text from an unknown
  number (no /join, no /public route, no housing authority, no status the branch moves).
- Isolated re-run on the feature tree (`E2E_TRACE=1 npm run e2e -w @housingchoice/e2e --
  tests/scenarios/landlord-onboarding.spec.ts`): EXIT 0, 7 passed (47.0s), the failing
  test 5.2s.
- Signature match: open issue `e2e-blank-document-after-contact-navigation` (a blank
  white document after contact navigation; sightings 2026-10-08 landlord-onboarding,
  2026-10-11 post-tour-application). This is a THIRD sighting; recorded in that issue.
- Not excused: the final gate run (after fix wave 1) is the second full run and must be
  green on its own; it runs with `E2E_TRACE=1` so a recurrence keeps a trace (the
  issue's named next discriminator).
