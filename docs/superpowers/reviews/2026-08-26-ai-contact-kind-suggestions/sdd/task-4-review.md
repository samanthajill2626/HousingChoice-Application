# Task 4 independent review

## Result

FAIL - four plan-required proof gaps remain. The focused S4 suite is green, but it does not exercise three mandatory route interleavings and does not pin case-sensitive Property Manager matching.

Fresh verification:

- `npm run test -w @housingchoice/app -- test/contactKinds.test.ts test/contactTriage.test.ts test/aiRunVerdicts.test.ts test/suggestions.test.ts test/todayApi.test.ts`
- Exit `0`: 5 files, 191 tests passed.

## Findings

### Important 1 - Empty pre-write type snapshot is not covered by a route test

Evidence: the only new type-race test starts with a pending type row before PATCH (`app/test/aiRunVerdicts.test.ts:1952-1958`). The only committed empty-snapshot test is for generic `pets`, whose required replacement behavior is intentionally the opposite of `type` (`app/test/aiRunVerdicts.test.ts:2063-2081`). The new harness seam at `app/test/helpers/twilioWebhookHarness.ts:3267-3270` is never used by a test. Therefore the first post-write consistent-read branch in `app/src/routes/contacts.ts:1592-1605` has no executable proof.

Concrete interleaving: pre-write consistent read returns no `type` row; `contacts.update` commits classification revision 1; immediately before the first post-write consistent read returns, publish `run-race` at contact revision 0. A correct route must read that row consistently, exact-delete it under revision 1, remove it from both the contact suggestion response and Today, and stamp `run-race/type` as `superseded_by_human_edit` with the exact candidate `createdAt`.

Minimum proof/fix: add a named real PATCH-route regression using `beforeGetSuggestion` to inject only at the first post-write consistent read. Assert the read was consistent and post-write, the repository row is absent, `GET /api/contacts/:id/suggestions` or Today has no type item, and the run verdict is terminal superseded with the route actor and exact freshness timestamp.

### Important 2 - Two sequential older-revision replacements are not covered

Evidence: `app/test/aiRunVerdicts.test.ts:1952-1985` proves one replacement inserted during `contacts.update`; it does not force `suggestion_changed_or_absent`, a second consistent read, or a second guarded-delete attempt. No test uses `beforeGetSuggestion`, and the only use of `beforeDeleteTypeSuggestion` is the later-Unknown-epoch test at `app/test/aiRunVerdicts.test.ts:1995-2012`. Thus the retry transitions at `app/src/routes/contacts.ts:1629-1631` and the subsequent exact-delete cycle are unproved.

Concrete interleaving: route snapshots row A at revision 0 and commits contact revision 1. Before guarded delete 1, replace A with older row B, making attempt 1 return `suggestion_changed_or_absent`. The route consistently reads B. Before guarded delete 2, replace B with older row C, forcing another identity miss; the next consistent read must obtain C and an exact guarded delete must remove it. The final row/contact-list-or-Today surfaces must be clean, and every route-owned deleted candidate with a run must have a terminal verdict rather than pending.

Minimum proof/fix: add a route regression that counts consistent reads and guarded deletes, injects two distinct revisions/run IDs at the actual harness boundaries, and asserts at least the required second read and second exact CAS attempt plus all three final surfaces: row, Today/contact suggestions, and run verdict.

### Important 3 - Finalization handoff is proven with a fabricated marker, not the route harness

Evidence: `app/test/extractionJob.test.ts:971-1045` builds a local `markers` map, manually deletes the suggestion with `deleteSuggestion`, manually calls `setVerdict`, and makes its local `putRun` merge the terminal value. It never invokes the contacts PATCH route. Conversely, the shared route harness models `beginFinalization` and `putRun` marker merging but its `setVerdict` is a no-op (`app/test/helpers/twilioWebhookHarness.ts:3330-3368,3377-3379`), while `makeWorld` replaces it with a spy (`app/test/aiRunVerdicts.test.ts:79-83`). No committed test proves a real route deletion banks a marker that the later harness `putRun` consumes.

Concrete interleaving: `beginFinalization(runId)` creates the in-flight marker; extraction publishes a pending type row; a real PATCH classifies the contact and guarded-deletes that row; route `setVerdict` must bank terminal `superseded_by_human_edit`; extraction preserves its `suggested/pending` draft after observing `suggestion_changed_or_absent`; later `putRun` must merge the marker so the stored decision is `outcome: suggested`, `verdict: superseded_by_human_edit`, never `pending` or `not_presented`.

Minimum proof/fix: make the shared fake's `setVerdict` faithfully update an existing finalization marker (including expected-pending and freshness semantics needed here), then add a PATCH-route plus later `putRun` regression. Assert row and Today/contact suggestions are clean, the route call carries target/type, actor, exact candidate `createdAt`, and verdict time, and `getRun` returns the terminal verdict.

### Important 4 - No test proves that Property Manager matching does not case-fold

Evidence: `app/test/contactKinds.test.ts:22-30` pins leading/trailing whitespace and other roles, but contains no lowercase, uppercase, or mixed-case `property manager` variant. The route verdict table at `app/test/aiRunVerdicts.test.ts:1876-1908` likewise has no case variant. The implementation uses exact equality at `app/src/services/extraction/contactKinds.ts:10-12`, but implementation inspection is not the required completion proof.

Concrete reproduction: resolve a pending `property_manager` suggestion with a landlord contact whose role is `property manager` or `PROPERTY MANAGER`. Either shape must be unsupported and yield `superseded_by_human_edit`, not accepted.

Minimum proof/fix: add both casing variants to the pure unsupported truth table and at least one route verdict case proving superseded.

## Attacks that held

- Exact supported full-kind mapping, plain Landlord versus Property Manager, Partner, role-only Property Manager acceptance, and role clear are covered at `app/test/contactKinds.test.ts:8-33` and `app/test/aiRunVerdicts.test.ts:1876-1935`.
- Property Manager keeps Landlord status/conversation behavior; Partner keeps active/`partner_1to1`; Tenant-only immediate extraction and unknown-only conversation rewriting remain covered by `app/test/contactTriage.test.ts:61-207,263-290`.
- The later Unknown epoch is preserved and can later be accepted (`app/test/aiRunVerdicts.test.ts:1987-2015`). A legacy no-run row is safely deleted without a stamp (`app/test/aiRunVerdicts.test.ts:1938-1950`).
- Generic non-type matching still supersedes (`app/test/aiRunVerdicts.test.ts:2023-2033`), and generic type accept remains refused (`app/test/suggestions.test.ts:257-269`).
- The one-replacement test does cover repository absence, Today absence, and terminal run verdict (`app/test/aiRunVerdicts.test.ts:1952-1985`).

No production implementation defect was reproduced in the focused green suite. The four findings are blocking because the task contract explicitly requires executable proof for these paths rather than inference from the loop and equality implementation.
