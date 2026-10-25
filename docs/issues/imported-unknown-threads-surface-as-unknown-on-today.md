---
id: imported-unknown-threads-surface-as-unknown-on-today
title: An imported contact's one-to-one thread stays unknown_1to1 whatever the contact's type; only the 404 fallback Today still lists a reply on it, under Identify these contacts
type: bug
severity: low
status: open
area: app/today
created: 2026-10-08
updated: 2026-10-24
refs: app/src/lib/import/apply.ts:1227, app/src/routes/today.ts:961, dashboard/src/routes/today/buildToday.ts:263, app/src/routes/contacts.ts:1543, app/src/routes/contacts.ts:1916, dashboard/src/routes/contact/ContactEditForm.tsx:306
---

**Problem.** The importer mints every imported one-to-one thread as
`unknown_1to1` (`upsertConversation` in `app/src/lib/import/apply.ts`,
`if_not_exists`), even for a contact it typed tenant, landlord or partner,
and never re-types a thread. An explicit contacts PATCH `type` re-types an
`unknown_1to1` thread (the triage flip), even when the supplied type equals
the stored type (`contacts.ts:1543-1544,1911-1919`). The edit form only sends
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

**Update (2026-10-24, tracker #31, `feat/today-checklist`).** Today no longer
shows these rows. Its unread pass keeps an `unknown_1to1` thread only when the
thread's owner contact is type `unknown` and not Inactive (spec
`docs/superpowers/specs/2026-10-23-today-checklist-design.md` 5.2;
`app/src/routes/today.ts:961`), so a reply on an imported tenant's,
landlord's or partner's unknown thread stays in the inbox, where it belongs.
Still open: the threads themselves stay `unknown_1to1` (the importer and the
same-type PATCH behavior above are unchanged), and the dashboard's fallback
Today (`dashboard/src/routes/today/buildToday.ts:263`, used only when GET
/api/today answers 404) still lists every unread `unknown_1to1` thread, now
under Identify these contacts. The suggested fix (measure, then re-type or
mint the right type) still applies.
