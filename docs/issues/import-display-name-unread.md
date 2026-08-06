---
id: import-display-name-unread
title: Import writes contact display_name and nothing reads it - imported tenants render as a phone number
type: bug
severity: high
status: open
area: app
created: 2026-08-06
refs: app/src/lib/import/apply.ts, dashboard/src/routes/contact/format.ts, app/src/lib/import/names.ts
---

**Problem.** The Quo/Airtable import resolves a founder-reviewed name for every contact and writes
it to `display_name` (`app/src/lib/import/apply.ts:462-464`). It never writes `firstName` or
`lastName` - those are the only name writes in that file.

Nothing reads `display_name`. The only occurrence in `app/src` is that write, and `dashboard/src`
has none (the sole near-match is `participant_display_name`, an unrelated conversation field).
Every name the dashboard shows for a contact comes from `contactDisplayName`
(`dashboard/src/routes/contact/format.ts:101-110`), which composes first + last and falls back to
the formatted phone number when both are absent.

**Consequence.** After the 2026-08-10 cutover, every imported contact renders as its phone number -
`(404) 010-0007` - in the Contacts list, the contact detail header, tour and placement rows,
recipient previews, and anywhere else `contactDisplayName` is used. The founder reviews and
corrects roughly 150 names in the import workbook, and the app then displays none of them.

This is the whole point of the workbook's `name` column being editable
(`workbook.ts:34` - `CONTACT_EDITABLE` leads with `name`), so the review effort is currently
discarded at the last step.

**Suggested fix.** One of:

- **Split on apply.** Parse the reviewed name into `firstName`/`lastName` at import time and write
  those instead of (or alongside) `display_name`. `app/src/lib/import/names.ts` already does
  name parsing for the merge/suggestion path, so the capability exists.
- **Read `display_name` as a first-class fallback.** Teach `contactDisplayName` to prefer
  `firstName`/`lastName`, then `display_name`, then the phone. Smaller change, keeps the
  founder-reviewed string intact and unsplit, and benefits any future importer.

The second is probably right - a reviewed "Mary-Jo Van Der Berg" survives verbatim instead of being
guessed into two fields - but either closes the gap. Whichever lands, add an import test asserting
that an applied contact renders its reviewed name rather than a phone number.

**How it surfaced.** Adversarial spec review of the tenant-list visibility design
(`docs/superpowers/specs/2026-08-06-tenant-list-visibility-design.md`), which had assumed every
tenant has a name to display. Deliberately NOT fixed there - it is a pre-existing import gap, not
something a list-visibility change should absorb. Related: [[housing-authority-free-text-drift]]
(the same import writes no contact-side housing authority either).
