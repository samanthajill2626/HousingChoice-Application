---
id: import-conversations-missing-phone-claim
title: Import-created one-to-one conversations have no phone claim record, so a later claim can point elsewhere
type: bug
severity: low
status: open
area: app/import
created: 2026-09-25
refs: app/src/lib/import/apply.ts:1160-1171, app/src/repos/conversationsRepo.ts:1252-1309
---

**Problem.** `createOrGetByParticipantPhone` guarantees one open one-to-one
conversation per phone with a conditional `phone#<E164>` claim item that maps
the phone to its conversation id; the byParticipantPhone GSI is only the fast
path. The Quo import writes one-to-one conversation rows directly and never
writes that claim. Later inbound traffic adopts the imported row through the GSI
fast path without writing one either, so a missing claim is the NORMAL state
for an imported row - harmless on its own.

The gap bites only inside GSI lag: a first message from an imported phone that
arrives while the index has not yet served the imported row takes the slow
path, wins the claim for a NEW conversation id, and creates a second open
one-to-one row. From then on the claim points at a different row than the
phone's older open one, and readers that take "the first open row" (the
tour-reminder one-to-one route, the broadcast fan-out) may disagree with
readers that follow the claim.

**Suggested fix.** Either the import writes the claim for every one-to-one row
it creates (conditionally, adopting an existing claim if one is present), or
the adoption fast path back-fills a missing claim. The share-skip-fix census
(Branch A, D1) reports how many imported rows have a claim that points at a
different conversation, which sizes the real damage before anything is built.
