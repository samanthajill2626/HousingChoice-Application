---
id: ranking-unlawful-flag-stale-overwrite
title: A ranking job holding pre-edit text can replace an OPEN unlawful flag, closing it and capping the field again
type: bug
severity: low
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/repos/rankingRunsRepo.ts:907, app/src/services/ranking/runBatch.ts:332, app/src/services/ranking/flags.ts:38, app/src/services/ranking/cap.ts:94
---

**Problem.** An unlawful fair-housing flag is one record per property and
field, `uflag#<unitId>#<field>` (WP1 B2a spec D10). It is "open" while the
property's CURRENT text for that field hashes to the record's `textHash`
(flags.ts:38-44), and while open the field caps no pair of that property
(cap.ts:94). The write (`putFlagIfAbsentOrClosed`) is conditioned
`attribute_not_exists(#itemId) OR #textHash <> :textHash`
(rankingRunsRepo.ts:907), with the hash of the text the WRITING job read at
assemble time (runBatch.ts:332). The repository's own doc says "write the
flag unless one is OPEN", but the condition cannot see the current text: it
only compares the stored hash with the writer's.

Interleaving (found by the plan-blind code review round 1, reviewer A1,
finding A1-5; the condition reproduced on the fake, which mirrors it; the
interleaving reasoned, not run):

1. Job J1 (anchor A) assembles and reads property P's `qualifications` = T1.
2. Staff edit it to T2, keeping the unlawful clause.
3. Job J2 (another anchor) assembles with T2, scores, and writes the flag
   with hash(T2) - open against the current text.
4. J1's slower batch writes its flag with hash(T1): the condition passes
   (the hashes differ), the record is replaced, and it now reads CLOSED
   against the current T2.

Until a later press re-raises it, the flag vanishes from the ranking read and
the run detail, and a failed `qualifications` requirement caps every tenant
of P at Weak again ("requirement not met") - an unlawful clause back in
effect for the cap. The window is narrow (two jobs over the same property,
an edit between their assembles, the older job's batch writing last). B4
owns the flag display; a model's false positive is a separate, accepted
design point (spec D10).

**Suggested fix.** Either (a) before the write, read the unit's CURRENT text
for the field and skip the write when its hash differs from the writer's
(narrows the window to the read-write gap; no key change); or (b) key the
record by the hash too (`uflag#<unitId>#<field>#<textHash>` in the same
partition), so writers of different texts never overwrite each other and
"open" becomes "a record whose hash equals the current text's hash" - a
record-key change to spec D10, so a ruling. Test: write hash(T2), then
hash(T1); `openFlagFields(records, { qualifications: T2 })` still returns
the field.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
R1-adversarial-A1.md (A1-5) and R1-adjudications.md.
