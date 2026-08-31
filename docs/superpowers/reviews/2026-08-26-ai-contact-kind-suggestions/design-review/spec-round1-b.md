# Adversarial design review: AI contact-kind suggestions

## 1. [HIGH] The proposed verdict derivation accepts custom roles as plain canonical kinds

**What is wrong.** D8 says to derive `property_manager` only for the exact
`landlord` + `Property Manager` shape, but then says every other `tenant`,
`landlord`, or `partner` shape maps to that bare canonical kind. That is not a
complete staff-facing-kind derivation. A non-empty role is the displayed kind,
not merely decorative metadata. Therefore `type: 'landlord', role: 'Leasing
Agent'` would derive `landlord` and mark a pending `landlord` suggestion
accepted, even though the resulting staff-facing kind is Leasing Agent. The
same failure applies to a tenant or partner with a custom role.

**Evidence.** Spec D2 promises acceptance only when the resulting *full kind*
matches the recommendation; D8's stated fallback ignores `role`. The live
dashboard makes any non-empty role win over the type label in
`dashboard/src/routes/contact/contactProfile.ts:23-33`. The generic contact
PATCH accepts arbitrary roles and includes `role` in changed fields in
`app/src/routes/contacts.ts:634-638`, so this is a real mutation surface, not
an impossible shape. The planned tests in 8.1 test PM versus plain Landlord,
but not any other role-bearing contact.

**Implication.** The AI-run accuracy ledger will report a false acceptance for
a human selection/edit to a custom kind. D8 must define bare Tenant, Landlord,
and Partner as requiring an absent/empty role, treat every other role-bearing
shape as unsupported/superseded, and require tests for each relevant custom
role path.

## 2. [MEDIUM] The "never show raw property_manager" criterion contradicts the retained raw audit renderer

**What is wrong.** D10 only changes the decision-ledger cell, while acceptance
criterion 11 says staff-facing suggestion and audit renderers never show raw
`property_manager`. The same AI-run detail view also renders the unmodified raw
model response. A successful structured response necessarily contains the raw
wire value, so the detail view will still expose `property_manager`.

**Evidence.** Spec D10 says only the display of the decision is humanized and
the canonical wire value remains stored; criterion 11 uses the unqualified word
"never." The existing audit view renders the decision's `proposedValue` at
`dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:67` and independently
renders `run.rawText` verbatim at
`dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:68`.

**Implication.** The implementation cannot both retain an exact raw-model audit
payload and satisfy the literal acceptance criterion. The spec must explicitly
exclude the forensic raw-response disclosure from the humanization promise, or
specify a different raw-response rendering/redaction policy and tests. Leaving
this ambiguous invites a cosmetic patch that still fails its stated criterion.

## 3. [MEDIUM] The current-contact and no-backfill guarantees are prompt slogans, not enforced invariants

**What is wrong.** D3/D5 promise that facts and kind apply only to the current
contact and that an old note alone cannot create a type suggestion. The proposed
mechanism is prompt wording plus prompt-contract tests. Once the model emits a
valid enum value, the apply layer has no evidence tying it to a current
utterance or to the contact rather than a person mentioned in the conversation;
it blindly persists the type suggestion for an Unknown contact and appends the
note. The model receives both stored notes and transcript in the same request,
so the application cannot tell whether its output was inferred from an old note.

**Evidence.** The existing prompt input is explicitly the CURRENT PROFILE and
the complete transcript (`app/src/services/extraction/prompt.ts:19-27` and
`app/src/services/extraction/prompt.ts:156`); profile construction includes
the contact notes (`app/src/jobs/extraction.ts:130-164`). The existing apply
path writes every valid `result.typeSuggestion` for an Unknown contact without
source validation (`app/src/services/extraction/apply.ts:534-575`) and appends
model note lines after only text-based duplicate filtering
(`app/src/services/extraction/apply.ts:657-694`). Section 8.3 expressly says
the fake driver does not prove real-model semantic accuracy.

**Implication.** A model that treats "my caseworker ..." or a prior note as the
contact's identity can create exactly the misclassification/backfill D3/D5 say
cannot happen. Either narrow these to advisory prompt expectations (and do not
present them as guarantees), or add a deterministic provenance/eligibility
mechanism that the server can validate; the current test plan proves neither.
