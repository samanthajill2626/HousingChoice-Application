---
id: caseworker-contact-type
title: No 'caseworker' ContactType - extraction downgrades caseworker self-ID to a note
type: decision
severity: med
status: open
area: app/contacts
created: 2026-07-17
refs: app/src/services/extraction/apply.ts, app/src/services/extraction/prompt.ts
---

**Problem.** The n8n world model treats caseworkers as first-class contacts, but the
app's `ContactType` union is `tenant | landlord | team_member | unknown` - there is
no `caseworker`. The v1 conversation-fact-extraction feature therefore cannot classify
a caseworker: when a contact clearly self-identifies as a caseworker, the extractor is
instructed NOT to emit a `typeSuggestion` and instead adds a notes line
`[Auto - <date>] Identified as a caseworker (<org if stated>)`, and the contact stays
in triage (`unknown`). This means a real, useful classification is captured only as
free text and the person never leaves the Needs-triage state, so downstream filters,
routing, and counts that key off `type` never see them as caseworkers.

**Suggested fix.** Decide one of:

1. **Add `ContactType 'caseworker'`** - extend the union, teach the parsers, the
   dashboard triage buttons, and any type-keyed filters/counts, then let extraction
   emit a `caseworker` type suggestion like it does for tenant/landlord. Larger blast
   radius (every `switch (contact.type)` and UI that enumerates types).
2. **Keep notes-only** - accept that caseworkers are a note on an `unknown`/`team_member`
   contact and are not a distinct modelled type; close this as `wontfix` with that
   rationale.

This was flagged in the plan's Global Constraints adjudication (2026-07-16) as a
deferred product decision, not a bug in the shipped v1 behavior.
