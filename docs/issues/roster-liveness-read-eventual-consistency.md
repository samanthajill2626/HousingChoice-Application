---
id: roster-liveness-read-eventual-consistency
title: The contact liveness reads that decide primary-contact writes are eventually consistent - a stale image can flag a deleted contact, a stale miss can demote a live one
type: improvement
severity: low
status: open
area: app
created: 2026-10-13
updated: 2026-10-13
refs: app/src/routes/units.ts:1747, app/src/routes/units.ts:1858, app/src/repos/unitsRepo.ts:1418, app/src/services/primaryHandoff.ts:110, app/src/repos/unitsRepo.ts:1789, app/scripts/assign-primary-contacts.ts:315, app/src/routes/units.ts:653, app/src/repos/unitsRepo.ts:876, app/src/repos/contactsRepo.ts:1018, app/src/lib/propertyContact.ts:92, app/src/routes/units.ts:708, app/src/routes/units.ts:2434, app/src/repos/unitsRepo.ts:900, app/src/lib/propertyContact.ts:164
---

**Problem.** Since `feat/primary-contact-integrity`, every AUTOMATIC
primary-contact decision reads the liveness (and type) of the roster
contacts through `readRosterContacts` (`app/src/lib/propertyContact.ts:86-104`),
that is `contactsRepo.getManyByIds(ids, { requireComplete: true })`
(`app/src/repos/contactsRepo.ts:1288-1290`), whose BatchGet carries no
`ConsistentRead` (`contactsRepo.ts:978-980`). The callers that decide a WRITE
from it: auto-primary on an add or edit (`app/src/routes/units.ts:1408` ->
`decideAutoPrimary`), the remove hand-off (`app/src/repos/unitsRepo.ts:1375`),
the restore swap (`unitsRepo.ts:1664`), the "Restore without a landlord" heir
pick (`app/src/routes/units.ts:597`), the contact-delete hand-off
(`app/src/services/primaryHandoff.ts:100-105` -> `unitsRepo.ts:1745`) and the
one-time backfill (`app/scripts/assign-primary-contacts.ts:314`). The restore
heir pick replaced caseworker-integrity's per-row consistent `getById`; plan
ruling R13 accepted that relaxation deliberately
(`docs/superpowers/reviews/2026-10-12-primary-contact-integrity/plan-research/plan-assembly-rulings.md:27`;
the replaced pin is `app/test/unitsRestoreLandlord.test.ts` "(PIN) reads the
remaining contacts in ONE complete batch read").

**Accepted race, by design for now.** Spec 4.2
(`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md`)
states it: a contact deleted between the liveness read and the roster write
can still be made primary; the deleting request's own fan-out catches it
only if its Scan reads the unit after that write, otherwise the lookup skips
it, the property box shows it and the backfill repairs it. Code review round
1 (adversarial findings F2, F3 and F4, all LOW) confirmed three shapes and
adjudicated them accepted; they are filed together here.

**The three shapes.**

1. **A stale image can flag a just-deleted contact (F2).** The read can
   still return a contact soft-deleted a moment ago as live, and the heir
   function or auto-primary then picks it. Example: Staff A deletes C while
   Staff B runs "Restore without a landlord"; the heir pick reads C's
   pre-delete image and C becomes the primary - spec 4.2's accepted-race
   class (spec 4.4's refusal is the 409 on an explicit write, which an
   automatic pick never meets) - and C's own delete hand-off may already
   have scanned past that unit. The same end state needs no stale replica
   at all (F4): two near-simultaneous
   deletes - P's hand-off reads Q live, Q is deleted and Q's own hand-off
   Scan still sees P flagged (so the unit is not Q's target), then P's
   hand-off writes Q flagged, because its write is fenced on `landlordId` and
   `contacts[]` only, never on the heir's liveness. A remove of the primary
   racing a delete of the heir it picks ends the same way. And a unit whose
   delete hand-off answered `unknown` (a throttled liveness read,
   `primaryHandoff.ts:138-141`) or threw after its 3 lost writes is logged
   and skipped; nothing retries it - the only later sweep is the one-time
   backfill.
2. **A stale miss can read a live row as deleted (F2).** On a complete read
   an absent key is a contact that does not exist, which spec section 3
   treats as deleted. An eventually consistent miss of a contact created
   moments ago therefore reads as deleted: auto-primary on an add can demote
   a LIVE flagged primary in favor of the added contact, and the same
   response - its row flags come from another read of the same kind
   (`enrichRosterView`, `app/src/routes/units.ts:546`) - can mark the live
   row `deleted: true`, so the property page shows "(deleted)" and may lead
   "This property's contact was deleted.".
3. **A soft-deleted flagged row is not displaced by a landlord-clearing
   restore (F3).** A deleted contact can stay flagged - left by a delete
   with no heir at the time, or by shape 1. `landlordWasPrimary`
   (`app/src/repos/unitsRepo.ts:865-868`) reads the flag, never liveness
   (its two call-site comments say so since code review round 1), so
   "Restore without a landlord" next to a deleted flagged row runs no
   hand-off, and the lookup then answers nobody while an eligible contact
   sits on the list. Spec 4.7 accepts it: such a row "stays flagged until
   the next eligible write (4.4) or the script (section 8)", and the
   property box shows it meanwhile. If it is ever wanted, the fix is to
   decide "flagged elsewhere" from LIVE rows (the restore paths already read
   liveness when they hand off; reading one step earlier costs one batch
   read on this rare path).

**Suggested fix.**

- A `consistentRead` option on `getManyByIds` (and the `batchGetByIds`
  helper under it - BatchGetItem accepts `ConsistentRead: true` per table in
  `RequestItems`), passed through `readRosterContacts` by the write-deciding
  callers listed above. The display reads (`enrichRosterView`: the property
  GET's block and the write responses' row flags) can stay eventually
  consistent - a miss there mislabels a row until the next read but decides
  no write. Cost: about twice the read units on a handful of keys per roster
  write. This closes the stale image of shape 1 and the demotion of shape 2
  at the read; F4's interleaving (a correct read, then a write after the
  heir was deleted) would additionally need the heir re-checked with a
  consistent single-key read right before the write, or stays accepted.
- A bounded retry for `unknown` units in the delete fan-out
  (`primaryHandoff.ts:138-141`): re-run `handOffPrimaryFrom` once or twice
  after a short backoff before logging and skipping, so a throttled read
  does not leave a deleted contact flagged until the next backfill.

**Update (2026-10-13, `feat/primary-contact-integrity` planner fix wave 3
F5a, commit `fc7607de`): the restore paths read consistently again; the
issue stays OPEN, narrowed to the other callers.** Cameron ruled "restore
paths only". `contactsRepo.getManyByIds(ids, { requireComplete?,
consistentRead? })` now puts `ConsistentRead: true` in the contacts table's
`RequestItems` entry of every request its walk sends when asked
(`app/src/repos/contactsRepo.ts:1018`; the default is unchanged), and
`readRosterContacts(contacts, ids, logger?, opts?)`
(`app/src/lib/propertyContact.ts:92`) passes it through only when asked. The
restore route asks for it in BOTH of its reads: "Restore without a
landlord"'s heir pick (`clearedLandlordHeir`,
`app/src/routes/units.ts:708`) and the `readContacts` it hands
`restoreWithLandlord` for the landlord swap's hand-off
(`app/src/routes/units.ts:2434`). The regression against `main` is
therefore CLOSED: caseworker-integrity's per-row consistent `getById`,
which plan ruling R13 had relaxed into an eventually consistent batch read,
is consistent again as a batch read - the replaced pin
(`app/test/unitsRestoreLandlord.test.ts` "(PIN) reads the remaining
contacts in ONE complete, strongly consistent batch read") and the swap case
now assert `consistentRead: true`. On the restore paths that closes shape
1's stale image (the issue's own example) and shape 2's stale miss at the
read; a delete landing AFTER the read (F4's interleaving, spec 4.2's
accepted race) is unchanged, and so is shape 3. Still eventually
consistent, by the same ruling - what this issue now tracks: auto-primary
on an add or edit (`app/src/routes/units.ts:1747`), the remove hand-off
(`app/src/routes/units.ts:1858` -> `app/src/repos/unitsRepo.ts:1418`), the
contact-delete fan-out (`app/src/services/primaryHandoff.ts:110` ->
`app/src/repos/unitsRepo.ts:1789`) and the one-time backfill
(`app/scripts/assign-primary-contacts.ts:315`); the display read
(`enrichRosterView`, `app/src/routes/units.ts:653`) stays eventually
consistent as the suggested fix above allowed. Making any of those
consistent is now one option on its `readRosterContacts` call.

**Update (2026-10-13, planner review round 2, adversarial R2-1): shape 3
now covers the contact-delete hand-off too.** Planner fix wave F2 gave the
delete fan-out the restore paths' flag rule (`contactIsPrimaryToHandOff`,
`app/src/repos/unitsRepo.ts:900-911`, through `landlordWasPrimary`), so it
reads FLAGS, not liveness, the same way: on a unit where a soft-deleted
contact D is still flagged and the landlord of record L is not, the lookup
already uses L (`app/src/lib/propertyContact.ts:164-171`), yet deleting L
hands off nothing (D's flag is "a flagged row elsewhere", which always wins)
and the property is left with no contact even when an eligible contact sits
on the list. Accepted with shape 3 (spec 4.7: a deleted flagged row stays
flagged until the next eligible write or the script). The main source is
primaries deleted before this branch deployed (the old delete never handed
off), so the window closes when the one-time backfill is applied (RUNBOOK
"Primary contacts backfill"): apply it promptly after each deploy. The fix,
if ever wanted, is shape 3's: decide "flagged elsewhere" from LIVE rows -
target every unit whose landlord of record is the deleted contact and let
`handOffPrimaryFrom`, which already reads liveness, back off only when a
LIVE flagged row exists.
