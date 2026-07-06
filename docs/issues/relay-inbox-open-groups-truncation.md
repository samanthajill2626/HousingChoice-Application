---
id: relay-inbox-open-groups-truncation
title: Inbox silently drops open relay groups as TOTAL open-conversation volume grows
type: debt
severity: low
status: resolved
area: app
created: 2026-07-04
resolved: 2026-07-06
refs: app/src/routes/inbox.ts, app/src/repos/conversationsRepo.ts, app/src/lib/tables.ts
---

**Problem (corrected diagnosis).** `GET /api/inbox` merges relay-group rows
first-page-only via `conversations.listRelayGroups('open')`. The pre-fix query
walked the `byLastActivity` GSI on `status='open'` and post-filtered
`type='relay_group'` — but DynamoDB applies a `FilterExpression` **after** the
`Limit`, so the `RELAY_LIST_PAGE_LIMIT (100) × RELAY_LIST_MAX_PAGES (20) = 2000`
evaluation budget was consumed by open **1:1** threads (the `'open'` partition holds
EVERY open conversation, overwhelmingly 1:1s). A relay group ordered behind more than
the budget of more-recently-active open convs was never returned; because inbox relay
rows are page-1-only (`inbox.ts`), it then appeared on **no** inbox page.

The original write-up blamed relay-group **count** (≥2000 open relay groups). That was
wrong: the trigger scales with **TOTAL open conversations** (1:1s + relays), not
relay-group count — so it was reachable far sooner than "effectively unreachable."

**Resolution (2026-07-06, feat/relay-group-view).** Made open relay groups **directly
enumerable** via a new **sparse GSI**, eliminating the 1:1 walk entirely:

- **Schema** — added `byRelayStatus` to the `conversations` table
  (`app/src/lib/tables.ts`): HASH `relay_status`, SORT `last_activity_at`, sparse.
  `relay_status` = `relay_group#<status>` (`relay_group#open` / `relay_group#closed`)
  is written **only** on relay_group conversations, so 1:1 threads never index there.
  Regenerated `infra/envs/{dev,prod}/tables.auto.tfvars.json` (`gen:tables --check`
  clean).
- **Read path** — `listRelayGroups(status)` now queries `byRelayStatus` directly
  (`#rs = 'relay_group#'+status`, `ScanIndexForward:false`, same page budget). No
  post-Limit type filter → immune to open 1:1 volume; supports both open and closed.
- **Write path** — `relay_status` is stamped/kept in lockstep with `status` by every
  relay-group writer: `createRelayGroup` (→`relay_group#open`) and `setRelayStatus`
  (close/reopen flip it alongside `#s`). `last_activity_at` (the GSI sort key) is
  already maintained by `touchLastActivity`, whose targeted SET preserves
  `relay_status`, so activity updates re-sort the item in place.
- **Seed** — the seeded open relay groups (`live.ts` `conv-live-relay-group`,
  `cast.ts` ×2, `matrix.ts`) carry `relay_status: 'relay_group#open'` so the inbox
  e2e/roster reads still find them.
- **Test** — `app/test/relayRepos.integration.test.ts` reproduces the
  FilterExpression-after-Limit dilution at a scaled budget (30 open 1:1s ahead of one
  open relay group) and asserts the relay group is dropped by the pre-fix
  `byLastActivity`+filter query yet returned by the `byRelayStatus` query and by
  `listRelayGroups('open')`.

**Post-merge infra op (NOT run here — human gate).** Creating the GSI requires
`npm run plan -- dev` / `npm run apply -- dev` (flagged in RUNBOOK → DynamoDB schema
changes). Existing open relay groups predating the GSI lack `relay_status` until
re-stamped; dev is reseeded (seed stamps it) and prod relay-group volume is ~none, so
no data migration is needed.
