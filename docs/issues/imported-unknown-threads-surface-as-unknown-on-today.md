---
id: imported-unknown-threads-surface-as-unknown-on-today
title: A reply on an imported contact's unknown_1to1 thread shows on Today as a new unknown contact, whatever the contact's type
type: bug
severity: low
status: open
area: app/today
created: 2026-10-08
refs: app/src/lib/import/apply.ts:1227, app/src/routes/today.ts:784, dashboard/src/routes/today/buildToday.ts:287, app/src/routes/contacts.ts:1530, app/src/routes/contacts.ts:1891, dashboard/src/routes/contact/ContactEditForm.tsx:306
---

**Problem.** The importer mints every imported one-to-one thread as
`unknown_1to1` (`upsertConversation` in `app/src/lib/import/apply.ts`,
`if_not_exists`), even for a contact it typed tenant, landlord or partner,
and never re-types a thread. An explicit contacts PATCH `type` re-types an
`unknown_1to1` thread (the triage flip), even when the supplied type equals
the stored type (`contacts.ts:1530-1531,1891-1896`). The edit form only sends
`type` on a kind change (`ContactEditForm.tsx:306`), so an imported contact
the importer already typed keeps its unknown thread through ordinary edits
that leave its kind unchanged. Today
decides by the THREAD type alone: an unread `unknown_1to1` thread becomes a
"New unknown contact" needs-you-now row (`app/src/routes/today.ts`, the
`conv.type === 'unknown_1to1'` branch; `buildToday.ts` the same), so a reply
from an imported tenant or partner - including a reply to a property share,
which now reaches partners too (`feat/caseworkers`, spec D20) - is presented
as an untriaged stranger. The caseworker conversion re-types a converted
caseworker's own threads to `partner_1to1`, so it fixes this for caseworkers
only. Pre-existing; verified against the code 2026-10-08. How often it
fires in production is unmeasured.

**Suggested fix.** Measure first: count open `unknown_1to1` threads whose
participant contact is typed tenant, landlord or partner (the
`app/scripts/measure-unread-contact-coverage.ts` pattern). Then either
re-type them once with a script (to `conversationTypeFor(contact)`, skipping
threads another live contact shares), or make the importer mint the
contact's type for a typed contact going forward - or both.
