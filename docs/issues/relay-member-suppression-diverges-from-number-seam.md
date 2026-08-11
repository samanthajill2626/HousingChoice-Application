---
id: relay-member-suppression-diverges-from-number-seam
title: relayAnnouncements.isMemberSuppressed answers the opposite of the shared number-suppression seam for a secondary number
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-11
refs: app/src/services/relayAnnouncements.ts:61, app/src/services/numberSuppression.ts:108, app/src/jobs/relayFanOut.ts:433, app/src/routes/today.ts:549, app/src/routes/webhooks/twilio.ts:541
---

**Problem.** Two live implementations of the SAME per-number SMS suppression rule
disagree, and the disagreement is visible to staff on two screens at once.

`app/src/services/numberSuppression.ts` states in its header that it "is the one
place the rule lives" and lists its three binders. It is not the only one.
`relayAnnouncements.isMemberSuppressed` is a pre-existing fourth implementation
with four live call sites:

```
app/src/jobs/relayFanOut.ts:433
app/src/routes/today.ts:549
app/src/routes/webhooks/twilio.ts:541
app/src/services/relayAnnouncements.ts:214
```

They differ on the SECONDARY-number case, which is the whole point of the BE1
per-number scope:

```ts
// relayAnnouncements.ts - the CONTACT flag wins REGARDLESS of scope
if (contact?.sms_opt_out === true) return true;

// numberSuppression.ts - the contact flag speaks for the PRIMARY number only
if (scope === 'primary' && contact?.sms_opt_out === true) return { suppressed: true, ... };
```

**Failure scenario.** Contact C has primary `+A` (opted out, contact flag set)
and secondary `+B`, which sits on a group roster and carries no 1:1 flag of its
own. The native group text's `/group-members` panel reports `+B` as NOT
suppressed (correct per BE1: the opt-out was about a different number). `Today`
and the relay fan-out report the same number as suppressed. Two staff-facing
surfaces give opposite answers about the same handset, and whichever policy a
future group-send path happens to bind to decides whether that member is
reachable.

**Why it was not fixed in the group-texting mission.** The divergent behavior is
RELAY's, it pre-dates this feature, and group-texting invariant 6 is absolute:
"relay behavior is unchanged." Migrating the four call sites onto
`readNumberSuppression` would change who receives relay announcements, intros and
tour reminder rungs - a real product change that needs its own decision, not a
side effect of a group-texting sweep. The group-texting fix wave therefore did
the ONE in-bounds thing: it excluded `group_text` rows from
`isMemberSuppressed`'s conversation read (invariant 13.6), with a comment that
points here and says explicitly that relay's answer was NOT corrected.

**Suggested fix.** Pick one policy deliberately and say which:

- (a) Migrate the four `isMemberSuppressed` call sites onto
  `readNumberSuppression`. Its signature already takes a pre-resolved contact, so
  none of them gains I/O. This makes relay honor the per-number scope - and it
  WILL start sending to secondary numbers of opted-out contacts, which is the
  decision that needs making.
- (b) Keep relay's contact-wide rule deliberately (a relay group is a
  human-curated roster, so "this person opted out" arguably outranks
  per-number scope there) and document the asymmetry in
  `numberSuppression.ts`'s header so it stops claiming to be the only reader.

Either way, delete the claim that one of them is "the one place the rule lives"
until it is true.
