---
id: e2e-lane-tables-stale-schema
title: e2e lane DynamoDB tables persist with stale schemas — db:create never retrofits new GSIs
type: bug
severity: med
status: open
area: e2e
created: 2026-07-02
refs: app/scripts (db:create ensure-exists path), e2e/support/lane.mjs
---

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
