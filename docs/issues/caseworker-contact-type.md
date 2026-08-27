---
id: caseworker-contact-type
title: Extraction cannot classify a caseworker - 'partner' exists but is not a suggestable type
type: decision
severity: med
status: resolved
area: app/contacts
created: 2026-07-17
updated: 2026-08-26
resolved: 2026-08-26
refs: app/src/services/extraction/prompt.ts:buildExtractionSystemPrompt, app/src/services/extraction/schema.ts:EXTRACTION_SCHEMA.properties.typeSuggestion, app/src/adapters/extraction.ts:SuggestedContactKind, dashboard/src/routes/contact/UnknownFile.tsx:UnknownFile, app/src/lib/import/merge.ts:410
---

**REFRESHED 2026-08-18.** The original problem statement (written 2026-07-17) said
the app had nowhere to put a caseworker. That half is SOLVED and the text below is
rewritten accordingly: `partner` became a first-class `ContactType` on 2026-07-21
(email-channel v1) and the glossary defines it as exactly this person - "an outside
collaborator we email/text 1:1 - a caseworker, an agency contact"
(`documentation/GLOSSARY.md`). Caseworkers are `partner` contacts, optionally
carrying the free-text role "Case worker". No `caseworker` union member is wanted,
and option 1 of the old suggested fix (extend the union) is withdrawn.

The body through the Related paragraph is a pre-resolution historical snapshot of
the 2026-08-18 state. Resolution below records current behavior.

**Historical problem as of 2026-08-18.** The extraction pipeline could still not
reach `partner`, so the AI could never classify a caseworker even though a correct
home already existed. When a contact clearly self-identified as a caseworker, the
extractor was instructed NOT to emit a
`typeSuggestion` and to append a note line instead
(`[Auto - <date>] Identified as a caseworker (<org>)`). The contact stayed `unknown`
in the triage queue with the classification captured only as free text, so
downstream filters, routing, and counts that keyed off `type` never saw them. This
was the same behavior the issue described in July; only the reason it was wrong had
changed.

**Four places pinned it shut then, in order along the path:**

1. `buildExtractionSystemPrompt` explicitly forbade a `typeSuggestion` for a
   self-identified caseworker and told the model to write a note instead.
2. `EXTRACTION_SCHEMA.properties.typeSuggestion` had the tool-call JSON schema enum
   `['tenant', 'landlord', 'none']`, so `partner` was not even expressible.
3. `SuggestedContactKind` had the TS shape
   `typeSuggestion?: { value: 'tenant' | 'landlord'; reason?: string }`.
4. `UnknownFile` offered only "Mark as Tenant" and "Mark as Landlord", and its
   copy said "Classify them as a
   tenant or landlord". A human who read the caseworker note had no one-click way
   to act on it from the card; the Edit dialog's kind picker was the only route.

**What was not blocked then:** the backend already accepted the flip.
`routes/contacts.ts:257-260` allowed the full union including `partner`,
`services/extraction/apply.ts:535-546` stored whatever `suggestedValue` string it
was given for an `unknown` contact, and the ops parser passed an off-enum value
through as a suggest attempt
(`app/test/extractionOps.test.ts:80-84`, which pins the value `'caseworker'`).

The import path already did the right thing and was the precedent to follow:
caseworker-marked rows mapped to `partner` with a founder-facing review prompt
("Looks like a caseworker - imported as a partner contact. Correct?",
`lib/import/merge.ts:409-413`, `lib/import/reviewNotes.ts:123-125`), which is how
19 of the imported contacts had been typed.

**Suggested fix at the time.** One coherent change, not a union extension:

- Add `partner` to the schema enum, the adapter type, and the prompt rule - the
  prompt flips from "do NOT emit typeSuggestion" to "suggest `partner` when the
  person is clearly an outside collaborator (a caseworker or agency contact),
  naming the org in the reason".
- Keep the note line as well as the suggestion. The org is a real fact the
  suggestion alone does not carry, and it survives a declined suggestion.
- Add "Mark as Partner" to the triage card and widen its copy. Without this, an
  accepted-in-principle suggestion has no matching one-click action.
- Confirm the display path: `UnknownFile` capitalized the raw suggested value, so a
  `partner` suggestion rendered as "AI suggests: Partner" with no further work.

**Decision that remained at the time and was resolved 2026-08-26** (why this was
still `type: decision`, not a plain bug): whether the AI was allowed to propose
`partner` AT ALL, or whether an outside-party classification should stay a
human-only call because a mis-typed partner is audience-visible - partners were in
the `'all'` fan-out across nine surfaces (`useContacts.ts` `TYPES_FOR.all`, widened
2026-08-17). The suggestion was advisory and a human clicked the button, which
argued for allowing it; the counter-argument was that a caseworker texting on a
client's behalf reads a lot like the client. If the answer had been no, the issue
would have closed `wontfix` with the note-only behavior and a wider triage card so
a human could act on the note.

Related: `lean-seed-ha-staffer-should-be-partner` (the lean seed's HA staffer was
typed `team_member` for the same historical reason - `partner` did not exist yet),
and `housing-authority-free-text-drift`, which carried the then-owed agency ENTITY
and the caseworker-to-agency link.

## Resolution

Resolved by `feat/ai-contact-kind-suggestions`. The extraction contract now
supports Partner and the existing Property Manager preset, the Unknown card
offers all four canonical kind actions, and type suggestions are reconciled
against kind-changing contact revisions. Property Manager remains a Landlord-
based record with the exact `Property Manager` role. The change is forward-only:
no existing contact or suggestion was scanned or backfilled.
