---
id: soft-deleted-contact-still-extractable
title: The automatic extraction path still writes facts into a soft-deleted contact
type: bug
severity: med
status: open
area: app/extraction
created: 2026-08-16
refs: app/src/jobs/extraction.ts:427, app/src/jobs/extraction.ts:436, app/src/routes/contacts.ts:1972
---

**Pre-existing.** This is NOT created by the manual-extraction-trigger feature.
Found while specifying that feature (design section 9, item 4) and filed rather
than fixed - the feature deliberately closes the gap at the button only.

**Problem.** The extraction job resolves the conversation's contact and then
applies exactly two eligibility gates:

- `app/src/jobs/extraction.ts:427` - the contact must exist and must not be a
  phone-pointer row.
- `app/src/jobs/extraction.ts:436` - the contact type must not be `landlord`,
  `partner` or `team_member`.

Neither is a soft-delete check, and there is no other one on the path. A contact
that staff have soft-deleted (`deleted_at` set, hidden from every normal view)
still has live conversations, so a later inbound message schedules a run, the
poll claims it, a real model call is billed, and extracted facts are applied onto
the deleted record - a suggestion chip nobody will ever see, or an `Auto`-badged
write onto a contact that was removed from view on purpose. If the contact is
later restored, it comes back carrying values written while it was deleted, with
no signal that they arrived post-deletion.

**Deliberate divergence, recorded.** The manual trigger added by
`feat/manual-extraction-trigger` REFUSES a press on a soft-deleted contact with
409 `contact_deleted` (`app/src/routes/contacts.ts:1972`, design 4.5). It does
NOT change the job. The two paths therefore disagree on purpose, and the code
says so at the refusal site:

```
app/src/routes/contacts.ts:1973-1976 (comment)
Deliberate divergence from the job, which has no soft-delete check:
spending money to write facts onto a record staff have removed from
view is not something to do on a human's button press. The parity gap
on the automatic path is filed as its own issue.
```

This file is that issue. The reasoning for the split: refusing a human's press is
a cheap, obviously-correct guard at one call site; changing the job's eligibility
rule changes behaviour for every automatic run in the system and belongs in its
own change with its own tests, not smuggled in behind a button.

**Suggested fix.** Add the soft-delete check to the job's eligibility gate
alongside the type check, skipping with a distinct `skipReason` (e.g.
`contact_deleted`) so the run log distinguishes it from `no_contact` and
`ineligible_type`. Decide separately whether an inbound message on a
soft-deleted contact's thread should schedule extraction at all - refusing at
`scheduleExtraction` time is cheaper than skipping at run time, but it moves the
policy away from the single place that currently owns eligibility.
