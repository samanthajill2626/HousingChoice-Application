# Handback - participant names: resolve on read (M1)

Branch `feat/participant-snapshot-refresh`, worktree `W:\tmp\participant-snapshot-refresh`.
Final commit `16df7dfa` (merge of `main` @1ce48fef into the branch; the single
pre-handback sync). 49 commits ahead of the base, 0 behind `main` at sync time.
Net code delta (app + dashboard + e2e, vs merge-base): 32 files, +1312 / -136.
Spec: `docs/superpowers/specs/2026-08-31-participant-snapshot-refresh-design.md`.
Plan: `docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md` (v2).

## Verdict

MERGE-READY @16df7dfa on feat/participant-snapshot-refresh
(W:\tmp\participant-snapshot-refresh), UNMERGED (human gate). Gates were run
and are green at 16df7dfa; the commits above it are review records only
(handback + this drift note).

MAIN DRIFT AFTER THE SYNC (reported, not chased, per the one-sync rule):
while the final gate battery ran, main advanced 3 commits - 065258b9
feat(relay) "It's Sam." intro copy (code: app/src/messages/catalog.ts +
app/test/relayFanOut.test.ts) plus two docs-only retirements (725a8746,
b1dc8489). ZERO file intersection with this branch's 32 touched code files
(verified by set comparison); outbound intro copy is exactly the surface this
branch excludes by decision 6, so the merge should be clean.

NO infra / post-merge ops owed: no dependency changes (no npm install), no
terraform, no secrets, no restart/reseed, no data backfill (this branch
changes no stored data). Two one-line PLANNING-DOC edits are owed post-merge
(see open question 1) and belong to the planner side, not this branch.

## Work map - shipped / deviated / skipped

| T | item | outcome |
|---|---|---|
| T0 | npm install + toolchain proof | shipped (45/45 contactName pre-flight) |
| T1 | lib/participantNames.ts + widened contactDisplayName | shipped @8902089e |
| T2 | Today who(conv, contact) + close-nag hydrated + buildToday guard | shipped @cde72c74; harness N = 1 distinct contact per GET /api/today (getById pinned at 1) |
| T3 | Inbox rows take a names map; 4 sites; sibling fakes | shipped @5e4416e5 (batches: groups 1, all 2 by declared cost, unread 1 per multi-party candidate by declared cost, unknown 0) |
| T4 | Contact cards, batch hoisted, ids post-filter | shipped @f3a17bf9 |
| T5 | Relay members panel batched + stored fallback; GET /calls/:callId hydrated | shipped @871ebefd. REVERSES the 2026-07 ruling: relayApi.test.ts pins retitled from "drops the creation-time name..." -> "keeps the creation-time name... (M1 ruling 2026-08-31)" and "falls back to the roster phone, not a stale name..." -> "keeps the stored name when the contact read fails (M1 ruling 2026-08-31)"; named in that commit body |
| T6 | describeRoster precedence flip; rosterEdits.ts two docblocks only | shipped @56141b4b; ZERO preview expectations re-baselined (research predicted, suites confirmed); comments-only proof recorded |
| T7 | pushSenderLabel + maskedPartyLabel contact-first; shortNameFromFull; whisper pinned | shipped @c96cbe27; the plan's third RED test was unbuildable as written (thread not yet created) and was redesigned per research C-1 (two posts, distinct MessageSid, assert the second broadcast) |
| T8 | rosterDriftTally + --audit-denorm group pass; one lane run | shipped @0167f59e (+ nameOnlyStored counter @7b9450e6, id-guard fix @9ad3f6bf); lane run DONE in self-QA, numbers below |
| T9 | e2e rename scenario | shipped @780f5119; three flow corrections vs the plan: Today is `/` (no /today route), the spec must leave the contact page before the tenant texts (an open contact timeline auto-reads a live inbound), and the Today assertion reload-polls because the board fetches once on mount |
| T10 | issue stamps + new issue + npm run issues | shipped @d4a45604; `status: resolved` + `resolved:` date used (`closed` is not a valid status); exit 0, no warnings on touched files |
| T11 | single main sync + five gates + handback | this document; sync @16df7dfa took 1af02926 AND 1ce48fef (a second docs-only mainline commit that landed mid-mission) |

Deviations from the SPEC, both pre-ratified by Cameron via the planner
(2026-09-01): (1) `today-contact-hydration-fan-out` stays OPEN with the
harness N recorded - the spec's "close wontfix if small" would have closed a
debt issue on a 1-contact harness number its own rule rejects; (2)
`GET /api/conversations` (Today's offline-fallback source) stays unhydrated on
the spec's own decision 4, recorded as residue in the resolved issue's stamp.

## Gates on the FINAL commit (16df7dfa), all bare, from the worktree

| gate | exit | evidence (quoted) |
|---|---|---|
| npm run typecheck | 0 | all five workspaces, 0 `error TS` |
| npm test | 0 | app `Test Files 350 passed | 1 skipped (351)` / `Tests 6436 passed | 9 skipped (6445)`; dashboard `183 passed / 2871`; e2e-ws `19 passed / 492`; fake-twilio `34 passed / 240`; fake-twilio-web `13 passed / 111` |
| npm run smoke | 0 | `smoke-dist: OK - 1374 import specifier(s) across 241 emitted file(s) resolve under plain Node.` |
| npm run e2e | 0 | `263 passed (23.7m)` - includes the new participant-names scenario |
| npx eslint (32 touched code files) | 1, net new 0 | sole error `relayGroups.ts:60 'resolveMessage' is defined but never used` fires byte-identically at `main` (baselined via `git show main:... | eslint --stdin` in P3 and re-confirmed on the synced list) - PRE-EXISTING, not this branch's; named here so nobody re-diagnoses it |

The pre-sync battery on 8cc3d165 was also fully green (same four zeros; e2e
`263 passed (26.3m)`), so green holds on both sides of the sync. No flake was
hit in either battery; no clean-key re-run was needed.

## Review record (all committed under this directory)

- Research fan-out (4 readers): 28 findings, 1 blocking (the T7 fixture), 2
  deviations; `research-A..D-findings.md` + `research-adjudications.md`.
- Round 1: `code-review-conformance.md` (conformant-with-notes) +
  plan-blind `code-review-adversarial.md` (empty hunts on security/PII,
  races, missed call sites); `code-review-adjudications.md`.
- Wave 1 @c895f081: isDeleted guard on pushSenderLabel + maskedPartyLabel
  (binding-constraint violation both round-1 reviewers caught); groupTitle
  relayThreadLabel docblock truth. `fix-wave-report.md`.
- Round 2 (fresh): both wave-1 fixes REAL; one new must-fix R2-1;
  `code-review-round2.md` + `code-review-round2-adjudications.md`.
- Wave 2 @7b9450e6: R2-1 pinned as DESIGNED behaviour (tag yields to
  hydrated names exactly as it always yielded to stored ones - sabotage-fail
  proven), relay push arm pinned, `nameOnlyStored` audit counter, comments.
- Wave-2 verification (fresh): CLEAN, all round-2 items closed;
  `wave2-verification.md`. Its 5-line punch list landed @9ad3f6bf (audit
  id-guard - would have corrupted the lane audit numbers; card carve-out pin;
  three comment corrections).
- Adjudication rulings of note: A-3 unread-arm batching NOT restructured
  (declared spec cost, bounded by MAX_INBOX_LIMIT); R2-3 deleted contact ->
  formatted phone where main showed the deleted name is CORRECT BY
  CONSTRAINT; R2-17/A-5 e2e Today leg kept (rung 1 carried by unit pins
  because the product's own PATCH write-through refreshes the 1:1 snapshot).

## Live self-QA (full detail in self-qa.md)

Hermetic lane 12, full profile, founder login. One UI rename
("Terrence Grant" -> "Terry Grant-Renamed"), five surfaces verified live:
Today close-nag, relay thread header facts line, relay members panel (new
name beside the STORED phone; reply-to line ditto), the other member's
contact-file card, the inbox relay row. MEASURED: the T8 audit ran twice -
fresh lane `name DIFFERS 0` (10 rosters / 22 members, `NOT RETURNED 0`,
exit 0), after the rename `name DIFFERS 2` (his stored name on both relay
rosters), everything else unchanged. The audit sees drift the moment it
exists and the surfaces mask it, which is the whole feature. 1:1 block:
11 open threads, display-name drifted 0, missing-but-known 1 (the
population S1 now masks). Baseline note: a fresh full lane has zero drift by
construction (writers copy names at creation); the synthetic-name drift
expectation applies to the PERF world, not the full profile.

## Issues

Resolved (3): `today-shows-phone-instead-of-name`,
`group-roster-name-snapshot-never-refreshed` (stamp carries the full
residue list: push titles, close-dialogs, GET /api/conversations + offline
fallback, SSE roster, bare-phone members, staff-only readers, and the
UNFIXED outbound half - see open question 1),
`relay-stale-participant-phone` (documented remove-and-re-add; no code).
Stamped, still open (2): `consolidate-contact-display-name-helpers` (census
corrected six -> thirteen, title + refs included),
`today-contact-hydration-fan-out` (harness N = 1 recorded; closure waits on
Cameron's imported-dataset perf:pages run - its own rule).
Filed (1): `staff-only-roster-name-readers-stale` (groupSend :252 refusal
strings, relayGroupDuplicates :68/:128, poolNumbersAdmin :108).
`npm run issues` exit 0; one pre-existing warning in an untouched file
(`perf-selfqa-route-contract-drift.md: unknown severity "medium"`).

## Open questions for Cameron

1. **The relayFanOut sender prefix** (per your ruling: no new issue filed).
   The resolved-high `group-roster-name-snapshot-never-refreshed` documents
   its own unfixed outbound half (`jobs/relayFanOut.ts:774` sender prefix -
   the durable one; intro/member-added bodies at `:1018-1021`/`:1082-1086`
   have only a seconds-wide drift window). Facts the reviewers added: the
   documented open+high triage query no longer surfaces it, and
   `docs/issues/_CLUSTERS.md:82` still lists the issue as an open high
   anchor while `:84` still says "six" helper copies. Owed post-merge:
   those two one-line _CLUSTERS edits (planning-side); reopen or file a
   follow-up only if a stale name is observed on a relayed message.
2. **Tag vs hydrated names** (R2-1, pinned as designed). A tagged,
   snapshot-nameless roster whose members resolve to named contacts now
   titles by the NAMES on the inbox row and contact card, while the push
   title still shows the tag (stored snapshot by decision) - a declared,
   pinned divergence. If you want the operator tag to beat live names, that
   is a one-line precedence change in `relayThreadLabel` + its own issue;
   say the word.
3. **today-contact-hydration-fan-out** closes only on your imported-dataset
   `npm run perf:pages` run (human-only target).

## Sub-threshold worries (not blocking, my eye)

- The close-nag hydration is one batch by construction (T1 pins the module)
  but no test at the today.ts call site counts the batch; T3/T4-style
  `displayBatches` pins cover the other boundaries.
- A phone-shaped STORED roster name would pass `shortNameFromFull`
  semi-verbatim into the masked label; main spoke it fully verbatim, so the
  class is pre-existing and strictly reduced, but the "NEVER the raw phone"
  docblock is aspirational for that (possibly empty) population.
- `GET /calls/:callId` now always returns a `participants` array (absent ->
  []) - a wire-shape nicety the optional-chained QuickReply consumer
  tolerates.
- The whisper now SPEAKS "Bob B." where it used to speak a stored full name
  (spec S4 accepts; pinned) - an audible change worth knowing at go-live.

## Note for bundle M3

No phone source changed anywhere in this branch; roster sends still address
`participants[].phone`, and the members panel renders the STORED phone
beside the resolved name (verified live in self-QA).

## Known flakes

None encountered: both full batteries green on first run; the named-flake
list in AGENTS.md remains empty; no DynamoDB contention signature appeared.
