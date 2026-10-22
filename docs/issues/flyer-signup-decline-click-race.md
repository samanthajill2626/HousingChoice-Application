---
id: flyer-signup-decline-click-race
title: A flyer sign-up landing while staff click Not interested leaves the new decline superseded at birth
type: bug
severity: low
status: open
area: app
created: 2026-10-21
refs: app/src/routes/units.ts:1572, app/src/routes/units.ts:1596, app/src/routes/units.ts:1688-1702, app/src/routes/units.ts:1742-1762, app/src/repos/listingSendsRepo.ts:379-411, app/src/lib/listingSendOutcome.ts:49-61, app/src/services/shareLedger.ts:276-296, app/src/routes/public.ts:637-703, app/src/lib/events.ts:5-6, app/src/lib/dynamo.ts:61-79
---

**Problem.** The send-outcome route
(`POST /api/units/:unitId/recipients/:contactId/outcome`,
`app/src/routes/units.ts:1560`) records a staff "Not interested" in four steps:
1. it reads the pair's row (`units.ts:1572`);
2. it stamps the decline instant, `const at = new Date().toISOString()`
   (`units.ts:1596`);
3. it writes the decline with `listingSends.setDeclined` (`units.ts:1690`),
   which is conditioned only on a counted row - not on the change token
   (`shares_op`) the route read (`app/src/repos/listingSendsRepo.ts:379-411`);
4. it re-reads the row and answers the re-projected outcome
   (`units.ts:1742-1762`).

A decline counts only while its instant is at or after the pair's `sentAt`
(`effectiveDecline`, `app/src/lib/listingSendOutcome.ts:49-61`). Suppose a flyer
sign-up for the same pair (spec
`docs/superpowers/specs/2026-10-21-flyer-leads-design.md` D7) takes its instant
after `at`, and its ledger write (`applyFlyerShareEntry`,
`app/src/services/shareLedger.ts:276-296`) lands before the route's step 3
write does. The sign-up read no decline, so nothing refused it, and its flyer
entry moves `sentAt` past `at`. The route's decline then lands already
superseded - dead at birth - and the re-projection answers `signed_up`. The
click visibly fails once (the row does not move to Not interested); a second
click sticks, because its `at` is after the sign-up. The route still records
its "Not interested in `<address>`" timeline event and the property Activity
row (`units.ts:1695-1702`), so the contact's timeline says Not interested while
the pair reads Signed up. Both requests read ONE clock: the app is one process
on one box (`app/src/lib/events.ts:5-6`), so no skew between instances is
involved.

The REVERSE order is closed: a decline that lands between the flyer write's
read and its write is seen, because both decline writers stamp a fresh
`shares_op` token (spec D7, O1), so the flyer write loses its condition,
re-reads and refuses.

Spec D7 says a public request can never undo a staff decision; in this one
order it can, until the second click. Recorded as residual (i) of the build
worklist's OR-13 ruling; the code review round 1 adjudication
(`docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/adjudications.md`,
row A5 / C2) filed it rather than change a merged route's race semantics in a
fix wave, and code review round 2 (`R2-review.md` F3 and the A5 / C2
challenge, same directory) corrected what makes it reachable:

**What it takes.** The window runs from the route's `at` (`units.ts:1596`) to
its `setDeclined` landing (`units.ts:1690`). On the Not interested path nothing
is awaited between the two, so the route has ONE write in flight. During that
write the sign-up must take its instant (`app/src/routes/public.ts:637`) and
then still run, before its flyer entry lands, the repeat read `hasEventSince`
(`public.ts:643`) and the ledger's `getByKeyConsistent` and conditional
`putShareMemory` (`applyFlyerShareEntry`, `public.ts:696`): about two and a
half DynamoDB round trips, five and a half when it also pins and marks the
thread (`public.ts:661-672`). So ordinary latency does not reach it. It takes a
slow `setDeclined` (DynamoDB tail latency) or one the SDK retries (the client
sets no retry policy of its own, so the SDK default applies,
`app/src/lib/dynamo.ts:61-79`). Proof B below reaches it only by running the
whole sign-up inside the `setDeclined` spy. Rare, and staff see the result:
the click answers `signed_up`, and a second click sticks.

**Reproduction** (proof B, code review R1 adversarial; harness world fakes, as
in `app/test/publicSignupLeads.test.ts`):
1. Seed an existing tenant, a shareable unit, and a counted earlier send of
   that unit to the tenant (`seedListingSend`).
2. Spy `world.listingSendsRepo.setDeclined` so that, when the outcome route
   calls it, it first runs a flyer sign-up for that tenant and unit - with the
   public router's injected clock about 5 ms after the decline record's `at` -
   and awaits it, then calls the real `setDeclined`.
3. `POST /api/units/<unitId>/recipients/<contactId>/outcome` with
   `{ outcome: 'not_interested' }` and a staff session.
4. Observed: 200 with `row.outcome === 'signed_up'`; the stored row holds BOTH
   the staff decline (at the route's `at`) and the `flyer` share entry
   (counted about 5 ms later, which is the row's `sentAt`).

**Suggested fix.** Condition `setDeclined` on the `shares_op` token the route
read at step 1. On a lost condition, re-read and re-stamp `at` - as the later
of now and the re-read row's `sentAt`, which would also hold if the app ever
ran as more than one instance (today it is one process, above) - then write
again, bounded like the share ledger's re-read loop. Note that this also
changes the route's race against a concurrent BROADCAST share: today a
broadcast entry whose instant is after `at`, landing
in the same window, supersedes the new decline the same way (a later counted
share wins, by design), while a token-conditioned decline would re-stamp after
it and win. Every ledger write moves the token, a delivery receipt included,
so the condition would also retry on writes that do not move `sentAt`. Its own
change to a merged route, with proof B as its pin test.
