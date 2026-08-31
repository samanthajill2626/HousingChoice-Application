# Adversarial design review: AI contact-kind suggestions (round 2B)

## Result

No material findings remain. The revised design closes the accepted round-one
findings without introducing a contradictory invariant or an unaccounted-for
classification writer/reader.

## Attack surfaces checked

1. **Full-kind verdict comparison and arbitrary roles.** D8 now makes a bare
   Tenant, Landlord, or Partner require an absent/empty role and treats every
   other role-bearing shape as unsupported. That matches the live display rule:
   `displayKind` uses any non-empty role instead of the base type
   (`dashboard/src/routes/contact/contactProfile.ts:23-33`). It also covers the
   actual generic role mutation surface, which parses any trimmed role and
   writes a non-empty role to the contact PATCH (`app/src/routes/contacts.ts:634-638`).
   The new backend tests explicitly require the previous counterexamples:
   non-empty custom roles on all three plain canonical types supersede rather
   than accept.

2. **All staff classification writers.** The revised D7 identifies both the
   Unknown-card action path and Edit contact/KindPicker path as writers using
   the shared PATCH and D8 verdict behavior. This is empirically the complete
   dashboard classification surface: the current card exposes `onTriage` and
   Edit (`dashboard/src/routes/contact/UnknownFile.tsx:90-125`), ContactDetail
   calls the shared `updateContact` PATCH (`dashboard/src/routes/contact/ContactDetail.tsx:637-645`),
   and ContactEditForm owns type+role through KindPicker
   (`dashboard/src/routes/contact/ContactEditForm.tsx:129-141,232-240,451-456`).
   KindPicker already maps Property Manager to landlord plus the exact preset
   role (`dashboard/src/routes/contact/KindPicker.tsx:101-112`). The spec now
   requires shared-route verdict coverage for the edit path as well as the card.

3. **Audit rendering contract.** D10 and acceptance criterion 11 now make the
   scope precise: humanize the decision-ledger label only, retain the explicit
   forensic Raw model response and Parsed result payloads exactly. This matches
   the three separate live renderers in
   `dashboard/src/routes/settings/aiRuns/AiRunDetail.tsx:67-69`, so the prior
   impossible "never raw" guarantee is gone rather than cosmetically tested
   around.

4. **Prompt semantics versus application-enforced behavior.** D3, D5, D7, and
   the acceptance criteria now accurately classify current-contact attribution,
   transcript evidence, and semantic note reconciliation as prompt-contract
   behavior. They no longer claim the server can prove provenance it does not
   retain. The stated enforced boundary remains real: valid values are
   Unknown-only in the apply path (`app/src/services/extraction/apply.ts:534-575`),
   while no scan/migration/scheduled backfill is introduced. The exact-line
   duplicate filter is acknowledged rather than overstated.

5. **Contract and downstream behavior.** The spec names the real raw-operation
   owner, `parseExtractionOps` in `schema.ts`; no nonexistent `ops.ts` remains.
   It preserves the established partner triage behavior confirmed by the current
   route: `partner` is an allowed contact type
   (`app/src/routes/contacts.ts:251-261`) and maps to `partner_1to1`
   (`app/src/routes/contacts.ts:456-462`). The revised surface list still covers
   schema, typed adapter, fake driver, apply, PATCH resolution, both dashboard
   writers, the decision renderer, generic suggestion machinery, seeds/imports,
   and manual extraction.

## Non-findings

The Edit form's dirty PATCH can omit `role: ''` when the selected standard kind
already has no role. That is observationally equivalent to D2's intended
resulting shape, because the stored role is already absent; it does not weaken
D8's post-update full-kind comparison. It is not a separate mapping or a
verdict bypass.
