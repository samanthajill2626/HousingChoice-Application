# Dashboard research - AI contact-kind suggestions

Scope: live dashboard mapping only. No source/test/gate commands were run. Worktree observed on `feat/ai-contact-kind-suggestions`.

## Contract and current API boundary

- `dashboard/src/api/types.ts:1550` keeps the stored union byte-for-byte as `export type ContactType = 'tenant' | 'landlord' | 'partner' | 'team_member' | 'unknown';`. Property Manager is therefore correctly not a new stored `ContactType`.
- `dashboard/src/api/types.ts:1740-1758` defines the suggestion wire shape. Relevant fields are `target: string;`, `suggestedValue: string;`, optional `revision?: string;`, `runId?: string;`, and `createdAt: string;`. The dashboard has no current `SuggestedContactKind` type or `contactClassificationRevision` mirror; the latter is not read by dashboard code.
- `dashboard/src/api/types.ts:1819-1913` makes contact classification `type: ContactType` and optional `role?: string`; `ContactPatch` exposes `type?: ContactType` and `role?: string` at `dashboard/src/api/types.ts:1919-1946`.
- `dashboard/src/api/endpoints.ts:1441-1449` is the sole client PATCH boundary: `updateContact(contactId, patch)` sends `PATCH /api/contacts/:id` and unwraps `{ contact }`. Suggestions are read at `GET /api/contacts/:id/suggestions` (`1453-1464`); generic accept/dismiss remain distinct POST routes (`1466-1491`). `useSuggestions` sends immutable `revision`, `createdAt`, and `runId` identities (`dashboard/src/routes/contact/useSuggestions.ts:78-106`). No UI should call generic accept for target `type`.

Required new canonical values (spec `64-85`) are byte-for-byte:

```ts
type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';
```

The required dashboard PATCH map (spec `91-101`) is byte-for-byte:

```ts
tenant: { type: 'tenant', role: '' }
landlord: { type: 'landlord', role: '' }
property_manager: { type: 'landlord', role: 'Property Manager' }
partner: { type: 'partner', role: '' }
```

## Classification writers

1. `dashboard/src/routes/contact/ContactDetail.tsx:637-646` is the Unknown-card writer. It currently accepts a broad `ContactType` but its child only permits `'tenant' | 'landlord'`; it PATCHes `{ type }` only. It applies the returned contact in place and releases one shared `triaging` flag. This must switch to `SuggestedContactKind` plus a shared full PATCH map; this is the route that owns backend reconciliation and verdicts.
2. `dashboard/src/routes/contact/ContactEditForm.tsx:129-141,198-203,232-239,350-396` is the second writer. It holds `{ type, role }` in `KindPickerValue`, emits only changed fields, and calls the same `updateContact` endpoint. Its role-only PATCH is intentional and must remain: the backend's type/role PATCH reconciliation handles a pending type row. Current trimming occurs at `238-239`.
3. `dashboard/src/routes/contact/KindPicker.tsx:12-15,92-122` is the local mapping producer. It already emits PM as `{ type: 'landlord', role: PM_ROLE }` (`101-104`) and Tenant/Landlord/Partner via the local `typeMap` with `role: ''` (`107-112`). It must consume, rather than duplicate, the new contactProfile map. Exact current preset is `export const PM_ROLE = 'Property Manager';` at `contactProfile.ts:9-11`.
4. No other dashboard call site writes contact `type` or `role`; `ConsentCaptureModal` calls `updateContact` for consent only. Creation has its own `ContactCreate.type` API contract (`api/types.ts:1793-1808`) but is not a type-suggestion resolution path.

## Readers and renderers to preserve

- `contactProfile.ts:15-33` is the display source: `CONTACT_TYPE_LABEL` includes Partner and `displayKind` returns `contact.role?.trim() || typeLabel(contact.type)`. It feeds the header (`ContactDetail.tsx:556`), contact list badge (`contacts/ContactsList.tsx:111`), contact-search option (`ContactSearchField.tsx:272-279`), and Landlord Details Role row (`LandlordFile.tsx:132`). This makes a stored landlord + exact PM role visibly "Property Manager" everywhere without a new `ContactType`.
- `ContactDetail.tsx:544-564` selects the file from stored base type: landlord -> LandlordFile, partner -> PartnerFile, unknown -> UnknownFile, otherwise tenant. Its complete render wiring is `1015-1102`; a returned `{ type: 'landlord', role: 'Property Manager' }` therefore gets the landlord file and the role-derived header, while Partner gets PartnerFile. It currently passes all pending suggestions only to UnknownFile (`1032-1048`), exactly as required.
- `ContactsList.tsx:85-133,297-309` renders the role-aware badge; tenant facts remain tenant-only. `ContactSearchField.tsx:8-16,272-279` also uses the role-aware label in option accessible text. `PartnerFile.tsx:1-9,83` and `LandlordFile.tsx:1-8,132` keep their existing base-type behavior. `TenantFile.tsx:211-230`, `PartnerFile.tsx:83`, and `UnknownFile.tsx:149` only render type-scoped status. `today/buildToday.ts:61-71,310` maps conversation types (including `partner_1to1`) and therefore needs no dashboard code change once the server returns its normal conversation type.
- `dashboard/src/routes/contact/UnknownFile.tsx:54-60,81,90-118` is the only type-suggestion renderer. It currently gets the pending `type` row through `suggestionFor`, displays `capitalize(suggestedValue)`, and offers only Tenant/Landlord. `capitalize('property_manager')` becomes the wrong `Property_manager`. Existing Buttons retain native accessible names from their text and share `disabled={triaging || !onTriage}`. `UnknownFile.module.css:7-11` is flex but lacks `flex-wrap`, so it will overflow after adding four actions.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:45-70` is the decision-ledger renderer. The proposed cell currently writes raw `decision.proposedValue ?? decision.proposedOp` at `67`; raw response and parsed result render separately at `68-69`. Change only the Proposed cell when `target === 'type'`; preserve those two forensic panes byte-for-byte.

## Existing component-test state and required additions

- `UnknownFile.test.tsx:14-55` covers only a Tenant label and one enabled Tenant button. Add exact Partner/PM labels, four button role/name/order assertions, callbacks for `partner`/`property_manager`, and all-four disabled behavior.
- `ContactDetail.test.tsx:428-460` currently expects two enabled actions and `updateContact('u9', { type: 'tenant' })`. Replace with the complete four-row mapping, return-in-place assertions for Partner and PM, and rejection/retry coverage.
- `KindPicker.test.tsx:72-191` already pins Tenant role clearing and the PM preset but must continue to prove the shared-map refactor preserves its Other/custom-role behavior.
- `ContactEditForm.test.tsx:179-256` has generic role and base-type PATCH coverage but not the two required decision-path cases: Unknown -> PM must send `{ type: 'landlord', role: 'Property Manager' }`; stored PM -> plain Landlord must send `{ role: '' }`.
- `AiRunsSection.test.tsx:21-26,87-95,122-131` owns the ledger fixture/order checks. Add a type proposed value of `property_manager`, assert the Decisions table says `Property Manager`, and assert raw-model/parsed-result panes retain `property_manager`; also pin an underscore in a non-type proposed value remains unchanged.
- `contactProfile.test.ts` is the right location for a new shared `SuggestedContactKind` label/PATCH map and unknown forensic-value fallback. The plan's dashboard focused suite is correctly scoped at `plans/...md:1513-1515`.

## Drift and risks

1. Current code is pre-Task-5, not contradictory to the approved plan: it lacks the shared `SuggestedContactKind`, label/PATCH helpers, two new actions, flex wrapping, and ledger humanization described at plan `1224-1265,1377-1507`.
2. The leading comment in `UnknownFile.tsx:4-9` says two actions are disabled until a GET-only backend exists, but live code at `102-117` has enabled callbacks and the API has PATCH. Update/remove this stale comment while editing.
3. The high-risk regression is duplicating or partially applying the map: PM must carry both fields, ordinary selections must clear role, and Edit contact must not add a generic suggestion accept call. A separate map in UnknownFile/ContactDetail/KindPicker would drift from `PM_ROLE` and create wrong AI verdicts.
4. Do not humanize raw forensic payloads. The accepted design adjudication explicitly narrows display humanization to the decision ledger; `AiRunDetail.tsx:68-69` is the boundary.
5. Preserve the existing result-driven render transition: optimistic classification could choose the wrong file/status and bypass server-side race reconciliation. Both writers already have the correct pattern of applying the returned contact.
