---
id: group-text-inbox-spec-depends-on-leftover-conversations
title: group-text-inbox.spec.ts asserts an open-partition cursor that exists only when earlier specs left extra 1:1 conversations behind
type: debt
severity: low
status: open
area: e2e
created: 2026-09-25
updated: 2026-09-26
refs: e2e/tests/dashboard-next/group-text-inbox.spec.ts:33, e2e/tests/dashboard-next/group-text-inbox.spec.ts:96, app/src/lib/seed/lean.ts:228, app/src/lib/seed/lean.ts:275, app/src/routes/inbox.ts
---

**Update (2026-09-26).** `main` now seeds a second open 1:1 in the lean
world (Dario, `app/src/lib/seed/lean.ts:275-288`, the share-skip-fix
fixture), so `filter=all&limit=1` pages again and the guard at `:96` passes
right after a reseed (verified on a hermetic lane after the merge). The
dependence has MOVED rather than gone: the guard now rests on Dario staying
in the `open` partition, not on data the test controls. The suggested fix
below still applies; the severity stays low.

**Problem.** The test at `group-text-inbox.spec.ts:33` ("the Groups filter is
a real deep link, pages on its own cursor, and refuses a foreign one") needs a
cursor from `GET /api/inbox?filter=all&limit=1` for its foreign-cursor guard,
and asserts that one exists (`:96`, "the open partition must page, or this
guard proves nothing"). It neither reseeds nor mints a 1:1 of its own, and the
lean world's `open` byLastActivity partition holds exactly ONE conversation,
Tasha's 1:1 (`app/src/lib/seed/lean.ts:228`; the group text lives in
`group_open` and the relay group in `connecting`). So `filter=all&limit=1`
fills on the chunk's last item with no LastEvaluatedKey, and `nextCursor` is
null.

The guard passes only on residue: in full-suite order other specs run between
the last reseed and this file and leave extra open 1:1s behind. Run directly
after a reseed - alone, or in a reordered batch - it fails deterministically
at `:96`. Found by slice G of `feat/inbox-rows-timestamps` (2026-09-25), which
saw it fail in a sibling batch and again alone; pre-existing, not caused by
that branch. A suite reorder, or a new spec that reseeds just before it, turns
the full e2e gate red.

**Suggested fix.** Mint a second open 1:1 in the test before reading the
cursor (a fake-Twilio party's inbound, the way the test already seeds its own
second group), so the guard runs against a partition the test controls.
