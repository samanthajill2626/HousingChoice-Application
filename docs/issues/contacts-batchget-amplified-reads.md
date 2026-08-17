---
id: contacts-batchget-amplified-reads
title: Sequential per-contact Gets amplify reads on broadcast results, property recipients, and property activity
type: debt
severity: medium
status: open
area: app
created: 2026-08-16
refs: app/src/repos/contactsRepo.ts
---

**Problem.** Several routes resolve contacts one sequential GetItem at a time
inside per-row loops, so response cost scales linearly with row count even
though DynamoDB BatchGetItem could fetch up to 100 per round trip. Surfaces
identified during the 2026-08-14 inbox performance investigation (repository
call profiling against the imported real dataset):

- Broadcast results: up to ~1,500 individual contact Gets in ~30 serial waves
  when rendering large recipient lists.
- Property (unit) recipients: one sequential contact Get per unique recipient
  with no useful route-level cap.
- Property (unit) activity: up to ~100 sequential contact Gets per page.
- Unread feed (`app/src/lib/unreadFeed.ts`, `collectUnreadRows`): one
  `contacts.findByPhone` / `findByEmail` per 1:1 index item walked, on the nav
  badge - the app's highest-frequency request - so a capped badge costs ~100
  contact Queries and a budget-bound walk up to 2,000. Added 2026-08-16 (review
  fix wave 2, adversarial r2 finding 3): a per-collect memo keyed on the
  PARTICIPANT KEY was tried and removed, because the claim arbiters
  (`phone#<E164>` / `claimEmail`) guarantee at most one OPEN conversation per
  key, so it can never hit. Batching is the only real remedy here, and it wants
  a `findByPhones`-shaped BatchGet as well as `getManyByIds`.

The messages repo already has the batching precedent (`getManyByTsMsgIds`,
app/src/repos/messagesRepo.ts - BatchGetItem chunked at 100 keys with an
UnprocessedKeys retry loop).

**Suggested fix.** Add `contacts.getManyByIds(ids: string[])` to contactsRepo
following the `getManyByTsMsgIds` chunk-and-retry shape, then switch the three
surfaces above to batch resolution. Mostly mechanical; no invariant changes.
Planned as the follow-up mission after feat/inbox-unread-index (agreed
2026-08-16).
