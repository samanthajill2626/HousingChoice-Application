---
id: unit-media-dangling-reference-race
title: Concurrent photo delete + reorder/PATCH can leave a dangling unit.media reference (broken image)
type: bug
severity: low
status: open
area: app
created: 2026-07-21
refs: app/src/routes/units.ts:702, app/src/routes/units.ts:1127, app/src/repos/unitsRepo.ts:710, app/src/repos/unitsRepo.ts:728, app/src/repos/unitsRepo.ts:455
---

**Problem.** The unit-photo write helpers (removeMedia, makeCover) and the raw
PATCH /:unitId seam are each a NON-ATOMIC read-modify-write on unit.media
(getById -> compute next list -> update; unitsRepo.ts:710 / :728 / :455). The
update is a single last-writer-wins SET whose only condition is
attribute_exists(unitId) - nothing guards the media CONTENTS. Since D1
(delete-on-removal, 2026-07-21) a photo removal ALSO best-effort-deletes the S3
object for each removed own-namespace key (units.ts:702 for DELETE /photos,
units.ts:1127 for the PATCH diff). Pairing a non-atomic list write with a real
object delete introduces a new-in-kind, customer-visible failure: a DANGLING
reference - unit.media lists a key whose S3 object has already been deleted.

Proven interleaving (initial media = [K1, K2], both objects present in S3):

1. Staff A calls PUT /photos/cover { entry: K2 }. makeCover getById reads
   [K1, K2]; K2 is not already the cover, so it will write [K2, K1] (re-persisting
   K1).
2. Staff B calls DELETE /photos { entry: K1 }. removeMedia getById reads [K1, K2];
   computes next [K2].
3. B's update commits: DB = [K2].
4. B's route runs deleteRemovedUnitMedia(..., [K1]) -> S3 DeleteObject(K1). K1's
   bytes are gone.
5. A's update commits LAST: DB = [K2, K1].

Final state: unit.media = [K2, K1], but K1's object was deleted. K1 renders as a
broken <img> in the staff gallery and, if the unit is shareable, on the PUBLIC
flyer, until a staffer re-edits the unit. The same shape occurs when the losing
write is a raw PATCH that re-persists a key a concurrent removal just deleted.

**Why this is ACCEPTED (documented, not re-architected).**

- LOW probability: it needs two CONCURRENT conflicting writes to the SAME unit's
  media (two staffers at once, a fast double-click, or an automated client) PLUS
  the specific commit ordering. Normal sequential staff use never hits it.
- Self-healing: the damage is a broken image, not data loss. Re-uploading, or
  removing the dead entry, fully restores correct state.
- Pre-existing write pattern: the non-atomic read-modify-write class existed
  before D1. Before D1 this exact interleaving merely resurrected a
  stale-but-still-serving entry (the object was never deleted), so it was
  invisible; D1's delete is only what makes the same race customer-visible. D1 did
  not create the concurrency bug, only a visible consequence of it.
- The adversarial review proved NO must-fix defect on the branch; this is the
  single should-fix, adjudicated ACCEPT + document.

**Remedies (only if this ever matters in practice).**

- Optimistic concurrency on the unit write: gate removeMedia / makeCover / update
  on a version attribute (or a ConditionExpression asserting the media list is
  unchanged since getById), and retry on ConditionalCheckFailed. This serializes
  conflicting media writes so a delete can no longer race a re-persist.
- Delete-after-reconfirm: before DeleteObject, re-read the CURRENT stored list and
  skip the delete when the key is still referenced (shrinks, does not close, the
  window).
- Render-time reconcile: treat unit.media as advisory and HEAD/verify object
  existence when resolving display URLs (cost: an S3 round trip per photo per
  read - contrary to the same-origin design's no-store goal, so least preferred).

Until then the race is a known, accepted risk, documented at both call sites
(the units.ts DELETE /photos helper call and the PATCH seam comment block).
