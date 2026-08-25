---
id: today-shows-phone-instead-of-name
title: Today shows a bare phone number instead of the person's name on ~580 threads, because it reads a denormalized name nothing keeps in sync
type: bug
severity: high
status: open
area: app/today
created: 2026-08-25
refs: app/src/routes/today.ts:1074-1081, app/src/routes/contacts.ts:1613-1650, app/src/routes/inbox.ts:817
---

**Problem.** Today's `who` label reads the DENORMALIZED name off the
conversation row and never consults the contact:

```
function whoOfConversation(conv: ConversationItem): string {
  if (typeof conv.participant_display_name === 'string' && conv.participant_display_name.length > 0) {
    return conv.participant_display_name;
  }
  return formatPhoneForDisplay(conv.participant_phone) ?? '';
}
```

That field is maintained only by the contact-update fan-out, which has holes.
Measured 2026-08-25 with
`app/scripts/measure-unread-contact-coverage.ts --confirm --audit-denorm`:

| | dev | prod |
| --- | --- | --- |
| open 1:1 threads | 636 | 684 |
| **contact HAS a name, thread carries none** | **592** | **579** |
| thread name differs from the contact's | 0 | 2 |

So on roughly 85% of open threads, Today's Needs-you-now and Unreplied rows show
a **phone number where the operator should see a person**. The two prod rows with
a differing name render the OLD name as if it were current.

**The inbox does not have this problem, which is why it went unnoticed.**
`routes/inbox.ts:817` builds its row name from the HYDRATED contact
(`nameFromContact(contact) ?? fallbackLabel`), so the same thread shows a name in
the inbox and a phone number on Today. That divergence is the tell.

**How this was nearly dismissed.** A first pass checked only the inbox row,
found it hydrates, and concluded "nothing renders `participant_display_name`" -
which was then used to argue the drift was costless and could be ignored. Two
independent reviewers of the Unknown-tab design caught it against
`today.ts`. The generalisation from one surface to all surfaces was the error;
the measurement was fine.

**Suggested fix.** Decide the READ before fixing the WRITE - the same question
this cluster keeps mishandling.

1. **Hydrate on Today, as the inbox does.** Today already resolves contacts for
   other purposes on these rows; if the contact is in hand, prefer its name and
   keep the denormalized value only as a fallback. Correct by construction, no
   backfill, and it removes a reader from the denormalization rather than adding
   trust to it. Check what it costs first - Today's read is capped but not free.
2. **Fix the fan-out and backfill.** Keeps Today's read cheap but makes the
   stale field authoritative, which means every writer of a contact name must
   propagate, forever. The fan-out's known holes are listed in
   [`inbox-filter-tabs-full-walk`](./inbox-filter-tabs-full-walk.md).

Option 1 is likely right BECAUSE the field has no other live reader worth
preserving - but confirm that before choosing, since this file exists precisely
because someone assumed a field's readers without sweeping for them.

**Related, and NOT the same bug.** `participants[].name` on group rosters is a
different denormalized name with its own staleness and its own reach into
outbound message content - see
[`group-roster-name-snapshot-never-refreshed`](./group-roster-name-snapshot-never-refreshed.md).
Three denormalized name surfaces are now known; do not assume that is the whole
set.
