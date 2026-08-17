---
id: push-subscription-prune-rmw-lost-update
title: push_subscriptions add/prune are unconditioned read-modify-writes, so concurrent prunes can lose an update
type: bug
severity: low
status: open
area: app/push
created: 2026-08-16
refs: app/src/repos/usersRepo.ts:581, app/src/repos/usersRepo.ts:612, app/src/services/pushService.ts
---

**Problem.** `addPushSubscription` and `removePushSubscription`
(`app/src/repos/usersRepo.ts:581-631`) both rewrite the WHOLE
`push_subscriptions` list: read the user item, filter/append in memory, then
`SET push_subscriptions = :subs` guarded only by
`ConditionExpression: 'attribute_exists(userId)'`. There is no version
attribute and no per-endpoint condition, so the write is a classic
read-modify-write with a lost-update window.

That was defensible while the only prune came from an operator toggling
notifications in Settings (the comment at `:582-586` reasons about it as "a
person adds devices serially"). Inbound-message push changed the contention
profile: a 410/404 Gone prune now runs on the MESSAGE path, fire-and-forget,
from TWO processes - the app's inbound webhooks and the mail worker - so
overlapping writes on one user item are genuinely possible. Two shapes:

- A prune whose read predates a fresh subscribe writes back the stale list and
  CLOBBERS the just-added subscription. The device then gets nothing until it
  re-subscribes.
- Two concurrent prunes of DIFFERENT dead endpoints RESURRECT one of them:
  each stale read still contains the other's endpoint, and whichever write
  lands second puts it back. The resurrected endpoint is dead, so it just
  produces another Gone on the next send.

Accepted at the current team scale (design spec section 5): the blast radius
is one user's device list, both shapes are self-correcting, and neither can
lose a message - only a notification. Recovery is automatic on the next Gone
prune, or immediate by re-toggling notifications off/on in Settings, which
rewrites the list from the live browser subscription.

**Suggested fix.** Either an optimistic-version loop (a `push_subs_version`
attribute, `ConditionExpression` on it, retry the read-modify-write on a
conditional-check failure), or endpoint-keyed storage - each subscription as
its own item (or its own map entry keyed by an endpoint hash) so an add and a
prune of different endpoints never touch the same attribute and no read is
needed to write.
