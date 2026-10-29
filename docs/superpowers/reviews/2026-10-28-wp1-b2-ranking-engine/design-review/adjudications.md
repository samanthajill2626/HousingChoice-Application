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

## Round 2 (spec rev 2 at 5b97ac07; revised to rev 3)

Reviewer A continued (re-review charge), with reviewer B's report handed
over. Report: R2-review.md (12 findings: 4 MEDIUM, 8 LOW). Every finding
ACCEPTED. Decisions changed: yes (the prompt bound, the tenant
fingerprint's content, expired-queue handling, the merge gate's rule,
voucher_program) - round 3 required.

| Finding | Ruling | Change in rev 3 |
|---|---|---|
| R2-1 outcome entries always listed = unbounded prompt; Q2 stale | ACCEPT | D2.3: 8 in all, outcome entries first; feedback of an unlisted entry goes back to notes; seen-set read cost stated; Q2 |
| R2-2 fingerprint omits card content (summaries, labels) - reverses charter 10.3 | ACCEPT | D13: outcome-bearing entries carry unitId, label, summary, declined, tours; only sends-only entries left out (the charter's own exception). The re-attach edge (first send of a property a Notes line already names) is ACCEPTED as changing the fingerprint once, since the card's meaning changes; no charter amendment needed |
| R2-3 expired queued records undefined in the poll; 120 s too short | ACCEPT | D7: RANKING_QUEUE_EXPIRY_MS 10 min; the poll marks expired queued records failed first; "Waiting for a free slot" |
| R2-4 gate still fails on noise (about 100 comparisons) | ACCEPT (contested A4/B6.2 ruling) | D17: two stages, a stage-one miss re-run five more times, failure only on the eight-run result; cap counts compared with slack |
| R2-5 "production's cap code" overstated | ACCEPT | D17: production's cap function on per-run flags; stored suppression not exercised there |
| R2-6 tour fields in the fingerprint unspecified | ACCEPT | D13: status, outcome, scheduled time only |
| R2-7 jobRunId = requestId breaks the context contract | ACCEPT | D7: fresh context carrying requestId, no jobRunId |
| R2-8 landlord:<key> flag survives switch-off or own value | ACCEPT | D10: open only while the field is on the current card |
| R2-9 stale text (matchKeys, registry type, header item, compile variants) | ACCEPT | fixed |
| R2-10 results[] cannot know the match write; cap of an old run undefined | ACCEPT | D11: cappedAtRun; matchesWritten set by a second update |
| R2-11 reader test vs examples.ts and the fake driver | ACCEPT | D2.1: card keys are the list labels; the two files exempt |
| R2-12 voucher_program a disability proxy | ACCEPT | D2.1: excluded with agency's reason |

## Round 3 (spec rev 3 at 985af124; revised to rev 4)

Reviewer A continued. Report: R3-review.md (7 findings: 2 MEDIUM tagged
DECISION, 5 LOW tagged PRECISION). Every finding ACCEPTED. Decisions
changed: yes, two (a complete full-item units reader with failure
semantics; the inconclusive rule's two stages) - round 4, the last
allowed, required.

| Finding | Ruling | Change in rev 4 |
|---|---|---|
| R3-1 fingerprint rests on a best-effort units read | ACCEPT | D2.3: new `unitsRepo.getManyByIds(ids, { requireComplete: true })`; an incomplete read fails the job or answers the read 503; the placeholder only after a complete read |
| R3-2 inconclusive rule decides the gate on noise; spread undefined | ACCEPT | D17: spread = difference of two base groups' means, with the same two stages |
| R3-3 expiry write can fail a just-claimed job | ACCEPT | D7: expiry write conditioned on status, generation and expiry; claim requires queuedExpiresAt > now |
| R3-4 tour projection only on the tenant hash | ACCEPT | D2.3: one tour projection used by cards, pair history and fingerprints |
| R3-5 mixed card keys; exemptions partly moot | ACCEPT | D2.1: property card keyed by attribute; only examples.ts exempt; the fake driver finds inputs through the list |
| R3-6 contests R2-2: the first-send edge needs Cameron | ACCEPT (reverses my R2-2 "no amendment" ruling) | Q7 to Cameron; charter item 15 on his yes |
| R3-7 decline and tours of an outcome home past the bound leave the card; Q2 silent | ACCEPT | Q2 restated |

## Round 4 - TERMINAL (spec rev 4 at d1121031; revised to rev 5)

Reviewer A continued. Report: R4-review.md (3 LOW, all PRECISION; no
DECISION; no adjudication contested). All three ACCEPTED. No decision
changed, so this is the terminal round and the review is CLOSED (4 of 4).

| Finding | Ruling | Change in rev 5 |
|---|---|---|
| R4-1 Q7 offers a false choice; a third option keeps charter 10.3 exact | ACCEPT | D13: only homes with a decline or tour carry label and summary into the fingerprint (feedback counts through the Notes text), so no send ever changes it; Q7 rewritten with this as the recommendation and no amendment needed |
| R4-2 one incomplete seen read 503s the whole ranking read | ACCEPT | D2.3: failure scoped to the one card - the candidate is left unscored in the job, marked `unverified` in the read; 503 only when the anchor's own card cannot be read |
| R4-3 which base runs a swap is compared against; cost | ACCEPT | D17: against the pair's base group A; about 400 stage-one calls, 10-20 dollars, printed before the first call |

## Totals at the spec gate

4 rounds, 63 findings (round 1: 41 from two reviewers; round 2: 12;
round 3: 7; round 4: 3). Accepted 63, rejected 0, deferred 0. One ruling
of the planner was reversed by the reviewer (R2-2 -> R3-6 -> R4-1: the
send/fingerprint edge, now closed without a charter amendment).
