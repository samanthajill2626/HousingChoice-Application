# AI contact-kind suggestions - design

**Status:** Design approved; adversarial review round 2 changes in progress.
**Date:** 2026-08-26.
**Branch:** `feat/ai-contact-kind-suggestions`.
**Surface:** Conversation fact extraction, Unknown contact triage, AI run log.

## 1. Problem

The conversation fact extractor can currently recommend only `tenant` or
`landlord` for an Unknown contact. That is narrower than the staff-facing contact
model:

- `partner` is a first-class `ContactType` for an outside service or program
  collaborator, such as a caseworker, agency contact, inspector, or housing
  navigator.
- Property Manager is a distinct staff-facing contact kind based on the Landlord
  record shape. It is stored as `type: 'landlord'` plus
  `role: 'Property Manager'`, but staff must not see it collapsed to Landlord.

The current extraction prompt explicitly suppresses a caseworker type suggestion
and writes only a note. It also describes every external contact as a person
seeking housing help, which biases classification toward Tenant. The JSON schema,
parser, TypeScript adapter, and Unknown triage card support only Tenant and
Landlord. As a result, the AI cannot recommend Partner or Property Manager even
when the transcript states either kind clearly.

This feature makes the AI recommendation match the existing staff-facing kind
model without auto-classifying anyone.

## 2. Goals

1. Let extraction recommend four canonical staff-facing kinds for an Unknown
   contact: Tenant, Landlord, Property Manager, and Partner.
2. Keep Property Manager distinct from both Landlord and Partner while preserving
   its existing Landlord base record behavior.
3. Let staff apply any of the four recommendations from the Unknown contact card.
4. Record an AI type decision as accepted only when the resulting full kind
   matches the recommendation.
5. Preserve concise role and organization facts in reconciled notes.
6. Keep the change forward-only, advisory, auditable, race-safe, and compatible
   with existing Tenant and Landlord suggestions.

## 3. Non-goals

- No automatic classification. A staff member must click a classification action.
- No migration, scan, or backfill of existing contacts, notes, suggestions, or AI
  runs.
- No production data read or write for the example contact that motivated the
  feature.
- No new `ContactType` member for Property Manager or caseworker.
- No general custom-kind extraction. The only custom kind added to the AI contract
  is the existing Property Manager preset.
- No new reusable custom-kind registry.
- No change to contact-list filing: Property Managers continue to use the
  Landlord base and therefore remain in Landlord-backed queries while displaying
  as Property Manager.
- No change to partner, landlord, or tenant lifecycle definitions.
- No new dependency, environment variable, infrastructure resource, or deploy
  operation.

## 4. Decisions

### D1. The model emits a canonical staff-facing kind

Keep the existing wire key `typeSuggestion` and pending suggestion target `type`
for compatibility. Widen the suggestion value to this closed union:

```ts
type SuggestedContactKind =
  | 'tenant'
  | 'landlord'
  | 'property_manager'
  | 'partner';
```

The structured-output sentinel remains `none`. The JSON schema enum is therefore:

```ts
['tenant', 'landlord', 'property_manager', 'partner', 'none']
```

`typeSuggestion` is an established name and the persisted target stays `type`, but
the value now describes the complete staff-facing classification kind. Existing
pending `tenant` and `landlord` suggestions remain valid without migration.

### D2. Kind and stored contact shape are separate

The canonical kind maps to the existing contact document as follows:

| Suggested kind | Staff label | Contact PATCH | Resulting conversation type | Default status from existing triage |
| --- | --- | --- | --- | --- |
| `tenant` | Tenant | `{ type: 'tenant', role: '' }` | `tenant_1to1` | `onboarding` |
| `landlord` | Landlord | `{ type: 'landlord', role: '' }` | `landlord_1to1` | `interested` |
| `property_manager` | Property Manager | `{ type: 'landlord', role: 'Property Manager' }` | `landlord_1to1` | `interested` |
| `partner` | Partner | `{ type: 'partner', role: '' }` | `partner_1to1` | `active` |

The action sets both `type` and `role` deliberately. A standard-kind selection
clears a stale custom role, matching the existing KindPicker behavior. Property
Manager writes the exact existing preset role. This makes the resulting displayed
kind equal to the action the staff member chose.

The backend and dashboard each need one canonical mapping at their boundary. The
dashboard already owns `PM_ROLE = 'Property Manager'` for KindPicker and display.
The backend must use the same exact value when it derives the resulting kind for
AI-verdict comparison. Tests pin the value on both sides so they cannot drift
silently.

### D3. Classification is about the current contact, not people they mention

The prompt must stop defining every contact as a person seeking housing. It must
define the transcript's existing `client` speaker label as the external contact
whose profile is being classified. The wire label and `speakerRoles` values stay
unchanged for compatibility.

The model contract applies facts and kinds only to that current contact. A
represented tenant, owner, caseworker, or other person mentioned in the
conversation does not determine the speaker's kind and must not have their facts
written onto the current contact.

This is a semantic extraction rule, not a server-verifiable provenance guarantee.
The model receives the current profile, including existing notes, and the
transcript in one request. The server cannot prove which input sentence caused a
valid structured value. Prompt-contract tests pin the intended rule; the
structured schema and Unknown-only apply guard constrain what can be persisted.

Examples pinned in the prompt contract:

- "I am looking for a two-bedroom home for my family" -> Tenant.
- "I own three rental properties" -> Landlord.
- "I manage three properties for the owner" -> Property Manager, not Landlord
  and not Partner.
- "I am her caseworker at Hope Atlanta" -> Partner.
- "My caseworker at Hope Atlanta told me to call" -> Tenant when the speaker is
  seeking housing for themselves; the mentioned caseworker is not the contact.
- "I am calling about a client" without a clear outside role -> no suggestion.

### D4. The four kinds are mutually exclusive and evidence-based

`typeSuggestion` is allowed only when `CURRENT PROFILE.contactType` is `unknown`
and the transcript clearly establishes one of these:

1. **Tenant:** seeks housing for themselves or their household.
2. **Landlord:** owns or personally offers housing they control.
3. **Property Manager:** manages, leases, lists, or coordinates properties on
   behalf of an owner or landlord. Working for the landlord does not make the
   contact a Partner.
4. **Partner:** works in an outside service, program, agency, inspection, or
   navigation role for a tenant or housing process and is neither the housing
   seeker nor the property owner/manager.

When evidence overlaps or does not establish the distinction, emit `none`. The
prompt must not guess from an organization name, a third-person reference, or a
single ambiguous word such as "manager", "agent", or "client".

### D5. Notes preserve role facts without becoming a backfill mechanism

When a transcript clearly identifies a Partner or Property Manager, the model also
adds a concise note line containing the useful role or organization fact, for
example:

- `Identified as a caseworker at Hope Atlanta`
- `Identified as property manager for Example Homes`

The existing note reconciliation behavior remains authoritative. The prompt tells
the model not to repeat a fact already present in profile notes, to append only new
detail, and never to infer an organization that was not stated. The apply layer
continues to remove exact repeated lines before appending. A note survives a
dismissed type suggestion.

This feature does not add semantic note normalization or deterministic paraphrase
deduplication. Nor does it add a scan, migration, scheduled pass, or other backfill
mechanism. The prompt must require current-transcript evidence for a suggestion,
but the server does not attempt to prove that semantic provenance after the model
returns a valid structured value.

### D6. Suggestions remain advisory and Unknown-only

The schema parser accepts only the four canonical values. A stable pending
`target: 'type'` suggestion is valid only while the contact is `unknown`. A
classified contact produces the existing `type_already_classified` dropped
decision. No extraction result writes `type` or `role` directly. D11 closes the
stale-contact race in which an extraction started while the contact was Unknown
but tries to publish its suggestion as staff classifies the contact.

The raw-operation parser continues to retain off-enum values as attempted output
for audit diagnostics. That diagnostic behavior must not make an off-enum value
applicable.

### D7. Classification stays on the existing contact PATCH surface

The Unknown contact's Needs triage card displays the suggestion through an
explicit kind label map, so `property_manager` renders as `Property Manager`
rather than `Property_manager`.

The card copy names the four available kinds and offers four buttons in the same
order as the standard KindPicker segments:

1. Mark as Tenant
2. Mark as Landlord
3. Mark as Partner
4. Mark as Property Manager

The actions use the mappings in D2. The action container wraps at narrow widths so
four buttons do not overflow. Existing disabled/in-flight behavior applies to all
four actions.

The existing Edit contact action remains a second UI writer for an Unknown contact.
Its KindPicker sends the same D2 contact shapes through the same PATCH route, so it
can accept or supersede a pending AI type suggestion as part of a manual edit. It
must not gain a parallel mapping or resolution path.

The generic suggestion accept endpoint continues to refuse target `type`; both UI
entry points keep contact classification owned by the triage PATCH because that
route also handles status, conversation propagation, audit, and AI-verdict
resolution.

### D8. Verdicts compare the complete resulting kind

The contact PATCH route already snapshots the exact pending suggestion identity,
writes the contact, conditionally deletes only that retained suggestion, and then
stamps its originating AI run. Preserve that ordering and race fence.

For pending target `type`, derive the applied canonical kind from the updated
contact:

- `type: 'landlord'` plus exact role `Property Manager` -> `property_manager`
- `tenant`, `landlord`, or `partner` plus an absent or empty role -> the matching
  canonical value
- every other shape, including any other non-empty custom role -> no comparable
  supported kind

Normalize and compare that complete kind to the pending `suggestedValue`:

- same kind -> `accepted`
- a different kind or unsupported result -> `superseded_by_human_edit`

This prevents a Property Manager suggestion from being counted as accepted when a
staff member chooses plain Landlord merely because both share the stored Landlord
base. It also prevents any custom role, such as Leasing Agent, from being counted
as a plain canonical kind, and preserves the existing rule that choosing Landlord
after a Tenant suggestion supersedes the model.

If the exact pre-write suggestion is still current, its verdict uses this full-kind
comparison. A replacement first observed after the human write was not reviewed by
that human action, so its terminal verdict is `superseded_by_human_edit`, even if
its value happens to match the chosen kind.

### D9. Existing base behavior remains authoritative after classification

The existing contact PATCH route owns all downstream effects:

- Tenant -> `tenant_1to1`, status `onboarding`, and immediate triage
  re-extraction when enabled.
- Landlord and Property Manager -> `landlord_1to1`, status `interested`, with no
  tenant re-extraction.
- Partner -> `partner_1to1`, status `active`, with no tenant re-extraction.
- Linked phone and email conversations flip only from `unknown_1to1`; an already
  resolved conflicting conversation is not overwritten.
- Contact and conversation update events, audit records, conditional suggestion
  deletion, and AI verdicts retain their current best-effort/error contracts.

This feature does not introduce a parallel classification route or duplicate those
side effects in the dashboard.

### D10. Decision renderers show kind labels; forensic payloads remain raw

The AI run detail currently renders `proposedValue` raw. For the `type` decision,
the decision-ledger renderer must use the same canonical kind label mapping as the
Unknown card, so `property_manager` displays as `Property Manager`. Other decision
values retain their current rendering.

The stored AI run decision remains the canonical wire value for audit accuracy.
Only the decision label is humanized. The explicitly diagnostic `Raw model
response` and `Parsed result` panes remain exact forensic payloads and may contain
the canonical wire value `property_manager`; they must not be rewritten or
redacted by this feature.

### D11. Type suggestions use two-sided post-write race reconciliation

The current generic rule deliberately leaves a suggestion that replaces the
pre-write snapshot pending. That is correct for fields whose suggestion control
remains available after an edit. It is not correct for `type`: after classification
the Unknown card disappears and the generic accept endpoint refuses `type`. A
replacement would otherwise be visible in Today but have no review surface.

Use the existing suggestion revision identity and conditional delete on both sides
of the classification race:

1. **Extraction writer check.** After `applyExtraction` successfully puts a type
   suggestion, it consistently point-reads the current contact. If the contact is
   no longer Unknown, it conditionally deletes the exact suggestion it just wrote. A
   successful cleanup records the current extraction decision as dropped with
   `type_already_classified`, not as pending. If the delete loses to a newer
   suggestion, that newer writer owns the same post-write check. Any displaced
   earlier run retains the existing `superseded` stamping path.
2. **Classification writer drain.** After a contact PATCH results in a non-Unknown
   contact, the route first attempts the existing exact pre-write-snapshot
   resolution. It then performs a bounded consistent point-read/CAS drain of any
   current `target: 'type'` row. If the deleted row is the exact pre-write snapshot, use
   D8's full-kind verdict. If it was first observed after the contact write, stamp
   `superseded_by_human_edit`; the staff member did not review that replacement.
   Retry only when the CAS loses to another replacement, never with an
   unconditional delete.
3. **Interleaving invariant.** A suggestion published before the contact write is
   caught by the route. A suggestion published after the route's last read is
   caught by the extraction writer's post-put contact read. Thus, when point reads
   and conditional writes succeed, no pending type row remains on a classified
   contact. Repository failures keep the existing best-effort log-and-continue
   boundary rather than failing an otherwise successful contact PATCH.

This is a type-specific exception. The generic replacement policy for all other
suggestion targets stays unchanged.

## 5. Data flow

### 5.1 Extraction generation

1. The run window builds the current profile and transcript exactly as today.
2. The revised system prompt defines the external-contact meaning of `client`, the
   four kind rules, the property-manager boundary, and positive/negative examples.
3. Structured output restricts `typeSuggestion.value` to the four canonical kinds
   plus `none`.
4. Prompt and schema changes naturally produce a new extraction prompt
   fingerprint. No manual fingerprint constant is updated.

### 5.2 Parse, apply, and persistence

1. `parseExtractionText` folds `none` and invalid values to an absent suggestion
   and returns a typed four-kind value otherwise.
2. `applyExtraction` persists the canonical value as the existing `target: 'type'`
   pending suggestion, then performs D11's live-contact post-write check.
3. A suggestion that survives that check records the same value as
   proposed/coerced with a pending verdict. A successfully cleaned stale write is
   dropped as `type_already_classified`.
4. Existing suggestion replacement, dismissal tombstones, revision identity, SSE,
   and journal recovery mechanisms remain unchanged because the target and item
   shape do not change.

### 5.3 Staff review

1. The Unknown card reads the pending type suggestion and shows its canonical
   staff label and reason.
2. Staff chooses any of the four explicit classification actions, or uses the
   existing Edit contact KindPicker.
3. The dashboard sends the D2 `type` and `role` patch through the existing contact
   update client.
4. A failed card action leaves the contact Unknown and re-enables all actions for
   a retry. It does not optimistically remove the card.

### 5.4 Resolution

1. The route reads the current contact and exact pending suggestion identity.
2. It applies the contact patch and existing status/conversation effects.
3. It conditionally deletes the suggestion identity read before the write.
4. If that exact suggestion is still current and has a run id, it derives the full
   kind from the updated contact and records accepted or superseded.
5. D11's bounded CAS drain removes any replacement that raced with the
   classification and gives its run a terminal superseded verdict.
6. The returned contact immediately selects the existing TenantFile,
   LandlordFile, PartnerFile, or Property Manager display through current
   type/role behavior.

## 6. Existing surfaces that must move together

### 6.1 Model contract and backend readers/writers

- `app/src/services/extraction/prompt.ts`: external-contact framing, four-kind
  rules, examples, and notes.
- `app/src/services/extraction/schema.ts`: JSON schema enum and
  `parseExtractionText` allowlist/types.
- `app/src/adapters/extraction.ts`: shared `ExtractionResult` kind union.
- `app/src/adapters/extractionFake.ts`: no protocol change, but its typed fake
  payload must accept both new values through `ExtractionResult`.
- `app/src/services/extraction/apply.ts`: persist the two new canonical values
  through the existing Unknown-only suggestion path, then reconcile the exact
  written row against a live contact read per D11.
- `app/src/services/extraction/schema.ts` (`parseExtractionOps`): no raw-operation
  behavior change; retain off-enum diagnostic attempts and cover the new valid
  values in tests.
- `app/src/routes/contacts.ts`: full-kind derivation and verdict comparison after
  contact update; preserve conditional suggestion identity deletion, add the
  type-specific bounded replacement drain, and retain all existing triage side
  effects.
- `app/src/routes/suggestions.ts`: no behavior change; target `type` remains
  triage-only.
- `app/src/repos/extractionRepo.ts`: no stored shape change; let the D11 callers
  request a consistent `getSuggestion` point read and reuse
  `deleteSuggestionIfCurrent` revision fencing.
- Suggestion-resolution services, events, and Today aggregation: no stored shape
  or target change; verify they remain generic over `suggestedValue`. Today must
  not retain a type item after successful D11 reconciliation.

### 6.2 Dashboard writers/readers/renderers

- `dashboard/src/routes/contact/UnknownFile.tsx`: four labels, four actions, and
  widened callback kind.
- `dashboard/src/routes/contact/UnknownFile.module.css`: responsive action wrap.
- `dashboard/src/routes/contact/ContactDetail.tsx`: map the selected canonical kind
  to the D2 contact patch and apply the returned contact in place.
- `dashboard/src/routes/contact/ContactEditForm.tsx` and `KindPicker.tsx`: retain
  the existing Edit contact classification path and D2 mappings; verify that an
  edit resolves the pending type decision through the shared PATCH route.
- `dashboard/src/routes/contact/contactProfile.ts`: reuse the canonical
  `PM_ROLE`; add or expose a four-kind label/mapping helper rather than scattering
  string transforms.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx`: humanize the `type`
  decision's canonical kind without changing stored values.
- `dashboard/src/api/types.ts` and `endpoints.ts`: widen callback/request typing as
  needed; the persisted `SuggestionItem.suggestedValue` remains a string wire
  field.
- TenantFile, LandlordFile, PartnerFile, contact-list filters, inbox readers, and
  KindPicker: no behavior change. Verify that the returned type/role selects their
  current behavior correctly.

### 6.3 Seeds, imports, and operational seams

- Lean/full/performance seeds do not gain records or change byte-stable fixtures.
- Import classification remains authoritative for imported records and is not
  rerun.
- Manual extraction uses the same forward-only model contract but does not scan
  old contacts automatically.
- No production contact is read, edited, or queued by this feature.
- `docs/issues/caseworker-contact-type.md` closes when the implementation and
  verification are complete; its history remains in the issue body.

## 7. Error and race behavior

- A refusal, parse failure, truncated response, driver failure, or unsupported
  kind follows the existing AI-run failure/drop behavior and never changes the
  contact.
- A type suggestion for an already classified contact is dropped as
  `type_already_classified`.
- A contact PATCH failure leaves the pending suggestion intact unless the route's
  existing post-write best-effort path is the failing step.
- For targets other than `type`, a suggestion created or replaced during the
  contact update remains pending and unstamped under the existing identity fence.
- For `type`, D11 conditionally removes a racing replacement after classification
  and gives its linked decision a terminal verdict. It never unconditionally
  deletes a row it did not read.
- A classification action never overwrites an already resolved conflicting
  conversation type; the existing triage conflict behavior remains.
- Role strings are never inferred from organization names. Property Manager uses
  only the exact preset role, and Partner role/organization detail stays in notes.
- Existing profile notes are context for the model, not independently validated
  provenance. Current-transcript-only classification is a pinned model-contract
  rule, while the application-enforced forward-only guarantee is that no scan,
  migration, or scheduled backfill is introduced.

## 8. Testing

### 8.1 Backend unit and integration tests

1. Schema enum contains the four kinds plus `none`.
2. `parseExtractionText` returns Partner and Property Manager values, folds
   `none`, and drops an unsupported value.
3. Prompt-contract tests pin:
   - external contact is not assumed to seek housing;
   - owner versus property manager;
   - property manager versus partner;
   - caseworker self-identification versus mentioning one's caseworker;
   - ambiguous evidence produces no suggestion;
   - represented-person facts do not belong to the current contact;
   - concise reconciled note behavior.
4. `applyExtraction` persists Partner and Property Manager suggestions only for
   Unknown contacts and records the canonical decision values. A contact that is
   classified between the model call and the post-put live read leaves no pending
   type row and records `type_already_classified`.
5. Raw operation parsing recognizes the two new valid values while preserving an
   off-enum attempted value for diagnostics.
6. Contact triage tests prove:
   - Partner produces `partner_1to1` and `active`;
   - Property Manager stores the Landlord base plus exact preset role, produces
     `landlord_1to1`, and lands `interested`;
   - standard Landlord clears a stale Property Manager role;
   - a matching Property Manager suggestion is accepted;
   - choosing Landlord for a Property Manager suggestion is superseded;
   - matching Partner is accepted;
   - a non-empty custom role on tenant, landlord, or partner is unsupported and
     supersedes a pending plain-kind suggestion;
   - Edit contact uses the same full-kind verdict rules as the card actions;
   - a type replacement injected during a card classification and during an Edit
     contact classification is conditionally removed, is absent from the
     contact's pending list and Today, and receives a terminal
     `superseded_by_human_edit` verdict;
   - an empty pre-write snapshot followed by a racing type put is reconciled;
   - a second replacement during the bounded drain is handled by another exact
     read/CAS attempt;
   - conditional suggestion replacement for every non-type target retains the
     existing pending behavior.
7. Existing Tenant and Landlord triage and verdict tests remain green.

### 8.2 Dashboard component tests

1. Partner and Property Manager suggestions render their exact labels and reasons.
2. All four buttons render, are accessible by role/name, share busy/disabled state,
   and call the intended canonical kind.
3. ContactDetail sends each D2 `type`/`role` patch, uses the returned contact, and
   leaves the Unknown view retryable on failure.
4. Edit contact retains the D2 KindPicker mappings and resolves a pending type
   suggestion through the shared PATCH route.
5. The AI run detail renders `property_manager` as `Property Manager` in the type
   decision ledger while preserving raw forensic payload panes verbatim.
6. Existing Tenant/Landlord Unknown card tests remain green.

### 8.3 End-to-end tests

Extend the existing conversation fact extraction flow using the fake extraction
marker and a newly created Unknown contact:

1. Partner flow: fake extraction emits Partner plus a caseworker reason/note; the
   card shows `AI suggests: Partner`; staff clicks Mark as Partner; the Needs
   triage card disappears; the contact displays as Partner; the linked thread is
   `partner_1to1`; the suggestion is resolved.
2. Property Manager flow: fake extraction emits Property Manager plus a management
   reason/note; the card shows `AI suggests: Property Manager`; staff clicks Mark
   as Property Manager; the contact displays as Property Manager; its stored base
   behavior is Landlord; the linked thread is `landlord_1to1`; the suggestion is
   resolved.

The fake driver proves application plumbing, not real-model semantic accuracy. The
prompt contract, structured schema, and changed prompt fingerprint are the
deterministic proof available without a production model call.

### 8.4 Feature completion gates

After implementation, from the isolated feature worktree and after the one final
sync from current `main`, run these bare commands with real exit codes:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. Touched-file ESLint against `main...HEAD`, following the repository ratchet and
   empty-list rules in `AGENTS.md`.

Also run a hermetic interactive browser session for live self-QA of both new
classifications. Do not use production or the human's lane-0 dashboard.

## 9. Acceptance criteria

1. A clear caseworker or other outside service/program collaborator can produce a
   pending Partner suggestion for an Unknown contact.
2. A clear property manager can produce a pending Property Manager suggestion and
   is not suggested as Landlord or Partner.
3. An owner is Landlord; a manager acting for the owner is Property Manager.
4. A tenant who mentions their caseworker is not classified as that caseworker.
5. Ambiguous evidence produces no type suggestion.
6. Staff can apply all four kinds from the Unknown card; none auto-apply.
7. Property Manager acceptance stores the Landlord base plus exact Property
   Manager role and retains existing Landlord-backed conversation/status behavior.
8. AI-run verdicts distinguish Property Manager acceptance from a plain Landlord
   override.
9. Partner and Property Manager extraction can append concise stated
   role/organization facts through the existing prompt reconciliation and
   exact-line duplicate filter; semantic paraphrase deduplication is out of scope.
10. Existing suggestions remain compatible, existing seeds/imports remain
    unchanged, and no backfill runs.
11. Staff-facing suggestion labels and AI decision-ledger cells show `Property
    Manager`; explicitly raw forensic response/result panes retain canonical wire
    values.
12. After successful race-reconciliation reads and writes, no pending type
    suggestion or pending linked type verdict remains on a classified contact.
13. All required tests, full gates, adversarial reviews, and hermetic live QA pass
    before the branch is declared merge-ready.

## 10. Post-merge obligations

None expected beyond the normal human-owned deploy and feature-flag process. There
is no migration or backfill. Enabling or changing `AI_EXTRACTION_ENABLED`, deploying
the application, and any targeted production extraction run remain explicit human
operations outside this feature mission.
