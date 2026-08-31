# Live-tree worklist - AI contact-kind suggestions

Baseline: `feat/ai-contact-kind-suggestions@8ce73746`, based on `main@3c2962a4`. This map derives from the live tree; line anchors are at the baseline.

## Contracts to preserve byte-for-byte

```ts
type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';
```

```ts
tenant: { type: 'tenant', role: '' }
landlord: { type: 'landlord', role: '' }
property_manager: { type: 'landlord', role: 'Property Manager' }
partner: { type: 'partner', role: '' }
```

- Property Manager is never a `ContactType`; the current stored union at `app/src/repos/contactsRepo.ts:45-52` remains `tenant | landlord | partner | team_member | unknown`.
- Logical revision zero means a physically absent `classification_revision` or `contactClassificationRevision`; every DynamoDB zero predicate must be `attribute_not_exists(classification_revision) OR classification_revision = 0`.
- Type remains triage-only: `app/src/services/suggestionResolution.ts:203` rejects generic type accepts; non-type replacement behavior remains untouched.
- Raw forensic model response and parsed-result panes retain canonical values; only the AI decision ledger's type-proposed cell is humanized.

## S1 - canonical type, no activation

- `app/src/adapters/extraction.ts:73-87` currently has an inline `'tenant' | 'landlord'` `typeSuggestion.value`. Export the four-kind union and consume it here only.
- Runtime stays Tenant/Landlord-only until S6: `app/src/services/extraction/schema.ts:119-128,242-251,420-429` and `app/src/services/extraction/prompt.ts:14-17,65-69` must remain untouched by S1.
- `app/src/adapters/extractionFake.ts:67-111` returns `Partial<ExtractionResult>` and adopts the widened compile-time payload with no fake-protocol change.

## S2 - all classification-fence mutation and read surfaces

- Existing mutation owner: `app/src/repos/contactsRepo.ts:1152-1211` builds one `UpdateCommand`, condition `attribute_exists(contactId)`, `ReturnValues: 'ALL_NEW'`. It must atomically increment `classification_revision` only for supplied `type` or `role`, including `role: null` and retyping `unknown`.
- Non-mutation/contact-origin writers that must remain revision-absent: `contactsRepo.create/createIfAbsent` (`:535-570`), `app/src/services/contactCapture.ts:79`, `app/src/services/groupConvert.ts:339`, `app/src/services/groupMembers.ts:111`, and `app/src/lib/seed/cast.ts` / `app/src/lib/seed/lean.ts`. No seed, import, capture, migration, or backfill change.
- Type-suggestion row/identity surfaces: `app/src/repos/extractionRepo.ts:81-107,228-233,489-614,617-634,667-694,711-739`. Add only optional source `contactClassificationRevision`, revision-first `sameSuggestionIdentity`, consistent point read option, and guarded two-table transaction.
- Guarded cross-table delete: contacts `ConditionCheck` plus exact suggestion `Delete` in one `TransactWriteCommand`; report `deleted | suggestion_changed_or_absent | contact_revision_changed`, diagnosing cancellation with consistent reads in contact-revision priority.
- Required production-like fakes/tests: `app/test/contactsRepo.integration.test.ts`, `app/test/extractionRepo.test.ts`, `app/test/extractionRepo.integration.test.ts`, `app/test/extractionJob.test.ts`, `app/test/extractionJobDraftGuard.test.ts`, `app/test/helpers/twilioWebhookHarness.ts`, and `app/test/twilioSmsWebhook.test.ts`.

## S3 - extraction-side writer/reconciliation

- `app/src/services/extraction/apply.ts:34-44,534-576,697-702`: Unknown-only type suggestion writer; widen dependencies with consistent contact reads and guarded delete, persist source revision, and preserve `suggested` if another owner won deletion. A temporary put/retract still emits exactly one `suggestion.updated` event.
- `app/src/services/extraction/runTypes.ts:24-39` adds only `type_classification_changed` as a dropped reason.
- `app/src/jobs/extraction.ts:567-633` runs apply after `aiRuns.beginFinalization`; `app/src/repos/aiRunsRepo.ts:400-477` marker-safe setVerdict behavior makes apply decision ownership load-bearing.
- Wiring/readers: `app/src/worker.ts:458-494`, `app/src/routes/dev.ts:643-691`, extraction eligibility/profile readers `app/src/jobs/extraction.ts:131-158,435-448`, and all typed fakes named in S2.
- Race invariant: only the extraction writer's committed guarded delete produces a dropped decision. Missing/replaced suggestion remains pending so a route-owned finalization marker merges into `putRun`.

## S4 - human PATCH writer/reconciliation

- Existing PATCH owner: `app/src/routes/contacts.ts:1386-1700`; `parseTriageBody` accepts role and maps empty role to null at `:634-639`. It currently snapshots generic fields then compares `parsed.patch[f]`; isolate `type` from generic cleanup and add a full-kind resolver.
- New backend resolver: `app/src/services/extraction/contactKinds.ts` with exact `PROPERTY_MANAGER_ROLE = 'Property Manager'`. Supported shapes: Tenant/Landlord/Partner with absent/empty role and Landlord with exact PM role; every other nonempty role is unsupported without trimming.
- Preserve downstream effects: status mapping at `contacts.ts:1426-1444`; only `unknown_1to1` conversation rewrites at `:1633-1649`; Tenant-only immediate extraction at `:1651-1671`.
- Mandatory readers rendered after route reconciliation: generic suggestions `app/src/routes/suggestions.ts:93-107`, Today `app/src/routes/today.ts:942-973`, dashboard suggestions/Unknown file, and run-verdict marker path. A stale row must not remain in Today after successful reconciliation.
- Required tests: `app/test/contactKinds.test.ts`, `contactTriage.test.ts`, `aiRunVerdicts.test.ts`, `suggestions.test.ts`, `todayApi.test.ts`, plus the harness revision/identity/race hooks.

## S5 - dashboard writers/readers/renderers

- Stored/dashboard API shape: `dashboard/src/api/types.ts:1550,1740-1758,1819-1946`; no public contact revision required.
- One client PATCH boundary: `dashboard/src/api/endpoints.ts:1441-1449`; generic suggestion operations are separate `:1453-1491` and must never resolve `type`.
- Writers: `ContactDetail.tsx:637-646,1015-1102` (Unknown-card action), `ContactEditForm.tsx:129-141,198-203,232-239,350-396` (diff-only edit, including role-only), and `KindPicker.tsx:12-15,92-122` (current duplicate mapping). Centralize canonical kind label/PATCH map in `contactProfile.ts:9-33`; PM_ROLE must stay exact.
- Readers/renderers: role-first `displayKind` in `contactProfile.ts:15-33`; file routing `ContactDetail.tsx:544-564`; `UnknownFile.tsx:54-60,81,90-118` suggestion display/actions; `UnknownFile.module.css:7-11` needs wrapping; `AiRunDetail.tsx:45-70` humanizes only type decision proposed cell, never raw panes.
- Downstream displays to preserve: `ContactsList.tsx:85-133,297-309`, `ContactSearchField.tsx:272-279`, `LandlordFile.tsx:132`, `PartnerFile.tsx:83`, Tenant/Partner/Unknown file status displays, and `today/buildToday.ts:61-71,310` conversation labels.
- Required component tests: `contactProfile.test.ts`, `KindPicker.test.tsx`, `UnknownFile.test.tsx`, `ContactDetail.test.tsx`, `ContactEditForm.test.tsx`, `AiRunsSection.test.tsx`.

## S6 - runtime activation after consumers

- Activate only after S2-S5 focused tests pass: schema enum `['tenant', 'landlord', 'property_manager', 'partner', 'none']`, applicable parser four-kind allowlist, raw operations still preserve nonempty off-enum attempted suggestions.
- `prompt.ts` changes only semantic instructions: current external `client` contact, mutually exclusive Tenant/Landlord/Property Manager/Partner criteria, D3 six examples, no organization/ambiguous-word guessing, stated concise PM/Partner note lines, and existing note reconciliation. Preserve wire labels and fingerprint-derived behavior.

## S7 - hermetic E2E and issue closure

- Fake seam: `e2e/fixtures/extraction.ts:4-61`, deterministic `EXTRACT:<json>` applied through real signed inbound and `POST /__dev/extraction/tick`.
- Existing type flow: `e2e/tests/flows/conversation-fact-extraction.spec.ts:268-294`; discovery helper and hermetic login at `:21-83`; Today assertion pattern at `:296-325`.
- Add Partner and Property Manager flows with fresh Unknown contacts; scope Needs triage, assert exact labels/all four actions, click exact actions, prove contact shape/status/note/conversation type and removal from Today suggestion list.
- Update `docs/issues/caseworker-contact-type.md` only after focused e2e passes; run `npm run issues` but do not stage gitignored index.

## S8 - required final evidence

- One final sync only, then bare gates: typecheck, test, smoke, e2e, touched-file lint; no pipes and no lane-0/live-app use.
- Live QA starts `npm run e2e:session`; test both classifications and narrow width action wrapping, save only untracked `.playwright-mcp/` screenshots, then cleanly `npm run e2e:stop`.
- Explicitly audit no production contact, import, seed, backfill, dependency, environment, table, infra, deployment, or AI flag change.
