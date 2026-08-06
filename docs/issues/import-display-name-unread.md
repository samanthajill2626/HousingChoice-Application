---
id: import-display-name-unread
title: Import writes contact display_name and nothing reads it - imported tenants render as a phone number
type: bug
severity: high
status: resolved
area: app
created: 2026-08-06
resolved: 2026-08-06
refs: app/src/lib/import/apply.ts, dashboard/src/routes/contact/format.ts, app/src/lib/import/names.ts, app/src/lib/mergeFields.ts, app/src/services/extraction/schema.ts
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

---

**Resolution (2026-08-06).** Fixed by **splitting on apply** (the first option),
with one refinement the issue could not have anticipated, plus a second defect the
investigation turned up. `app/src/lib/import/apply.ts` now writes `firstName` /
`lastName` via an exported `splitReviewedName`, and `display_name` is REMOVED
rather than left alongside - a field nothing reads is a trap for the next reader.

**Adjudication: why splitting, and not the `display_name` fallback.** The issue
leaned toward option 2 ("a reviewed 'Mary-Jo Van Der Berg' survives verbatim
instead of being guessed into two fields"), and for DISPLAY that reasoning is
sound - `contactDisplayName` re-joins the parts, so any split renders identically
and cannot be got wrong.

But display is not the only consumer. `app/src/lib/mergeFields.ts` `renderBody`
substitutes the broadcast token `[TenantName]` with **`firstName` ALONE**, falling
back to `NEUTRAL_TENANT_NAME` (`'there'`) when it is undefined. Option 2 leaves
`firstName` unset, so the outcome measured against the real export is:

| Approach | Broadcast greeting, 478 named tenants |
| --- | --- |
| Split (adopted) | Correct for **468** |
| Read `display_name` | `"Hi there,"` for **all 478** |

So option 2 fixes the visible symptom and silently makes every imported tenant
impersonal in the one place the name is actually sent to a human. Splitting is the
better trade even before the refinement below.

**The refinement.** The issue's instinct was not wrong - splitting does damage
some names. Measured: of 478 named tenants, **10** lead with an honorific
(`Ms. Cooper`, `Miss Johnson`, `Ms Kendrick`, `Miss Stukes`, `Miss Heard`,
`Ms. Burns`, `Ms. Jones`, `Ms. Jan`, `Ms. Yisrael`, `Ms. Que`), and a naive
first-token split greets them `"Hi Ms.,"` in a real text message.
`splitReviewedName` therefore keeps an honorific attached to the following token:
`firstName` = `"Ms. Cooper"`, which renders identically and greets her
`"Hi Ms. Cooper"`. 107 single-token names yield an empty `lastName`, which both
renderers filter before joining.

**Second defect, found by auditing for the same class.** Every other field the
import writes (`type`, `phone`, `phones`, `voucherSize`, `notes`, `status`,
`status_source`, `sms_opt_out`, `consent_method`) has many readers -
`display_name` was uniquely dead. But the audit surfaced the sibling this issue
already points at: **the import wrote no contact-side `housingAuthority`**
(`housing-authority-free-text-drift` consequence 4).

The import spec had justified that omission on the grounds that the founder's
values are "programs, not authorities". **That was wrong by the app's own
definition** - `HOUSING_AUTHORITY_VOCAB` (`services/extraction/schema.ts`)
contains `'Georgia Housing Voucher (GHV)'`, `'HUD VASH'`, `'Claratel'` and
`'Hope Atlanta'` verbatim, alongside `'Atlanta (AHA)'`. Imported tenants were
unreachable by authority-filtered broadcasts for a reason that was not true.
`apply.ts` now maps the Airtable program onto the EXACT vocabulary strings
(`housingAuthorityFor`), because audience resolution does an exact hash match on
the `byHousingAuthority` GSI - a near-miss spelling makes a tenant invisible to a
targeted send and nothing reports the skip. Values outside the vocabulary are
reported and left unset: a wrong authority sends a property to the wrong
audience, which is worse than an empty one. The wider two-name/two-vocabulary
drift stays open under `housing-authority-free-text-drift`.

**Tests.** Three added in `app/test/importApply.integration.test.ts`:

- `writes the name fields the app actually renders from` - reproduces
  `displayNameOf`'s logic and asserts the STORED SHAPE satisfies it, and that
  `display_name` is absent.
- `keeps an honorific attached so broadcasts do not greet someone "Hi Ms."` -
  honorifics, multi-word surnames, single tokens, bare honorific.
- `maps the Airtable program onto the exact housing-authority vocabulary` -
  including that unknown values stay unset.

Note that **two pre-existing tests asserted `display_name`**, which is why they
passed while the bug existed - they pinned the field we happened to write rather
than the contract the app reads. Both updated. That is the generalisable lesson
here: assert against the consumer's resolver, not the producer's field.

**Verified on the real export**, not only the fixture: re-imported all 629
contacts and resolved each through `displayNameOf`'s exact logic - 539 render with
a name (the workbook's own count), 90 as bare phones (the genuinely unnamed
orphan numbers, correct), 0 still carrying `display_name`, 0 whitespace artifacts.
17 receive a housing authority, all 4 distinct values in-vocabulary, 0
off-vocabulary. Gates green against current main: `npm run typecheck`, 84 import
tests, `npm run e2e` 204 passed.

**Coverage caveat, deliberately not fixed here.** Only 17 of 629 contacts carry
any authority value, because only 12 of 478 tenants have one in Airtable. That is
a founder-data gap (it is question 9 on the founder review document), not an
import defect.
