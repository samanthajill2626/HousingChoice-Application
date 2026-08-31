# Adversarial design review: AI contact-kind suggestions (round 1A)

## 1. [HIGH] The audit-label guarantee is false: Raw model response and Parsed result still expose `property_manager`

### What is wrong

D10 says staff-facing audit renderers must render the `type` decision through a canonical kind-label map, and Acceptance Criterion 11 says they must **never** show raw `property_manager`. The proposed mechanism only changes the decision-ledger cell. The same staff-facing AI run detail deliberately renders both the unmodified raw model JSON and `JSON.stringify` of the parsed result. Either contains `typeSuggestion.value: "property_manager"` for the new flow.

This is also internally contradictory: D10 says the stored decision remains the canonical wire value and only display is humanized, but it neither defines a presentation-safe transformation for the two diagnostic panes nor exempts them from the word "never." A test of the ledger alone, as specified in 8.2.4, will pass while the acceptance criterion still fails.

### Evidence

- Spec D10, lines 238-246; data flow 5.4, lines 282-291; test 8.2.4, lines 393-402; Acceptance Criterion 11, lines 456-457.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:67` renders `decision.proposedValue` directly in the decision ledger today.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:68` renders `run.rawText` verbatim under **Raw model response**.
- `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:69` renders `JSON.stringify(run.rawResult, null, 2)` under **Parsed result**.
- The raw operation parser retains a non-`none` type value verbatim for audit, including the new one: `app/src/services/extraction/schema.ts:420-429`.

### What it implies

The design must make a deliberate choice and specify every audit presentation: either narrowly require a friendly label only in the decision ledger and explicitly exempt diagnostic raw payload panes, or define a safe display projection for raw/parsed payloads plus tests proving no staff-visible `property_manager` remains. It cannot truthfully promise both canonical diagnostic raw output and the unconditional "never show raw" criterion without this decision.

## 2. [MEDIUM] "Unknown card is the only acceptance surface" omits the existing Edit-contact classification path

### What is wrong

D7 declares the Unknown card to be the only acceptance surface and defines the type triage actions as the path that owns status, conversation propagation, audit, and AI verdict resolution. In the current dashboard, every Unknown card has an Edit action; Edit contact exposes the same KindPicker, whose Property Manager preset writes `landlord` plus `Property Manager`, and submits the same PATCH route. Therefore staff can apply a pending Partner or Property Manager recommendation without using the Unknown card. The route snapshots/deletes the `type` suggestion and stamps its verdict for any PATCH whose changed fields include `type`, so this is not merely a cosmetic second UI.

The spec does not enumerate this writer, specify whether this is an intended acceptance/override path, or require a test for its full-kind verdict behavior. A builder can make the four card buttons correct while leaving a second actual acceptance surface outside the new mapping's contract.

### Evidence

- Spec D7, lines 176-196, calls the Unknown card the only acceptance surface; D8, lines 198-219, assigns verdict semantics to the contact PATCH route; testing section 8.2 only covers the card.
- `dashboard/src/routes/contact/UnknownFile.tsx:121-131` renders Edit for an Unknown contact, and `dashboard/src/routes/contact/ContactDetail.tsx:1030-1047` wires that callback.
- `dashboard/src/routes/contact/ContactEditForm.tsx:1-9` states that Type + role are editable with the same KindPicker; `:232-239` includes changed `type` and `role` in the PATCH; `:350-391` sends it through `updateContact`.
- `dashboard/src/routes/contact/KindPicker.tsx:101-112` maps the Property Manager segment to `{ type: 'landlord', role: PM_ROLE }` and standard segments to a cleared role.
- `app/src/routes/contacts.ts:1506-1555` snapshots a pending suggestion for every changed field, conditionally deletes it after the PATCH, and stamps the AI-run verdict. Thus the Edit flow will resolve a pending type suggestion too.

### What it implies

The design must either acknowledge Edit contact as a second classification/AI-resolution surface and require it to use the same canonical kind mapping plus full-kind verdict tests, or explicitly change that existing UI/route behavior. Calling the card the sole surface is not a description a new builder can safely follow.

## 3. [MEDIUM] The no-duplicate role-note guarantee is prompt wishful thinking, not an enforced invariant

### What is wrong

D5 and Acceptance Criterion 9 guarantee that role/organization facts are reconciled, append only new detail, and are not duplicated. The mechanism is only a model-prompt instruction plus a verbatim substring check in `applyExtraction`. The model can output semantically identical but non-identical text on every later extraction (for example, existing `Identified as a caseworker at Hope Atlanta` and new `Caseworker with Hope Atlanta`); each is appended. This feature increases that exposure by requiring Partner and Property Manager note lines whenever the role is clear.

The listed prompt-contract test can only assert that instructions are present in a string. It cannot establish that a production model will produce an exact repeat, much less a semantically reconciled new-detail line. The stated acceptance criterion is therefore not delivered by the proposed mechanism.

### Evidence

- Spec D5, lines 149-162, requires non-repeated reconciled role/organization notes; test 8.1.3, lines 371-377, proposes only prompt-contract proof; Acceptance Criterion 9, lines 450-453, requires no duplicates/inferred data.
- `app/src/services/extraction/prompt.ts:77-90` instructs the model to reconcile notes, but does not provide a structured identity or a deterministic role/organization key.
- `app/src/services/extraction/apply.ts:664-694` only trims candidates and rejects one when `existing.includes(`${prefix} ${line}`)` or `existing.includes(line)`); it does no fact, organization, or role normalization.
- `app/src/services/extraction/apply.ts:689` appends every remaining line to the scalar notes field.

### What it implies

The spec must reduce its claim to best-effort model behavior, or define an enforceable representation/comparison for the new role facts and tests with paraphrased duplicates. Without one of those, repeated automatic/manual extraction will silently accumulate contradictory or redundant Partner/Property Manager notes while the prescribed tests remain green.

## 4. [LOW] The required raw-operation surface is named incorrectly, so the build map is not executable as written

### What is wrong

Section 6.1 directs the builder to update `app/src/services/extraction/ops.ts` and says that file retains off-enum diagnostic attempts. There is no such file in this repository. The raw-operation parser is `parseExtractionOps` in `schema.ts`; it is imported directly by the extraction job. This is not a harmless filename typo in a feature whose audit behavior depends on exactly that parser: a builder following the required-surface list cannot find the stated owner, and the planned tests have no actual module target.

### Evidence

- Spec 6.1, lines 297-315, names `app/src/services/extraction/ops.ts`.
- `rg --files app/src/services/extraction` contains `schema.ts`, `apply.ts`, `decisions.ts`, `prompt.ts`, `runTypes.ts`, `runWindow.ts`, and `address.ts`, but no `ops.ts`.
- `app/src/services/extraction/schema.ts:369-440` defines `parseExtractionOps`, including the type attempted-value handling at `:420-429`.
- `app/src/jobs/extraction.ts:48` imports `parseExtractionOps` from `../services/extraction/schema.js`, and uses it at `:558` and `:584` to construct the AI-run decision ledger.

### What it implies

Correct Section 6.1 and the implementation/test instructions to name `schema.ts` (or explicitly introduce a real extracted module, if that is intended). Otherwise the design is not self-contained and risks a needless new parallel parser or missed audit coverage.
