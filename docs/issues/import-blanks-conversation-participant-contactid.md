---
id: import-blanks-conversation-participant-contactid
title: A re-import unconditionally overwrites a 1:1 conversation's participants and can blank an established contactId
type: bug
severity: med
status: open
area: app/import
created: 2026-08-25
refs: app/src/lib/import/apply.ts:389-392, app/src/lib/import/apply.ts:1095, app/src/lib/import/apply.ts:1121-1200, app/src/services/contactCapture.ts:139-190
---

**Problem.** `upsertConversation` builds its update with `if_not_exists` on
every field it means to protect - `type`, `status`, `ai_mode`, `created_at` -
and then writes `participants` with a bare assignment:

```
'#type = if_not_exists(#type, :type)',
'#status = if_not_exists(#status, :status)',
'ai_mode = if_not_exists(ai_mode, :aiMode)',
'created_at = if_not_exists(created_at, :createdAt)',
'participants = :participants',      <- unconditional
```

The value it assigns comes from the import's own phone map and falls back to an
EMPTY STRING when the phone is not in it (`apply.ts:389-392`):

```
participants: roster.map((phone) => ({
  contactId: contactIdByPhone.get(phone) ?? '',
```

So a re-import of a thread whose participant phone is absent from that run's map
- a partial export, a dropped row, a phone that changed shape between exports -
replaces a good `{contactId: 'contact-...', phone}` entry with
`{contactId: '', phone}` on an established conversation.

**The group path is already guarded against exactly this. The 1:1 path is not.**
`apply.ts:1140-1142` adds the clause to `groupUnsafeClauses` with the reason
stated in place:

```
// `participants` would re-key the roster detection/conversion filled in
// (imported entries carry `contactId: ''`), breaking every member chip.
groupUnsafeClauses.add('participants = :participants');
```

That reduction is only applied in the `ConditionalCheckFailedException` recovery
arm at `apply.ts:1188-1200`, which fires when the row IS a native group thread.
An imported `unknown_1to1` row never reaches it and takes the full expression.
The hazard was identified, named, and fixed for one shape only.

**It does not self-heal.** `contactCapture` claims the link with
`setParticipantsIfAbsent`, conditioned on `attribute_not_exists(participants)`,
so an array that EXISTS carrying a blank `contactId` is unreachable to it. The
lookup at `contactCapture.ts:142` matches on phone and finds an entry whose
`contactId` is `''`; there is no arm that repairs a present-but-blank link.

**Why it matters beyond the import.** `participants[].contactId` is about to
become a load-bearing READ path: cluster C1's approved fix for
[`unread-badge-request-round-trip-cost`](./unread-badge-request-round-trip-cost.md)
resolves the contact for each unread row from this field instead of paying a
`findByPhone` Query per item. A blank entry there is not cosmetic:

- It degrades an unread row to a phantom `unknown` row - which is the inbox
  symptom C1 exists to remove.
- Depending on how the batch read is written, ONE empty key can fail or drop a
  whole 100-key chunk rather than a single row. An empty string is not a valid
  key.

Found by two independent adversarial reviewers of the C1 spec on 2026-08-25,
each reaching it from a different direction, and confirmed by reading the code.
The C1 spec's own invariant enumeration missed this surface entirely - it named
a contact-merge operation that does not exist in this repo and omitted the
importer, which is the one writer that actually rewrites the field.

**Suggested fix.** Two parts, and the first is not optional if C1 ships the
read-through.

1. **Stop blanking.** Do not assign a `contactId` the import does not know.
   Either omit the entry, or preserve the stored one. A conditional write or a
   read-merge is needed because DynamoDB cannot express "update this element of
   a list only if my value is non-empty" in a single unconditional `SET`. Do NOT
   simply add `participants` to a shared unsafe-clause set - the existing set is
   applied only in the group recovery arm, so reusing it would silently do
   nothing on the 1:1 path.
2. **Make an existing blank healable.** Give `contactCapture` an arm that
   repairs a present-but-blank link for THIS phone, rather than only claiming an
   absent `participants` array. Match on phone, never on `participants[0]` - the
   file already states that rule at `contactCapture.ts:164`.

**Not yet measured.** How many live rows carry `contactId: ''` today is unknown
in dev and prod. C1 needs that number anyway before its read-through can claim a
saving, so the two questions should be answered by the same measurement.
