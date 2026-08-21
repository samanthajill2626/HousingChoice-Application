---
id: e2e-lane-tables-stale-schema
title: e2e lane DynamoDB tables persist with stale schemas — db:create never retrofits new GSIs
type: bug
severity: med
status: resolved
area: e2e
created: 2026-07-02
resolved: 2026-08-21
refs: scripts/e2e-session.mjs, app/scripts/db-update-gsis.ts, app/scripts/db-create.ts
---

**Resolution (2026-08-21, `fix/e2e-harness-determinism`).** The e2e boot now
runs `db:update-gsis` between `db-create` and `db-seed`.

No new mechanism was needed - the remedy already existed and simply was not on
this path. `db:update-gsis` diffs each live table against its `TableSpec` and
creates only the missing indexes, one per `UpdateTable` as DynamoDB requires.
No data loss (unlike `db:create --reset`), idempotent (a current lane reports
`ok`), and hard-gated to a localhost endpoint so it can never touch a deployed
table.

Deliberately NOT the suggested-fix alternative: a per-lane schema hash was
drafted (the lane lease even carried `stampSchemaHash`/`readSchemaHash` for a
while) and then removed unused. A cached fingerprint is a second source of truth
about schema currency, and the one that can be wrong, in front of a diff that is
already cheap and exact.

Verified on a lane that already had all 22 tables from a previous run - the
stale-lane shape - where `db:create` reported `exists ... skipped` for every one
and `db:update-gsis` then reported `0 index(es) added, 22 table(s) already
current`. The index-adding path is covered by the `db:update-gsis` cases in
`app/test/unreadIndexRepo.integration.test.ts`.

**Problem.** Lane stores in the shared DynamoDB Local container persist across
runs, and `db:create` ensures tables by EXISTENCE only ("exists hc-local-<L>-…
— skipped"). When `lib/tables.ts` gains a new GSI (e.g. `tours.byStatus`,
added 2026-07-02), any lane whose tables were created before the change keeps
the old schema forever. Symptom (hit live on lane 5, 2026-07-02): the full e2e
suite failed only `tours-page.spec.ts` (Upcoming / "Needs booking" regions
never render) because `GET /api/tours?status=…` needs the missing `byStatus`
GSI — reproducible in isolation, looked like a branch regression, and was
actually environment drift. Fix applied by hand: delete the lane's
`hc-local-<L>-*` tables so the next boot recreates them (vitest's keyed-table
globalSetup, 0b7a340, solved the same problem for unit tests but not for e2e
lanes).

**Update (2026-07-21, lanes 15 AND 16, ~5 wasted full-suite runs).** After a
schema-adding mainline day (email channel + related merges), EVERY lane created
before it is stale at once, and the symptom is a BROAD ~20-spec cluster
(broadcasts consent PATCH not-ok, contact-detail edits, inbox-comms, email
flows, MMS media legs) rather than one obviously-related spec - it looks like a
catastrophic branch regression, is deterministic across re-runs on the same
lane, and a fresh lane on the identical commit is green. Diagnosis shortcut:
same tip green on one lane + red cluster on another = stale lane, not code.
Cure per lane: wipe `hc-local-<L>-*` under the lane's OWN access key
(`hclane<L>` - the default `local` key cannot see them), next boot recreates.

**Suggested fix.** In the e2e boot path (`db:create` or lane preflight),
compare each existing table's GSI set against `lib/tables.ts` and
delete+recreate the table on mismatch (lane data is hermetic and reseeded, so
recreate is always safe there). Alternatively stamp a schema hash per lane
(e.g. an item in `settings`) and recreate the lane's tables when it changes.
The 2026-07-21 broad-cluster episode upgrades the value of this fix: the
manual cure had to be applied to two lanes in one day.
