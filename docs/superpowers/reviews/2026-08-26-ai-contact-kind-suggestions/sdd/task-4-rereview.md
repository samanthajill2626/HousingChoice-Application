# Task 4 fix-wave re-review

## Result

FAIL - one important proof defect remains in the A -> B -> C retry regression. The production route retry is exercised, and prior findings 1, 3, and 4 are closed, but the retry fixture does not preserve production AI-run identity/metadata and finishes with two pending displaced verdicts.

## Finding

### Important 1 - The A -> B -> C test uses mismatched run records and bypasses displaced-run verdict ownership

Evidence:

- `pendingTypeRun` always stores `decisions.type.proposedValue: 'tenant'` (`app/test/aiRunVerdicts.test.ts:80-100`). The retry test uses that helper for all three runs (`app/test/aiRunVerdicts.test.ts:2064-2068`), but publishes B as `suggestedValue: 'landlord'` and C as `suggestedValue: 'partner'` (`app/test/aiRunVerdicts.test.ts:2078-2088`). Thus the terminal C verdict is written onto a run whose stored proposed value describes a different candidate.
- The test publishes B and C by calling the repository fake directly (`app/test/aiRunVerdicts.test.ts:2076-2089`). The fake `putSuggestion` returns a displaced row but does not stamp its run (`app/test/helpers/twilioWebhookHarness.ts:3236-3265`). A and B were both seeded as pending run rows, while the route stamps only the candidate it successfully deletes, C (`app/src/routes/contacts.ts:1629-1657`). Therefore the completed test world still has `run-race-a/type` and `run-race-b/type` pending. The test asserts only C (`app/test/aiRunVerdicts.test.ts:2107-2112`).

Concrete consequence: the regression proves the route performs three exact guarded-delete calls in A/B/C run-id order, but it does not prove the complete production interleaving in which each extraction replacement preserves exact suggestion-to-run metadata and resolves its displaced predecessor. It can pass while the AI-run surface contradicts both the suggestion values and the feature invariant that successful reconciliation leaves no pending linked type verdict.

Minimum fix/proof:

1. Let `pendingTypeRun` accept the exact proposed kind and seed A/B/C as tenant/landlord/partner respectively.
2. Drive B and C through a production-faithful replacement helper that applies the displaced-run `superseded` verdict, or explicitly model that owner transition in the shared fake before continuing the route retry.
3. Assert after PATCH that A and B have their correct displaced terminal verdicts, C preserves `proposedValue: 'partner'`, `outcome: 'suggested'`, and receives `superseded_by_human_edit` with C's exact `createdAt` and route actor. Keep the existing repository, contact-suggestions, Today, consistent-read-count, and A/B/C CAS-identity assertions.

## Prior-finding disposition

- Prior Important 1, empty pre-write snapshot: CLOSED. The hook fires on the second consistent type read, after the real PATCH commit; the test pins three reads and proves repository, contact-suggestions, Today, stored verdict, actor, and exact freshness metadata (`app/test/aiRunVerdicts.test.ts:2018-2055`).
- Prior Important 2, sequential replacements: PARTIAL. The route's `suggestion_changed_or_absent` retry cycle and final exact C delete are proved, but the fixture/run semantics above leave the complete A -> B -> C proof invalid.
- Prior Important 3, finalization handoff: CLOSED for the requested route-to-marker seam. The shared fake mirrors the relevant serial production ladder: existing pending row update, one terminal marker target, pending-only merge in `putRun`, marker consumption, and fresh fallback creation (`app/test/helpers/twilioWebhookHarness.ts:3330-3415`; production `app/src/repos/aiRunsRepo.ts:219-269,369-477`). The real PATCH test proves the marker-carried terminal verdict wins over the later pending draft without changing decision outcome (`app/test/aiRunVerdicts.test.ts:2115-2140`).
- Prior Important 4, exact Property Manager casing: CLOSED. Lowercase and uppercase are unsupported in the pure table, and lowercase through the real PATCH route supersedes rather than accepts (`app/test/contactKinds.test.ts:22-35`; `app/test/aiRunVerdicts.test.ts:1883-1910`).

## Independent verification

- `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/aiRunVerdicts.test.ts -t "drains an older row injected|re-reads and exact-deletes|banks the real PATCH|does not compare unsupported"` - exit 0; 2 files passed, 13 tests passed, 75 skipped.
- `npm run test -w @housingchoice/app -- test/aiRunVerdicts.test.ts -t "property_manager.*produces"` - exit 0; 1 file passed, 3 tests passed, 69 skipped.
- No slow or full gate was run. No production implementation defect was reproduced in this re-review.

## Attacks that held

- The fake `setVerdict` preserves an existing decision's outcome/proposed metadata, enforces the pending fence on stored rows, banks only one terminal target on an in-flight marker, merges only over a pending draft, and consumes the marker on `putRun`.
- The empty-snapshot and finalization tests invoke the actual contacts PATCH route and the real route ordering; they do not fabricate route verdict calls.
- Repository, contact-suggestions, and Today absence are asserted after successful reconciliation in all three new route tests.
- Property Manager matching remains exact byte equality with no trim or case fold.
