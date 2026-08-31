# Final spec-conformance review - `49146fba`

## Verdict

**CONFORMS.** Static review of `3c2962a4..49146fba` found no must-fix or plausible spec defect. S1-S7 all conform to the approved D1-D11 contract. The branch keeps classification advisory, Unknown-only, revision-fenced, forward-only, and hermetic. `git diff --check 3c2962a4..49146fba` exited 0 with no output.

Per dispatch, this pass ran no Vite, Vitest, browser, E2E, or background command; verdict is source/diff conformance against the existing committed evidence.

## Must-fix findings

None.

## Plausible findings

None.

## Work-map conformance

### S1 - canonical kind contract: CONFORMS

- The backend union is exactly `tenant | landlord | property_manager | partner` and is the `ExtractionResult.typeSuggestion` value contract (`app/src/adapters/extraction.ts:73-82`).
- Runtime activation remained later than its consumers: persistence/reconciliation/UI commits `fcf65dda`, `3f96cfa5`, `20638a46`, and `d4fb6f2c` precede schema/prompt activation commit `cddac44d`. No `AI_EXTRACTION_ENABLED`, config, environment, or feature-flag file changed in the final diff.

### S2 - revision persistence and guarded deletion: CONFORMS

- Legacy/malformed absence resolves to logical revision zero (`app/src/repos/contactsRepo.ts:312-321`); any supplied `type` or `role`, including removal, increments in the same DynamoDB update expression (`app/src/repos/contactsRepo.ts:1175-1206`).
- Suggestion identity is immutable-revision first, with exact legacy `createdAt` plus present-or-absent `runId` fallback (`app/src/repos/extractionRepo.ts:121-143`, `274-310`). Type rows persist the source contact revision (`app/src/repos/extractionRepo.ts:570-590`), and callers can request a consistent point read (`app/src/repos/extractionRepo.ts:699-707`).
- The guarded delete is one transaction: contact `ConditionCheck` plus exact suggestion `Delete`; physical revision zero accepts absent or numeric zero, later revisions require exact equality (`app/src/repos/extractionRepo.ts:779-815`). Cancellation diagnosis consistently re-reads both rows and distinguishes contact movement from replacement/absence (`app/src/repos/extractionRepo.ts:816-841`).
- Real repository evidence pins atomic concurrent increments and stored revision 2 (`app/test/contactsRepo.integration.test.ts:332-359`) plus absent/zero, exact identity, and later numeric transaction outcomes (`app/test/extractionRepo.integration.test.ts:123-302`).

### S3 - extraction-side stale reconciliation: CONFORMS

- Unknown-only apply stamps the source revision, retains canonical proposed/coerced values, and records displacement before reconciliation (`app/src/services/extraction/apply.ts:535-571`).
- A consistent live contact read keeps only a stable Unknown row; classified or newer-Unknown state is deleted against the live contact revision. Only this writer's committed delete changes the decision to dropped; replacement/absence preserves pending for finalization handoff (`app/src/services/extraction/apply.ts:724-777`). Repository failures remain warning-and-pending.
- Focused evidence covers Partner/PM persistence, legacy zero, classified cleanup, newer Unknown cleanup, replacement preservation, conflict re-read, and stable Unknown retention (`app/test/extractionApply.test.ts:438-539`). The route-owned finalization verdict wins over a still-pending producing run (`app/test/extractionJob.test.ts:977-1038`).

### S4 - full-kind PATCH semantics and race ownership: CONFORMS

- Only exact `{ type: 'landlord', role: 'Property Manager' }` compares as PM; plain canonical kinds require an absent/empty role, and every custom/noncanonical shape is unsupported (`app/src/services/extraction/contactKinds.ts:4-23`).
- Every `type` or `role` PATCH takes a consistent pre-write type snapshot best-effort, while non-type targets retain their existing generic identity policy (`app/src/routes/contacts.ts:1510-1535`). The route uses the returned committed revision and full updated kind, performs the required post-write read even from an empty snapshot, exact-deletes sequential older replacements, stops on later contact revision, and stamps only the pre-write identity as accepted (`app/src/routes/contacts.ts:1581-1661`). Delete precedes terminal verdict stamping (`app/src/routes/contacts.ts:1614-1649`).
- Full-kind evidence distinguishes PM acceptance from plain Landlord/case drift, accepts Partner, rejects custom roles, and covers role-only Edit PATCHes (`app/test/aiRunVerdicts.test.ts:1928-1989`). Empty snapshot, sequential A/B/C replacements, repository/contact-list/Today cleanup, and finalization marker ordering are pinned at `app/test/aiRunVerdicts.test.ts:2005-2177`. A delayed older route cannot delete/judge the later Unknown epoch, which is subsequently accepted by its own classification (`app/test/aiRunVerdicts.test.ts:2180-2208`).
- Generic non-type replacement remains pending and matching non-type edits still supersede rather than accept (`app/test/aiRunVerdicts.test.ts:2211-2245`). Generic target-type accept remains refused by the unchanged suggestions route contract.

### S5 - dashboard mapping, actions, and audit rendering: CONFORMS

- One dashboard boundary map owns all four exact labels and PATCH shapes; standard kinds write an empty role and PM writes the exact preset (`dashboard/src/routes/contact/contactProfile.ts:9-45`). KindPicker consumes that same map (`dashboard/src/routes/contact/KindPicker.tsx:96-110`). The edit form remains intentionally diff-only, but produces the same resulting full kind through the shared PATCH route; role-only changes are covered by S4.
- Unknown triage names all four kinds and renders canonical suggestion labels (`dashboard/src/routes/contact/UnknownFile.tsx:84-97`); buttons are in Tenant, Landlord, Partner, PM order with common busy/disabled behavior (`dashboard/src/routes/contact/UnknownFile.tsx:98-130`), and the container wraps (`dashboard/src/routes/contact/UnknownFile.module.css:7-11`). ContactDetail sends the mapped full patch, adopts only the returned contact, and remains retryable on failure (`dashboard/src/routes/contact/ContactDetail.tsx:641-649`).
- Only the type decision's Proposed cell is humanized; `Raw model response` and `Parsed result` remain exact (`dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:20-21`, `76-78`). The component test explicitly retains `property_manager` in both forensic panes (`dashboard/src/routes/settings/aiRuns/AiRunsSection.test.tsx:134-144`).

### S6 - schema, parser, prompt, and forensic ops: CONFORMS

- Structured schema order is exactly `tenant, landlord, property_manager, partner, none`; applicable parsing admits only the canonical union (`app/src/services/extraction/schema.ts:132-140`, `255-264`). Raw operation parsing deliberately retains every nonempty off-enum attempt while treating only `none` as decline (`app/src/services/extraction/schema.ts:433-440`).
- The prompt neutrally defines `client` as the current external contact, not a housing role (`app/src/services/extraction/prompt.ts:14-28`); gives mutually exclusive Tenant/Landlord/PM/Partner rules, current-transcript and represented-person constraints, ambiguity handling, note guidance, and all six D3 examples (`app/src/services/extraction/prompt.ts:66-91`). The revised mentioned-caseworker example is stricter but contract-equivalent: it requires other evidence that the caller seeks housing and makes the sentence alone `none`.
- Prompt fingerprinting remains derived from prompt plus serialized schema; there is no hard-coded fingerprint or activation flag change.

### S7 - hermetic acceptance and issue closure: CONFORMS

- Partner E2E uses a fresh Unknown contact and fake extraction marker, verifies exact suggestion UI and all four accessible actions, applies Partner, then proves stored `partner/active`, empty role, note retention, `partner_1to1`, and Today removal (`e2e/tests/flows/conversation-fact-extraction.spec.ts:315-356`).
- Property Manager E2E similarly proves exact spaced label, the staff action/display, stored Landlord base plus exact role and `interested`, note retention, `landlord_1to1`, and Today removal (`e2e/tests/flows/conversation-fact-extraction.spec.ts:359-401`). Helpers read the authenticated hermetic API and do not reference lane-0/live ports (`e2e/tests/flows/conversation-fact-extraction.spec.ts:61-94`).
- The resolved issue explicitly labels its old body a 2026-08-18 historical snapshot, preserves why `partner` superseded a caseworker union, and records the forward-only four-kind resolution (`docs/issues/caseworker-contact-type.md:14-24`, `92-99`).
- The changed-path inventory contains no seed, import, migration, scheduled-backfill, environment, infrastructure, deploy, or production-data path.

## Attacked but not broken

- **Empty pre-write snapshot:** mandatory post-write consistent read exists and is regression-pinned.
- **Replacement after human write:** judged `superseded_by_human_edit`, even if value matches; only the exact pre-write identity can be accepted.
- **Sequential replacements:** every successful/missed CAS clears the candidate and re-reads, bounded to four attempts.
- **Later Unknown epoch:** contact revision advancement defeats the older transaction before it can delete or stamp the new row.
- **Finalization handoff:** extraction preserves pending on replacement/absence, allowing the route marker to merge instead of being overwritten by `not_presented`.
- **Raw audit data:** display humanization is confined to the type decision ledger.
- **Latest correction `49146fba`:** type annotations were added to test stubs (`SuggestionItem`, `PutSuggestionResult`, `SuggestionIdentity`) without production changes, new calls, changed return values, or widened runtime behavior. It is type-contract-only.
- **Forward-only boundary:** no backfill mechanism or production/live-port behavior was introduced.

