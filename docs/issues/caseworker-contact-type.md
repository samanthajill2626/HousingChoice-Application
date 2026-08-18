---
id: caseworker-contact-type
title: Extraction cannot classify a caseworker - 'partner' exists but is not a suggestable type
type: decision
severity: med
status: open
area: app/contacts
created: 2026-07-17
refs: app/src/services/extraction/prompt.ts:65, app/src/services/extraction/schema.ts:124, app/src/adapters/extraction.ts:76, dashboard/src/routes/contact/UnknownFile.tsx:98, app/src/lib/import/merge.ts:410
---

**REFRESHED 2026-08-18.** The original problem statement (written 2026-07-17) said
the app had nowhere to put a caseworker. That half is SOLVED and the text below is
rewritten accordingly: `partner` became a first-class `ContactType` on 2026-07-21
(email-channel v1) and the glossary defines it as exactly this person - "an outside
collaborator we email/text 1:1 - a caseworker, an agency contact"
(`documentation/GLOSSARY.md`). Caseworkers are `partner` contacts, optionally
carrying the free-text role "Case worker". No `caseworker` union member is wanted,
and option 1 of the old suggested fix (extend the union) is withdrawn.

**Problem.** The extraction pipeline still cannot reach `partner`, so the AI can
never classify a caseworker even though a correct home now exists. When a contact
clearly self-identifies as a caseworker, the extractor is instructed NOT to emit a
`typeSuggestion` and to append a note line instead
(`[Auto - <date>] Identified as a caseworker (<org>)`). The contact stays `unknown`
in the triage queue with the classification captured only as free text, so
downstream filters, routing, and counts that key off `type` never see them. This is
the same behavior the issue described in July; only the reason it is wrong has
changed.

Four places pin it shut, in order along the path:

1. `services/extraction/prompt.ts:65-69` - explicitly forbids a `typeSuggestion`
   for a self-identified caseworker and tells the model to write a note instead.
2. `services/extraction/schema.ts:124` - the tool-call JSON schema enum is
   `['tenant', 'landlord', 'none']`, so `partner` is not even expressible.
3. `adapters/extraction.ts:76` - the TS shape is
   `typeSuggestion?: { value: 'tenant' | 'landlord'; reason?: string }`.
4. `dashboard/.../UnknownFile.tsx:98-115` - the Needs-triage card offers only
   "Mark as Tenant" and "Mark as Landlord", and its copy says "Classify them as a
   tenant or landlord". A human who reads the caseworker note has no one-click way
   to act on it from the card; the Edit dialog's kind picker is the only route.

NOT blocked: the backend already accepts the flip. `routes/contacts.ts:236-241`
allows the full union including `partner`, `services/extraction/apply.ts:534-546`
stores whatever `suggestedValue` string it is given for an `unknown` contact, and
the ops parser passes an off-enum value through as a suggest attempt
(`app/test/extractionOps.test.ts:73-78`, which pins the value `'caseworker'`).

The import path already does the right thing and is the precedent to follow:
caseworker-marked rows map to `partner` with a founder-facing review prompt
("Looks like a caseworker - imported as a partner contact. Correct?",
`lib/import/merge.ts:410-411`, `lib/import/reviewNotes.ts:123-125`), which is how
19 of the imported contacts were typed.

**Suggested fix.** One coherent change, not a union extension:

- Add `partner` to the schema enum, the adapter type, and the prompt rule - the
  prompt flips from "do NOT emit typeSuggestion" to "suggest `partner` when the
  person is clearly an outside collaborator (a caseworker or agency contact),
  naming the org in the reason".
- Keep the note line as well as the suggestion. The org is a real fact the
  suggestion alone does not carry, and it survives a declined suggestion.
- Add "Mark as Partner" to the triage card and widen its copy. Without this, an
  accepted-in-principle suggestion has no matching one-click action.
- Confirm the display path: `UnknownFile.tsx:94` capitalizes the raw suggested
  value, so a `partner` suggestion renders as "AI suggests: Partner" with no
  further work.

**The remaining decision** (why this is still `type: decision`, not a plain bug):
whether the AI is allowed to propose `partner` AT ALL, or whether an outside-party
classification should stay a human-only call because a mis-typed partner is
audience-visible - partners are now in the `'all'` fan-out across nine surfaces
(`useContacts.ts` `TYPES_FOR.all`, widened 2026-08-17). The suggestion is advisory
and a human clicks the button, which argues for allowing it; the counter-argument
is that a caseworker texting on a client's behalf reads a lot like the client. If
the answer is no, close this `wontfix` and keep the note-only behavior, but still
widen the triage card so a human can act on the note.

Related: `lean-seed-ha-staffer-should-be-partner` (the lean seed's HA staffer is
still typed `team_member` for the same historical reason - `partner` did not exist
yet), and `housing-authority-free-text-drift`, which carries the still-owed agency
ENTITY and the caseworker-to-agency link.
