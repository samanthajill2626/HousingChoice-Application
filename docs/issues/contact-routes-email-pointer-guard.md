---
id: contact-routes-email-pointer-guard
title: Contact routes 404 phone pointer rows but not email pointer rows
type: bug
severity: low
status: open
area: app/contacts
created: 2026-10-11
refs: app/src/routes/contacts.ts:1204, app/src/routes/contacts.ts:2152, app/src/routes/contacts.ts:2394, app/src/routes/contactTimeline.ts:1297, app/src/services/originateCall.ts:109, app/src/routes/unmatchedEmail.ts:406
---

**Problem.** A phone or email pointer (`phoneref#...` / `emailref#...`, with
`phone_ref` / `email_ref: true`) is an internal routing row in the contacts
table, not a contact. The contact routes guard the phone kind only:
`GET /api/contacts/:id` (`contacts.ts:1204`), its listings-sent, relay-groups,
group-threads and media reads (`:1223`, `:1267`, `:1358`, `:1437`),
`POST .../voice-opt-out` (`:2152`, which WRITES), `POST .../extraction-run`
(`:2394`), the contact timeline (`contactTimeline.ts:1297`) and call
origination (`originateCall.ts:109`). So an `emailref#...` id answers as if it
were a contact: the GET returns 200 with the pointer row (fix wave 2 reviewer,
scratch test; the phone pointer 404s), and voice-opt-out can write onto it.
`unmatchedEmail.ts:406` and `api.ts:2134` already check both kinds, and the
contacts PATCH and the caseworker conversion do since the caseworkers branch.

Reachable only by a deliberate API call with a URL-encoded pointer id; no UI
links to a pointer row. Pre-existing on `main`; found while reviewing the
caseworkers fix wave 2 (`docs/superpowers/reviews/2026-10-07-caseworkers/fix-wave-2-review.md`,
FW2-5).

**Suggested fix.** One predicate (for example `isPointerRow(item)` beside
`ContactItem` in `contactsRepo.ts`) used by every route guard above, with a
test per route that an email pointer id answers 404.
