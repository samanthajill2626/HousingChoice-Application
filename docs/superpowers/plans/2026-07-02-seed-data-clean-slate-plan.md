# Seed data clean slate — implementation plan

Executes `docs/superpowers/specs/2026-07-02-seed-data-clean-slate-design.md` (source of truth).
Grounding research (current seed map, entity/state inventory, sequence snapshots, persona
coupling): `.superpowers/sdd/seed-research.md` — implementers read the sections named per task.

## Global Constraints (bind every task)
- **The pinned trio is untouchable:** Tasha/Marcus/Renee items, phones `+1555010000X`,
  `conv-0001`/its 3 messages, `placement-0001`, `unit-0001/0002`, `match-0001`, `invoice-0001`,
  users 0001/0002, the 2 audit events — byte-identical in the lean profile. `app/test/seedData.test.ts`
  existing assertions must keep passing UNCHANGED (extend, never weaken).
- **Profiles:** `seedAll(endpoint, profile: 'lean' | 'full' = 'lean')`. lean = today's world.
  full = lean + cast + matrix + live. `/__dev/reseed` + e2e stay lean. `dev.mjs --seeded` sets
  `SEED_PROFILE=full` for `db-seed.ts`. NEVER seed a non-local endpoint (keep the guards).
- **Determinism:** fixed IDs (`<entity>-mx-<state>-NN` for matrix, `<entity>-cast-<slug>` for cast),
  fixed name pools, zero `Math.random()`. Fixed past dates everywhere except `live.ts`.
- **Consistency by construction:** placement-linked tenant/unit statuses via the real
  `deriveStatuses` (+`status_source: 'derived'`); reminder rows ONLY via the real
  `armTourReminders`; multi-phone contacts write their phone-pointer rows; casing gotchas
  (`firstName`/`lastName`/`voucherSize`/`housingAuthority` camelCase) respected.
- **Terminology:** unit/property/home; placement; navigator=staff. No PII in log lines.
- Verify with REAL exit codes (output to file + `echo EXIT=$?`; never pipe through tail).
- Stage EXPLICIT paths; commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  NEVER deploy/terraform/secrets/.env/.docx. Do NOT merge.

---

## Task 1: `seed/` module skeleton + profiles + holder-stamp fold-in

**Files:** create `app/src/lib/seed/index.ts`, `app/src/lib/seed/lean.ts`; rewrite
`app/src/lib/seedData.ts` as a thin re-export; modify `app/scripts/db-seed.ts` (profile via
`SEED_PROFILE` env), `scripts/dev.mjs` (`--seeded` → pass `SEED_PROFILE=full` to the db-seed
child ONLY — read the research §"How --seeded flows"; do NOT touch e2e-session), and
`app/src/lib/devReset.ts` ONLY if its import path needs the re-export (behavior: reseed stays
lean). Tests: extend `app/test/seedData.test.ts` with the profile contract.

- Move the current `SEED` verbatim into `seed/lean.ts`. `seedAll(endpoint, profile='lean')`
  in `seed/index.ts` seeds lean always; full adds cast/matrix/live (empty stubs this task).
- Fold `seedInboundVoiceLineHolder` into `seedAll` (both profiles; idempotent), keeping the
  exported function + `SEED_INBOUND_VOICE_CELL` for back-compat (devReset may still call it —
  make that a no-op-safe double stamp).
- `seedData.ts` re-exports { SEED, seedAll, LOCAL_DEFAULT_ENDPOINT, SEED_INBOUND_VOICE_CELL,
  seedInboundVoiceLineHolder } so devReset/db-seed/tests compile unchanged.
- **Tests:** existing seedData.test.ts green UNCHANGED; add: lean profile emits exactly the
  legacy SEED ids; full ⊇ lean; `--seeded` env plumbing unit-testable bit if cheap.
- **Verify:** typecheck; `npm test -w @housingchoice/app -- test/seedData.test.ts` + full app
  suite; a local `node`-driven `seedAll(endpoint,'lean')` against DynamoDB Local succeeds.

---

## Task 2: `matrix.ts` — the coverage generators

**Files:** create `app/src/lib/seed/matrix.ts` (+ helpers); wire into `seed/index.ts` full
profile. Tests: extend `app/test/seedData.test.ts` (matrix coverage assertions).

Per spec §5 (read it + research §"entity states"): placements 17×2 + moved_in×2 + lost×2
(distinct reason categories; every `next_deadline_type` ≥1, fixed past dates; a few
`attention`); each placement's generated tenant+unit statuses via `deriveStatuses`; units
every status ×2 net of placement-derived + ~6 tourable `available` (authorities × beds ×
tour_process variety) + pinned on_hold/off_market (`status_source: 'manual'`); tenants +
landlords every status ×2 net of coverage (landlord booleans varied; `parked` rows carry
`park_reason`); tours all 7 statuses ×2 net of story tours (fixed past; `no_show` w/ checkin
row ONLY via arm logic semantics — a sent checkin is a row with `sentAt`, acceptable to write
directly for ARCHIVE tours; document); consent methods `verbal_in_person`/`paper_form`/
`imported`/`client_inbound` distributed; broadcasts (1 sent w/ skipped_no_consent>0 results,
1 draft), listing_sends, invoices (draft/paid), activity_events (story placements), settings
defaults row, pool_numbers rows backing §Task-3 relay threads, `user-0003` va2.

**Coverage tests (the point of this task):** for each dimension assert ≥2 per enum value
across the FULL profile output; §7 derivation holds over ALL placements; every multi-phone
contact has exactly one primary + pointer rows; every `parked` landlord has `park_reason`.
**Verify:** typecheck; seedData tests green; full app suite; a scripted
`seedAll(endpoint,'full')` against DynamoDB Local completes without error.

---

## Task 3: `cast.ts` — story personas + threads + fake-twilio lockstep

**Files:** create `app/src/lib/seed/cast.ts`; modify `fake-twilio/src/engine/registry.ts`
(add ~7 personas w/ `seededRef`); tests: new drift-alarm test (app-side, reading both lists —
mirror the phone-lib pinned-tables pattern) + seedData.test extensions (cast invariants).

Per spec §4 (read it + research §"sequence stories" + §"personas"): the 9 new cast entries
with realistic threads (~60 msgs total incl. one missed inbound call + auto-text and one
completed recorded outbound call on the parked landlord — call entries per messagesRepo call
shape; recording_s3_key set, object seeded in Task 5), consent stamps as specified, flags
(one sms_opt_out, one sms_unreachable, one voice_opt_out), multi-phone searching tenant
(+ pointer row), the `requested` timeless tour + its tour-owned `relay_group` conversation
bound to a seeded pool number, the toured-exit-YES convertible tour w/ group history.
Phones from `+1555010010X`. NO reminder rows for the requested tour (invariant).

**Verify:** typecheck; drift-alarm + seedData tests green; full app suite; scripted full-seed
against DynamoDB Local; fake-twilio workspace tests green (`npm test -w @housingchoice/fake-twilio`
or its runner — check).

---

## Task 4: `live.ts` — the now-relative showcase

**Files:** create `app/src/lib/seed/live.ts`; wire into full profile. Tests: seedData.test
extensions with an injected-now seam.

Per spec §6: self-guided tour TODAY; landlord-led tour TOMORROW w/ group thread + ladder
armed via the REAL `armTourReminders` (import the job; construct its deps against the seed
endpoint — mirror how the app wires it; injected `now`); confirmed tour +2d; one overdue-RTA
placement (needs_you_now) + one due follow-up (their tenants/units via deriveStatuses).
`live.ts` takes `now` as a param (seedAll passes `new Date()`; tests pass fixed) so
assertions are deterministic. Reminders-invariant test extends over live tours.

**Verify:** typecheck; seedData tests green; full app suite; scripted full-seed → then a
quick assertion script: reminder rows exist ONLY for the tomorrow/today tours with dueAts
matching `armTourReminders` computation.

---

## Task 5: MinIO niceties + `--seeded` end-to-end smoke

**Files:** extend `seed/index.ts` (or a `seed/media.ts`): PUT one small MMS image + one short
audio object via the existing media-store client under the keys the cast references;
skip-gracefully (warn) when MinIO is unreachable. Assets: generate tiny valid files in-code
(e.g. 1×1 PNG bytes, sub-second WAV) — no binary checked in unless a fixtures dir already
exists (check; if one exists, follow it).

**Smoke (the acceptance):** boot `npm run dev -- --local --seeded` (lane-0 ports; ensure no
dev stack is already running — check :8080/:5174 first and ABORT the smoke with a note if the
human's dev loop is up), verify via API: contact/unit/placement/tour counts match the matrix,
Today shows the live items, /tours shows Upcoming + Needs booking, the fake-phones roster
shows the cast personas; then tear down. Where a live boot is impractical, drive the same
checks against a scripted seed + supertest app instance and SAY SO in the report.

**Verify:** typecheck; full app + dashboard suites; `npm run e2e` FULL suite green (lean
profile must keep it exactly as green as before — this is the regression gate; real exit code).

---

## Task 6: Final gates + review (orchestrator-led)

Full typecheck/app/dashboard/e2e (real exit codes); adversarial review (trio byte-compat,
profile isolation — reseed stays lean; coverage matrix honest; invariants: reminders,
derivation, one-primary, persona lockstep; no PII; YAGNI); fix loop; leave branch ready
(do NOT merge).
