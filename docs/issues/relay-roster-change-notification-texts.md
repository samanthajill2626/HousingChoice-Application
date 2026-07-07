---
id: relay-roster-change-notification-texts
title: "Relay groups: send notification texts on member add/remove (GO-LIVE gate)"
type: improvement
severity: high
status: open
area: app
created: 2026-07-07
refs: app/src/routes/relayGroups.ts:204, app/src/routes/relayGroups.ts:304, app/src/jobs/relayFanOut.ts:466, app/src/messages/catalog.ts
---

**Problem.** When a member is added to or removed from a relay group, **no SMS goes
to anyone**. The only signals today are dashboard-facing activity milestones
(`added_to_group_text` / `removed_from_group_text` — relayGroups.ts:232/:304); the
intro text (`relay.intro` job) fires **only at group creation**. Consequences:

- A newly **added** member gets no intro — they start receiving relayed messages
  from an unexplained pool number with no identity/context (bad UX, and weak
  against the spirit of the A2P identity copy the creation-time intro carries).
- Existing members are never told someone new **can now read their messages** —
  a real transparency/privacy gap for a masked group.
- A **removed** member's departure is invisible to the remaining members, whose
  mental roster silently drifts from reality.

**Cameron directive (2026-07-07): required product work before go-live.**

**Suggested fix.** Reuse the existing throttled `relay.intro` machinery
(relayFanOut.ts:466) rather than inventing a new send path:

- **On add:** send the new member the standard intro (identity + "you're now
  connected with …"), and send the existing members a short "«Name» was added to
  this group text." notice from the pool number.
- **On remove:** send remaining members "«Name» was removed from this group
  text." (Whether the removed member gets a goodbye text is a product call —
  default no, to avoid texting someone who may have been removed for opt-out
  reasons; the fan-out already skips opted-out members.)
- **Copy lives in the message catalog** (`app/src/messages/catalog.ts`,
  `class: 'operational'`, tokens `{name}`) per the message-catalog convention —
  not hard-coded in the job/route.
- Keep sends best-effort (roster mutation must not fail if the notify send
  fails), idempotent under job retry, and consistent with the relay consent
  exemption + identity-prefix conventions in `lib/smsCompliance.ts`.

**Side benefit:** the fake-phones relay-group inference (see
2026-07-07-fake-phones-relay-groups-design spec) picks roster changes up from
traffic — these notification texts would make add/remove reflect in the mock
window immediately instead of on the next relayed message.
