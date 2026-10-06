# R4 findings - platform patterns, seeds, importer, dev seams, e2e pins, ops script

Plan research, area R4 (the `settings` table and its repos, read-and-bump
precedents, jobs and their registration, route mounting and admin gates, the
`/__dev` seams and reseed, every seed, the importer, the ops-script template,
and every e2e pin). Spec:
`docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 5). Code read at `feat/clean-org-names` HEAD `93c3c65b`. Byte-exact
quotes for every anchor below are in the gitignored reference
`.superpowers/sdd/plan-research/R4-platform-reference.md`.

Eight findings: two gate-2 test pins the spec never names (F1, F2), two job
semantics the spec leaves open against the real queue (F3, F4), an importer
gap where D2 meets the importer's dry run (F5), and three low-severity misses
(F6 unit-side unknowns, F7 a seed-only slug field, F8 a stale RUNBOOK
paragraph). None changes the design direction. The audit key `by` vs `actor`
(D11) was found independently here too; it is R1's F2 and is not repeated.

---

## F1 (medium, missed gate-2 pins) - two e2e-workspace unit tests inside `npm test` pin the dashboard surfaces branch A adds

**Spec says.** Section 6 adds the `/api/organizations` endpoints (add,
check, PATCH, merge, delete, not-on-list resolve, rewrite run-again); D10
adds a Settings tab; section 7 lists the e2e work as spec edits only.

**Code does.** Root `npm test` runs every workspace's `test` script
(`package.json:39`); the e2e workspace's is `vitest run`
(`e2e/package.json:9`) over `performance/**` and `support/**`
(`e2e/vitest.config.ts:8`). Two of those tests are mechanical inventories of
`dashboard/src`:

- `e2e/performance/mutationCatalog.test.ts:364-382` requires the checked-in
  `DASHBOARD_MUTATION_CATALOG` (`e2e/performance/mutationCatalog.ts`) to equal
  every POST/PUT/PATCH/DELETE call it discovers in `dashboard/src`, with the
  non-delegated count pinned at 111 (`:376`) and `automatic_in_scope` pinned
  at exactly 4 (`:386-387`).
- `e2e/performance/routes.test.ts:348-391` matches the route elements in
  `dashboard/src/App.tsx` against the page-profiler registry. Settings
  children are recognised only from a hard-coded list (`:368-370`), so a new
  `<Route path=...>` under `settings` (the shape at `App.tsx:186-228`) reads
  as an unknown top-level path and fails the equality at `:386-387`.

**Why it matters.** Both fail gate 2 the moment the dashboard client and
the tab land, with messages that point at the profiler, not at this feature.

**Suggested resolution.** Plan tasks that (a) add one catalog row per new
client function (behavior `workflow_only` unless a call fires on its own,
e.g. a `/check` while typing or on mount, which must be classified
deliberately) and bump the count and its comment; (b) either register the new
tab as a profiler surface (the "exactly 31" pins at `routes.test.ts:212`,
`:289-290`, `:653`, plus its source/GET contracts in `routes.ts`) or add its
path to `excluded` with a tracking issue, as `/tours/past` did (`:381-382`).
The D8 accept `value` changes no catalog fingerprint.

---

## F2 (low, missed pin) - the complete job-name set is pinned

**Spec says.** D11: the rewrite is enqueued with `jobs.enqueue` and run by a
job. Nothing about registration.

**Code does.** Handlers register through ONE function both entrypoints call
(`app/src/jobs/registerHandlers.ts:57-92`; app side only when
`JOBS_QUEUE_URL` is unset, `app/src/index.ts:42-56`; worker
`app/src/worker.ts:107-113`), and `app/test/registerHandlers.test.ts:13-36`
pins the exact sorted list of registered job names.

**Suggested resolution.** The plan's job task registers the rewrite handler
inside `registerAllJobHandlers` (never in one entrypoint only - the drift that
comment block records) and adds its name to the pinned list.

---

## F3 (medium, spec precision) - `lastRewrite.jobId` cannot be the jobs envelope id

**Spec says.** 5.1 `lastRewrite.jobId: string`; D11: "ONE conditional write
of the list item ... sets `lastRewrite` to `running` with the rewrite's
definition ...; then the job is enqueued".

**Code does.** The envelope `jobId` is minted inside `buildEnvelope`
(`app/src/jobs/jobs.ts:186-195`) during `enqueue` (`:107-129`), i.e. after
the list write that must already carry the id.

**Why it matters.** Taking the envelope id forces a second list write after
the enqueue (breaking the one-write order and opening a window where
`running` names no job), or leaves `jobId` empty.

**Suggested resolution.** Mint the rewrite id (randomUUID) before the list
write, store it as `lastRewrite.jobId`, and carry it in the job payload; the
job acts only while the stored `lastRewrite.jobId` equals its payload id.

---

## F4 (medium, open semantics) - the rewrite job's failure and duplicate-delivery behaviour is unspecified against the real queue

**Spec says.** D11: an enqueue failure sets `failed`; the job heartbeats and
"finishes with `done`"; a `failed` or stale (`> 15 min`) rewrite shows "Run
again"; re-running a definition is safe.

**Code does.** Production: the jobs queue has a 120 s visibility timeout and
`maxReceiveCount` 5 before the DLQ (`infra/modules/jobs/main.tf:29-40`);
`dispatchJob` rethrows a handler error (`app/src/jobs/jobs.ts:330-341`) and
the consumer leaves the message to redeliver
(`app/src/adapters/sqsJobConsumer.ts:11-24`); a handler running past 120 s
gets a concurrent duplicate. Local dev and every e2e lane: the in-process
adapter catches and only logs a handler error
(`app/src/adapters/scheduler.ts:193-204`), so local tests cannot see a
throw-based design misbehave.

**Why it matters.** A job that throws after recording `failed` is re-run up
to five times and flips the status back; a duplicate or a stale run (one that
outlived the 15-minute lock) can write `done` or a heartbeat over a NEWER
rewrite's `lastRewrite`.

**Suggested resolution.** State in the plan: the handler catches its own
errors, records `failed` with counts, and does not rethrow; every heartbeat
and finish is a D1 read-and-bump that first checks `lastRewrite.jobId` is
still its own (F3) and does nothing otherwise; per-record writes stay
conditional (already in D11). A test can drive two concurrent runs of one
definition through the world fakes.

---

## F5 (medium, gap) - how the importer gets the list, and D2 versus `import:apply --dry-run`

**Spec says.** D9: the importer resolves each value with D4; ambiguous or
unknown values are "listed in the import report with counts". D2: "the first
read in an environment that finds no `org-list` item writes the starting
list". Section 8 gives the cleanup a non-creating rule (the stored item, or
the starting list when absent; a dry run never writes), but D9 states no rule
for the importer.

**Code does.** `ApplyOptions` has no list input
(`app/src/lib/import/apply.ts:145-168`). The CLI builds its own client and
`stageEnv` (`app/scripts/import-apply.ts:227-264`), and its `--dry-run`
contract is "write nothing" (`:90`). The existing unknown-authority
accounting runs only on a real run - the dry-run `continue`
(`apply.ts:292-295`) precedes the count (`:297-302`). The integration suite
creates only `contacts`, `conversations`, `messages`, `units`
(`app/test/importApply.integration.test.ts:44`).

**Why it matters.** A get-or-create read in the importer makes a dry run
against an environment write `org-list` (pre-deploy that would also pin the
starting list before the deploy). A dry run also cannot preview D9's
"not written" values today.

**Suggested resolution.** Give the importer the cleanup's rule: a
non-creating read with the Appendix A fallback, the list passed into
`runApply` as an option (tests inject it; no `settings` table needed), and
the per-value unwritten counts computed in BOTH modes so the dry run is the
preview.

---

## F6 (low, gap) - D9's unit side does not say what happens to an unknown or ambiguous value

**Spec says.** D9 unit side: the ownership rule is unchanged; "the values it
writes are resolved names, and agency names are never written to a unit".

**Code does.** `upsertUnit` writes whatever `housingAuthorityFor` returns -
an unknown value passes through verbatim (`apply.ts:1356-1359`, normalizer at
`app/src/lib/housingAuthority.ts:69-74`) - and nothing reports it; the
passthrough warnings are contact-side only (`apply.ts:297-318`).

**Suggested resolution.** State it: an unknown or ambiguous unit value is not
written and is counted in the report like the contact side. (On a human-owned
unit nothing would change anyway - its facts are fill-only.)

---

## F7 (low, missed seed field) - `authorities_served` keeps slugs that no rule or reader covers

**Spec says.** Section 7: every seed uses list names; "slugs are retired".
5.2 lists the fields that hold names.

**Code does.** A landlord field `authorities_served` holds slugs in the lean
(`app/src/lib/seed/lean.ts:147`), cast (`app/src/lib/seed/cast.ts:1205`,
`:1328`, `:1342`) and live (`app/src/lib/seed/live.ts:183`) seeds. It is
document-only: no API path, reader or writer
(`docs/issues/landlord-onboarding-record-fields.md:31-35`). Neither the
cleanup (section 8) nor "Not on the list" (D10) reads it.

**Suggested resolution.** Decide in the plan: rewrite to list names, or drop
the field from the seeds (nothing reads it). Either is a seed-only edit.

---

## F8 (low, stale operator doc) - RUNBOOK tells operators to edit the alias map

**Spec says.** Section 11: RUNBOOK gets new sections for the cleanup and the
Settings rewrite actions.

**Code does.** `RUNBOOK.md:1291-1299` says that when an authority keeps
arriving as a suggestion, the fix is to add its spelling to
`CANONICAL_AUTHORITY` in `lib/housingAuthority.ts`.

**Suggested resolution.** Rewrite that paragraph in the same change: spellings
are now added on Settings > Housing authorities & agencies by an admin (D12),
and an unknown name stays a suggestion until staff add it (D8).
