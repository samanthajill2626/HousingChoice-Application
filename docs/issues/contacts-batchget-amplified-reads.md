---
id: contacts-batchget-amplified-reads
title: Per-contact Gets amplify reads on broadcast results, property recipients, and property activity
type: debt
severity: med
status: open
area: app
created: 2026-08-16
updated: 2026-08-21
refs: app/src/repos/contactsRepo.ts:833, app/src/routes/broadcasts.ts:227, app/src/routes/broadcasts.ts:649, app/src/routes/units.ts:343, app/src/routes/units.ts:959, app/src/routes/units.ts:1134, app/src/routes/units.ts:1230
---

**SCOPE CORRECTED 2026-08-21.** This issue previously also owned the unread
feed collector and was raised to `high` because of it, on the stated remedy of
"a `findByPhones`-shaped BatchGet". That remedy does not exist: **BatchGetItem
cannot read a global secondary index** (`KeysAndAttributes` has no `IndexName`;
batch reads address base-table primary keys only), and the collector resolves
contacts from `participant_phone` / `participant_email` through the `byPhone` /
`byEmail` GSIs, with no `contactId` on the conversation item to batch by. That
surface needs a design decision, not a mechanical sweep, and moved to
[`unread-badge-request-round-trip-cost`](unread-badge-request-round-trip-cost.md).
What remains here is the genuinely mechanical part, and the severity returns to
`med` with it.

**Problem.** Several routes resolve contacts one GetItem at a time inside
per-row loops, so response cost scales linearly with row count even though
DynamoDB BatchGetItem could fetch up to 100 per round trip. Every surface below
is keyed by `contactId` (the contacts base-table hash key), deduped per id, and
degrades best-effort on a failed lookup. Identified during the 2026-08-14 inbox
performance investigation (repository call profiling against the imported real
dataset), line numbers re-verified 2026-08-21:

- Broadcast results, `enrichRecipients` (broadcasts.ts:227): chunked
  `Promise.all` over `getById`, up to ~1,500 reads (MAX_BROADCAST_RECIPIENTS)
  per GET. Concurrent, so this is a round-trip and throttle-pressure cost more
  than a latency one. See also
  [`broadcast-results-enrichment-read-cost`](broadcast-results-enrichment-read-cost.md),
  which covers the SAME function from the caching angle (the results page polls
  it every ~2s during a send) - the two remedies compose.
- Broadcast selection send (broadcasts.ts:649): chunked `Promise.all` at
  concurrency 50 over the selection ids, same ~1,500 cap.
- Property (unit) roster enrichment (units.ts:343): sequential `await` per
  unique roster contact.
- Property (unit) recipients name hydration (units.ts:959): sequential `await`
  per unique recipient, no useful route-level cap.
- Property (unit) placements tenant names (units.ts:1134): sequential `await`
  per unique tenant.
- Property (unit) activity (units.ts:1230): sequential `await` per unique
  contact, up to ~100 per page.

`resolveSeeds` (broadcasts.ts:340) is sequential too but its own comment notes
seeds number 1..handful; it is listed for completeness, not as a target.

**Three more fan-outs found while fixing the six above (2026-08-21), NOT yet
done** - same shape, different files, left out to keep the sweep reviewable.
These line numbers are stable (the six-site sweep does not touch these files);
the front-matter `refs:` still points at the six and goes stale when that lands:

- `app/src/routes/today.ts:357` `getContact` - a memoized `getById` per unique
  contact in the Today payload; drives both name hydration and the soft-delete
  check, so it needs WHOLE items (`getManyByIds`). Two-pass: collect the ids,
  batch, then walk.
- `app/src/lib/rosterResolution.ts:633` `nameOf` - one `getById` per pending
  roster-add row, display-only, so `getDisplaysByIds` fits.
- `app/src/routes/api.ts:1899` (unread-counts-by-contact rail) - a `Promise.all`
  fan-out over the requested `contactIds`. Concurrent already, so this is round
  trips rather than latency; note it reads `phone_ref` / `email_ref`, which the
  display projection does NOT carry, so it needs `getManyByIds`.

`app/src/jobs/broadcastFanOut.ts` resolves one contact per recipient, but that
job already does per-recipient work; batching there buys much less. Not a
target.

The messages repo already has the batching precedent
(`getManyByTsMsgIds`, app/src/repos/messagesRepo.ts:2451 - BatchGetItem chunked
at 100 keys with an UnprocessedKeys retry loop and backoff). The contacts base
table is hash-only on `contactId`, so that shape transfers directly.

**Suggested fix.** Add `contacts.getManyByIds(ids: string[])` to contactsRepo
following the `getManyByTsMsgIds` chunk-and-retry shape, then switch the
surfaces above to batch resolution. No invariant changes, no schema change.

One deliberate behavior change to make consciously rather than by accident:
today a single failed lookup blanks exactly one row's name, because each
`getById` has its own try/catch. A BatchGet failure is all-or-nothing for its
chunk, so one throw would blank up to 100 names instead of one. Wrapping each
chunk in try/catch preserves the "never 500 the page" posture but widens the
blast radius of a single failure - acceptable here (these are all display-name
enrichments with an id fallback), but it should be stated in tests rather than
discovered in production.

Acceptance is round-trip COUNT, not wall-clock: local DynamoDB timings are
emulator-bound and scale with table size regardless of what a query returns.
Prove the reduction with call-count assertions.
