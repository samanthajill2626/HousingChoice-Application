---
id: inbound-reflags-closed-relay-group
title: An inbound to a CLOSED relay group re-flags it as unread, reopening it or making it an invisible index resident
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-16
refs: app/src/routes/webhooks/twilio.ts, app/src/repos/conversationsRepo.ts, dashboard/src/routes/tours/useTourChannels.ts, dashboard/src/routes/placements/usePlacementChannels.ts
---

**Problem.** Filed from the plan-blind adversarial review of
`feat/inbox-unread-index` (finding 3, CONFIRMED by source trace).

The relay inbound handler's `isClosed` guard suppresses only the FAN-OUT. It then
falls through to:

```js
if (!appended.deduped) await conversations.incrementUnread(relay.conversationId);
touched = await conversations.touchLastActivity(relay.conversationId, ...);
```

`incrementUnread` now stamps `unread_flag` unconditionally (that is the sparse
byUnread index invariant), so an inbound puts a CLOSED relay group back into the
index. Two outcomes:

- `touchLastActivity` succeeds: it writes `status = 'open'` (its partition guard
  only excludes `group_text`), so a group staff explicitly closed silently
  REOPENS and now appears in the nav badge. The close's `unread_count = 0` is
  undone by the next stray inbound.
- `touchLastActivity` throws (the surrounding catch logs
  "relay touchLastActivity/unread failed - message persisted, inbox stale" and
  swallows it): the row is left `status: 'closed'` + `unread_flag: 'unread'` +
  `unread_count: 1` - an INVISIBLE PERMANENT RESIDENT of the index that no
  runtime path clears. `setRelayStatus(_, 'closed', 'open')` fails its
  precondition, the badge never shows it, and the backfill is one-shot. This is
  an accrual path toward
  [`unread-budget-truncation-has-no-forward-path`](./unread-budget-truncation-has-no-forward-path.md).

It also breaks a premise other code was written against. The close-reset ruling
(spec 4.2) is what made the tour/placement channel rails safe to wire into the
optimistic badge decrement, and their comments used to assert it as a universal
invariant ("an unread relay group is necessarily open/connecting"). In the second
outcome the optimistic decrement subtracts a row the badge never counted, so the
badge under-counts until the next reconcile. The fix wave for this branch
corrected both comments to stop asserting the invariant and to point here; the
behavior itself is untouched.

**Suggested fix.** Options, in the reviewer's order: skip `incrementUnread` when
`isClosed` (a closed group has no reader to mark it read); or make
`touchLastActivity` not resurrect a closed relay group; or add a compensating
reset. Whichever is chosen, the product question - should an inbound to a closed
relay group reopen it at all? - should be answered explicitly rather than
inherited from a fall-through.

**Test that should exist and does not.** A webhook test driving an inbound to a
closed relay group and asserting the row's post-state (flag + status), for both
the `touchLastActivity` success and throw paths.
