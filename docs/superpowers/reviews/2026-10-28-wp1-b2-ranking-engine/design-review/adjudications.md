# WP1 B2a spec - design review adjudications

Spec: docs/superpowers/specs/2026-10-28-wp1-b2a-ranking-engine-design.md

## Round 1 (spec rev 1 at dc8025cc; revised to rev 2)

Two blind reviewers (opus), same brief. Reports: R1-reviewer-A.md (24
findings), R1-reviewer-B.md (17). Load-bearing code claims checked before
accepting: unitsRepo.ts:433-434 (`lif` = landlord incentive fee),
config.ts:648-649 (both AWS stacks run NODE_ENV=production),
.env.dev.example:211-224 (hosted dev runs anthropic extraction with a key),
authorityPrefill.ts:1-8 and orgNames.ts:270-289 (the server mapping rule
is `checkScalarWrite`), journalSweep.ts (uses the AI runs repo through
setVerdict only; no ai_runs scan).

Result: every finding ACCEPTED (several in merged form). None rejected,
none deferred. Decisions changed: yes (the tenant fingerprint's
definition, flag enforcement, the merge gate's directions and rule, the
console driver in production, the lean seed row, the run detail's
source, polling, the e2e lane) - round 2 required.

| Finding | Ruling | Change in rev 2 |
|---|---|---|
| A1 / B1 bare send changes the tenant fingerprint (order, bound, re-attach) | ACCEPT | D13: tenantCard hash = own fields less notes and propertiesSeen + the Notes text as stored + {unitId, declined, tours} for every outcome-bearing seen property, sorted by unitId; D2.3: the seen set is unbounded for attach and fingerprint, the prompt lists outcome entries always and bare ones to the bound |
| A2 / B2 unlawful flag on a checkbox becomes a permanent cap suppressor | ACCEPT | D5: code drops an unlawful flag unless its field is a free-text field holding text; counted as droppedUnlawfulFlags |
| A3 merge gate tests one direction only | ACCEPT | D17: every swap scored both as candidate and as anchor |
| A4 / B6.2 tolerance fails on noise at a band edge | ACCEPT | D17: band change within 5 points is not a failure; base re-run spread > 5 = inconclusive (fails as "decide") |
| B6.1 cap result depends on persisted flags | ACCEPT | D17: each run's cap from that run's own output; no flag persists in the check |
| B6.3 the DBHDD voucher authority is an unswapped disability proxy | ACCEPT | D17: authority swap added |
| A5 / B3 failedRequirements admits credit and income keys | ACCEPT | D5: removed from the enum; code drops them too |
| A6 rubric omits move-in-cost clause, first-reason-against, never-a-checkbox | ACCEPT | D4 |
| A7 legacy boolean pets passed raw | ACCEPT | D2.1: requirement items read through unitItemValue; "recorded" = stored true |
| A8 "never spelled out" vs the type-level registry | ACCEPT | D2.1: registry typed on typed keys minus TenantMatchingInputKey, list keys mapped in; B1 reader test scans ranking |
| A9 / B15 seed and legacy attributes unclassified | ACCEPT | D2.1: preferences_notes, voucher_program, rta_expiration_date included; caseworker, ai_mode, lead_status, origin, *_source excluded; default EXCLUDE plus handback list for anything unnamed |
| B15 agency's stated reason wrong | ACCEPT | D2.1: excluded as a possible disability proxy |
| A10 Q4 premise wrong (lif = landlord incentive fee) | ACCEPT | D2.1 and Q4 restated |
| A11 / B8 console driver fabricates scores, legal in prod, logs PII; model stamp unspecified | ACCEPT | D6: fake and console refused in production; console logs counts only; model stamped fake / console |
| B7 hosted dev is NODE_ENV=production | ACCEPT | D6 and section 7: dev ranks on dev's existing key; deploy checklist confirms the key |
| A12 / B9 e2e: worker poll races the tick; driver default console; no fixtures | ACCEPT | D7: RANKING_WORKER_POLL=off (refused in production); e2e-session.mjs sets it and RANKING_DRIVER=fake; specs build fixtures by API |
| A13 / B12 replacement lean seed row useless | ACCEPT | D8: legacy row removed, no replacement |
| A14 / B5 run detail shows other runs' rows | ACCEPT | D11: run stores handles and results[]; detail renders them, marks "since re-scored" |
| A15 / B10 GET recomputes everything, polled every 5 s | ACCEPT | D9 budget (150 tenants < 5 s, a miss is a build finding); D12 cheap job read is what is polled; ceiling applies to the read |
| A16 correlationId not a context field; job counter | ACCEPT | D7: fresh context, jobRunId = press requestId, traceparent carried as job envelopes do (no span claim); in-process counter named |
| A17 aiRunsRepo pointer reader and TTL | ACCEPT | D11: own rankingRunsRepo; 180-day pointer TTL |
| A18 / B14 Notes guard conflict rule stated two ways; seeds | ACCEPT | D14.3: the Staff notes rule (stamp moved => notes_stale); seeds dropped; notes_updated_at server-owned |
| A19 / B15 "last label" unbuildable; soft-deleted readable | ACCEPT | D2.3 |
| A20 failed-batch flag outlives a re-score from the other anchor | ACCEPT | D9: computedAt vs the job's startedAt |
| A21 / B4 landlord defaults and the cap undefined | ACCEPT | D2.1 |
| A22 Notes changes alter charter 6.4 without an amendment; one duplicate | ACCEPT | Charter section 20 item 14 recorded; D14.1 states the duplicate |
| A23 compile check cannot run at the spec gate | ACCEPT | D17.1: no gate-time run; offline shape test is the guard until the end-of-build run |
| A24 / B16 prices unverified; compile check uses thinking off; two enum variants | ACCEPT | D6, D5, Q6 |
| B11 server mapping misdescribed; normalized compare | ACCEPT | Section 2 and D1: checkScalarWrite; the normalized tenant compare stated as a deliberate widening |
| B13 expired queued never ends; join a finished job; includeOlder on tenant anchors | ACCEPT | D7, D9 |
| B15 ai_runs table comment | ACCEPT | D11 |
| B17 transcript folding changes; old multi-line duplicate | ACCEPT | D14.1, section 5 |
