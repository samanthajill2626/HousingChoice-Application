---
id: group-roster-name-snapshot-never-refreshed
title: Renaming a contact never updates group titles or member chips - the roster stores a name snapshot nothing refreshes
type: bug
severity: high
status: open
area: app/relay
created: 2026-08-25
refs: app/src/repos/conversationsRepo.ts:104-109, app/src/lib/groupTitle.ts:29-52, app/src/lib/rosterResolution.ts:216-229
---

**Problem.** `ConversationParticipant` carries a denormalized name:

```
export interface ConversationParticipant {
  contactId: string;
  phone: string;
  /** Sender-prefix display name (relay groups); resolved from the contact, may be absent. */
  name?: string;
}
```

`groupThreadLabel` builds a group thread's TITLE from that stored value - first
names only, `With Ada & Bo +2 more` - falling back to a formatted phone when the
name is absent. `rosterResolution` returns the stored `name` VERBATIM with no
read-time refresh.

Nothing updates it when the contact is renamed. The contact-update fan-out in
`routes/contacts.ts` propagates the resolved identity and
`participant_display_name` to LINKED 1:1 threads; it does not touch group
rosters, and no other writer of `participants[].name` exists. So the roster
holds a snapshot taken when the group was built, and a rename leaves group
titles and member chips showing the OLD name - or a phone number, if the
contact had no name at the time.

**Reported from use, not from code reading:** the founder observed that renaming
a contact "doesn't show in group conversations", meaning the group conversation
title. That is this.

**Why it went unmeasured until now.** The 2026-08-25 denormalization drift audit
(`app/scripts/measure-unread-contact-coverage.ts --audit-denorm`) skips group
rows outright - it walks 1:1 threads only - so it reported the 1:1 name field as
"latent, nothing renders it" and never looked at the roster field, which IS
rendered. The two are different fields with opposite exposure:

| field | rendered today? |
| --- | --- |
| `participant_display_name` (1:1) | NO - the inbox row uses the hydrated contact |
| `participants[].name` (group roster) | **YES - group titles and member chips** |

**IT REACHES OUTBOUND MESSAGE CONTENT. This is not chrome.** Verified in
`jobs/relayFanOut.ts`:

- `:405` - `const senderName = payload.senderNameOverride ?? senderMember?.name;`
  The sender prefix on a relayed member message falls back to the STORED roster
  name whenever no explicit override is passed. How often the override is set is
  NOT established here and must be checked before sizing the blast radius.
- `:634` - `const body = edited.length > 0 ? edited : composeIntroBody(roster.map((m) => m.name));`
  The group INTRO body is composed from stored roster names with no override in
  the path at all. Only an operator-edited body displaces it.

So a contact renamed after a group was built can be introduced to that group
under their OLD name, in a message actually delivered to tenants and landlords -
and the sender prefix on their messages can carry it too. The founder ruling
recorded in `lib/groupTitle.ts` is that outbound content carries names and never
a phone; that ruling assumes the name is RIGHT.

Severity is `high` for that reason, not for the group-title symptom that
surfaced it.

**Remaining scope check.** Enumerate the staff-facing readers too - group thread
titles, the contact card's relay-groups and group-texts rows, member chips - so
a fix covers them rather than only the outbound path.

**Suggested fix.** Two shapes, and the choice needs the scope check above:

1. **Refresh at READ time** for staff-facing surfaces - resolve names from the
   contacts the roster already points at by `contactId` rather than trusting the
   stored copy. Correct by construction and no backfill, but it adds a read to
   paths that were denormalized precisely to avoid one; measure before adopting.
2. **Fan out on rename** - extend the contact-update propagation to group
   rosters. Keeps reads cheap, but it adds a write surface to a denormalization
   that already has a proven drift record, and it needs a backfill for existing
   rosters.

Do not assume (1) is too slow or (2) is cheap: the same cluster's badge issue
carried a `high` severity for four rounds on an amplification nobody was paying,
and its neighbour turned out to cost 693 reads per render. **Measure both.**

**Not the same issue as** the 1:1 `participant_display_name` drift, which is
real but costless today and is deliberately out of scope in
[`inbox-filter-tabs-full-walk`](./inbox-filter-tabs-full-walk.md)'s design.
