---
id: tour-copy-where-token-declared-not-passed
title: The tour entries that lost their _no_address twin still DECLARE {where}, but the composer passes it only when a street exists - re-adding it to a default throws past every containment block
type: debt
severity: low
status: open
area: app/messages
created: 2026-08-31
refs: app/src/messages/catalog.ts:146, app/src/messages/catalog.ts:154, app/src/messages/catalog.ts:163, app/src/messages/catalog.ts:174, app/src/messages/tourCopy.ts:118, app/src/messages/resolve.ts:37
---

**Problem.** A LATENT hazard, not a live defect: nothing today triggers it, and
the trigger is a one-line edit that the catalog's own comment invites.

`tour.day_before`, `tour.morning_of`, `tour.en_route_self_guided` and
`tour.en_route_landlord_led` all declare `where` in `vars`. They no longer have
an `_no_address` twin - the 2026-08-26 copy rewrite replaced that mechanism with
the code-computed `{addressLine}` clause for `morning_of` and dropped `{where}`
from the day_before / en_route wording entirely. The DECLARATION stays on
purpose (spec section 6: every tour entry declares the full token set, so a
future wording change is a pure string edit), and this issue does NOT ask for it
to be removed.

The hazard is the asymmetry with the composer. `composeTourReminderBody`
(`app/src/messages/tourCopy.ts:118`) passes `where` only when the street is
non-empty:

```ts
...(street.length > 0 && { where: street }),
```

So the first "pure string edit" that puts `{where}` back into one of those four
DEFAULTS makes every addressless tour hit `interpolate`'s strict path and throw
a bare `Error('resolveMessage: missing interpolation var "where"')`
(`app/src/messages/resolve.ts:37`). That error is neither
`UncomposableReminderError` nor `ReminderNamesUnavailableError`, so nothing
contains it:

- `app/src/routes/tourReminders.ts`, `app/src/routes/contactTimeline.ts` and
  `app/src/routes/relayGroups.ts` all rethrow -> a 500 on the whole ladder read,
  not a per-row "Preview unavailable";
- the per-row catch in `app/src/jobs/tourReminders.ts` rethrows it -> the rung
  is never claimed and re-lists every tick, forever.

Mitigation that already exists, and is why this is LOW: the exhaustive compose
matrix in `app/test/tourCopy.test.ts` iterates the no-address branch, so the
edit goes red in CI rather than in production. It is filed because the failure
is loud in the wrong place (a 500 on an unrelated read path) and the invitation
to make the edit is sitting in the catalog comment.

Same CLASS of hazard as item 9 of
[`tour-reminder-ladder-phase-b`](./tour-reminder-ladder-phase-b.md): a
declaration that the code around it does not actually honor for every input.

**Suggested fix.** Either pass `where: street` UNCONDITIONALLY (empty string
when the unit has no address), so the worst case is a clause that reads oddly
rather than a throw; or give the four entries a compose-time guard that treats a
missing `where` on a tour default the way `addressLine` is already treated. Keep
the declarations either way. `tour.confirmation` / `tour.confirmation_no_address`
are NOT in scope - that pair kept its twin precisely because its `{where}` sits
mid-sentence, and it is passed the token on the with-address branch only, which
is the shape the twin exists to make safe.
