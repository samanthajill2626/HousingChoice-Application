# Handback - Tour reminder ladder Phase B + relay group templates

Branch `feat/tour-reminder-ladder-phase-b`, worktree `W:\tmp\tour-reminder-ladder-phase-b`.
Base main @ec32170a; main merged ONCE @9b6d972c (main @5ce9912f, docs-only `_CLUSTERS.md`).
Final code commit **@b9247388**; this handback + self-QA record + one issue land on top
as a docs-only commit. **0 behind main** at handback time.

**MERGE-READY @b9247388 (+ docs commit) on `feat/tour-reminder-ladder-phase-b`
(`W:\tmp\tour-reminder-ladder-phase-b`), 0 behind main, UNMERGED (human gate).**

## Gates on @b9247388 (bare, exit codes read from redirected logs)

| gate | result |
|---|---|
| 1 `npm run typecheck` | EXIT 0 (all workspaces) |
| 2 `npm test` | EXIT 0 - app 347 files (+1 skipped file, 9 skipped tests), dashboard 183, fake-twilio 19, e2e-unit 34, fake-twilio-web 13 |
| 3 `npm run smoke` | EXIT 0 - 1365 import specifiers / 239 emitted files resolve under plain Node |
| 4 `npm run e2e` | **261 passed / 1 failed (18.5m), EXIT 1** - the failure is `outbound-mms.spec.ts:247`, a file this branch does not touch; isolated re-run `6 passed (50.9s)`; the same code passed 262/262 at @ee873111 minutes earlier (the two commits differ by comments, docs, and one added assertion in `relay-intro-variants.spec.ts`). FILED: `docs/issues/outbound-mms-viewer-scroll-capture-flake.md`. Both runs quoted there. |
| 5 `npx eslint <59 branch .ts/.tsx files>` | 9 errors / 6 warnings - IDENTICAL set at the merge base (scratch worktree at @ec32170a, same paths): **0 new**. Pre-existing, NAMED: `seed/live.ts` `followUpAt`, `overdueAt`; `seed/matrix.ts` `DEADLINE_TYPES`; `tourRemindersRepo.ts` `GetCommand` (import present with zero uses at the base - not the deleted-last-use trap); `routes/placements.ts` `nameFromContact`; `routes/relayGroups.ts` `resolveMessage`; `routes/tours.ts` `TourOutcome`; `ScheduledCard.tsx` `react-hooks/purity`; `RosterConfirmDialog.tsx` `react-hooks/set-state-in-effect`. |

e2e history on this branch: T9 checkpoint 260/260 @ab0459af; T14 checkpoint 261/261
@66229715; post-sync 261 pass + 1 fail @9b6d972c (the placement-e2e phone bug, fixed in
wave 2); 262/262 @ee873111; final 261/262 @b9247388 (the filed flake).

## Work map - per item

| task | status | where |
|---|---|---|
| T1 single-pass `interpolate` | SHIPPED | `app/src/messages/resolve.ts` callback replacement; structural catalog charset test; issue `message-interpolate-token-reexpansion` closed |
| T2 three tokens x six sites | SHIPPED | `tour_already_passed`, `kind_retired`, `names_unavailable` on `ReminderSkipReason`, wire union, labels, `SKIP_REASONS`, `ForceSendRefusal`, `SEND_NOW_ERROR_COPY` + a permanent-refusal completeness test |
| T3 shared predicate + fire-time gate + force refusal | SHIPPED, one ruling | `retiredByTourStart` (both operands as instants); gate FIRST in `processReminderRow` (tour read hoisted); force-send refuses pre-claim above the kill switch. **R1**: the D7 `beforeStart` disjunct KEPT as defence-in-depth, its test flipped to assert the retirement |
| T4 sweep script + RUNBOOK | SHIPPED, hardened twice | `app/scripts/retire-paused-tour-reminders.ts`: shared predicate, population B reads `DISCONTINUED_REMINDER_KINDS`, conditional writes, `--dry-run`, per-row PLAN failures counted + continue, WRITE failures abort with a PARTIAL report, `failed>0` -> exit 1; 12+ integration tests on DynamoDB Local; RUNBOOK one-time entry |
| T5 unit vehicle | SHIPPED | `createDueReminder`; ~30 cat-1 sites converted; `tourRemindersApi` send-now fixtures re-dated 2099 (a 2026-07 tour had rotted into the past under the new gate) |
| T6 e2e vehicle + live-worker audit | SHIPPED | future-rung tick idiom everywhere; `expectReminderRung('upcoming')` now excludes `/Skipped/`; worker poll comments corrected 60s -> 30s; audit in `build/slice-3.md` |
| T7 `DISCONTINUED_REMINDER_KINDS` + unpause | SHIPPED | `MANUAL_ONLY_REMINDER_KINDS` EMPTY (docblock rewritten); dev-tick divergence deleted; paused coverage preserved through the injection seams; `quiet-hours.spec.ts` test (2) inverted to QUIET_NOTE, test (3) deliberately NOT (wall-clock window vs fixed 19:30 rung = coin flip, documented in place) |
| T8 discontinued read surfaces | SHIPPED, widened by ruling | tour panel (outside `suppressionOf`), contact timeline, **R3: `routes/relayGroups.ts` scheduled view (a FIFTH surface the spec missed)**, `RemindersPanel` chip ABOVE paused, `ScheduledCard` label + muted tone, `DeadlinesNudgesCard` label entry ONLY (its chip branch was reverted in review) |
| T9 confirmation stops arming | SHIPPED | `REMINDER_KINDS` = 3 rungs; 28 re-derived pins; seeds re-commented (matrix's row is SENT, kept); 25 e2e assertions redesigned; `tour-roster.spec.ts` booking moved +5d -> +48h |
| T10 `en_route` exemption + widening | SHIPPED | arm, fire, panel estimate, timeline call site (never inside `quietFor`); `supersededBySlot` `<=`; `LADDER_ORDER` docblock; `seedLive.test.ts` mirror |
| T11 names bound both sites | SHIPPED | 1:1 + group, `rosterWaitExpired`, force-send unchanged |
| T12 `overdue` flag | SHIPPED, one deviation | both builders own `nowIso`; amber chip BELOW discontinued; **NO e2e assertion** (unreachable: the tick is time-injected, `overdue` is wall-clock; the live worker sends a past-due pending rung within 30s) - pinned at route + component level |
| T13 relay catalog | SHIPPED | five entries byte-exact (verified char-by-char by reviewer A), `{names}` total, `joinedName`; `member_added` untouched until T14 as planned |
| T14 resolver + split + parity | SHIPPED, two rulings | owner-keyed resolver (optional deps, every read try/caught, repo CONSTRUCTION contained); tour_today/tour/placement/naked; past tour (`<=` start) -> naked; `bodyFor` on `sendRelayAnnouncement`; ONE persisted row = new member's naked intro; five preview call sites; new `relay-intro-variants.spec.ts` (tour + placement walks) |
| T15 docs closure | SHIPPED | ledger resolved (9 rows), TODO re-pointed, `placement-nudge-overdue-invisible-on-card.md` now names the two excluded surfaces (the spec's claim that it already did was false), `founder-handback-items.md` (5 spec items + 4 build-found) |

## Review (three rounds, terminal) - `code-review/`

- R1: conformance A + plan-blind adversarial B -> 0 BLOCKING, 4 MUST-FIX, 10 SHOULD, 9 NOTE
  -> fix wave 1 (15 items, `build/fix-wave-1.md`). Headline catches: the tour intro had
  no past-tour guard (a quiet-hours-deferred open would text "let us know when you're on
  the way" after the tour); `next` was handed to the discontinued rung; a live Send now
  button on a rung that can only 409; the sweep discarded its counters on abort.
- R2: 1 BLOCKING (the new placement e2e read `phone` off a payload that only serves
  `phoneLast4` - confirmed by the full e2e), 1 MUST-FIX (the wave-1 per-row catch made a
  systemic write failure exit 0) -> fix wave 2 (9 items, `build/fix-wave-2.md`). The
  B-S5 ruling was RE-ISSUED as the proximate cause.
- R3: 0/0/2 SHOULD -> orchestrator polish commit; both reviewers confirm every item
  closed; reviewer A withdrew its dry-run exit-code objection.
- Reviewer B died on an API connection error mid-R3 and was resumed (recovery 1/2,
  agent-failure tier); its report was already on disk.

## Adjudications (R1-R15 in `build/worklist-and-rulings.md`; review rulings in `code-review/adjudications-r{1,2,3}.md`)

Product-adjacent ones the human should know: discontinued OUTRANKS opt-out/kill switch
(terminal, outside the suppression ladder); the `relayGroups.ts` scheduled view got the
discontinued suppression only; `DeadlinesNudgesCard` chip branch reverted (spec 3.1a's
narrowing honoured) while the shared `nextReminderRefetchDelay` helper keeps its
discontinued skip; the past-tour boundary for the relay intro is INCLUSIVE (`<=`) to
agree with the ladder gate.

## Self-QA - `self-qa.md`

Hermetic lane 7 @b9247388: a real tour + a pause-era pending `confirmation` written into
the lane table. Panel: `No longer sent` chip, NO Send now, no `Next`; `day_before` is
`Next`; nothing reads Paused. Sweep dry-run (writes nothing) -> apply (1 `kind_retired`)
-> re-run (no-op), all exit 0, PII-free logs; panel then reads `Skipped - this reminder
is no longer sent`. Tour-intro preview = Sam's dated form with resolved names/street.
Screenshots in the main checkout's `.playwright-mcp/selfqa-01-*.png`, `selfqa-02-*.png`.

## Post-merge obligations - LOUD

1. **The human runs the sweep**: `npx tsx app/scripts/retire-paused-tour-reminders.ts --dry-run`
   then without, against DEV, then PROD (operator shell carrying that environment's
   `DYNAMODB_ENDPOINT`/`TABLE_PREFIX`/credentials), then deploys - either order is now
   safe (the `DISCONTINUED_REMINDER_KINDS` guard means no confirmation can send by any
   path); sweep-first keeps the panel honest from the first moment. Exit 1 with
   `failed > 0` means investigate, then re-run (idempotent). The dry run cannot exercise
   the WRITE failure class (permissions / wrong prefix surface only mid-apply).
   **Until the sweep runs in an environment, pause-era `confirmation` rows there sit as
   `No longer sent` (after deploy) or as pending rows the old dashboard still promises
   (before deploy). Nothing sends either way.**
2. **Before the deploy that first sends an owner-routed intro, ask Sam the sender-
   identity question** - `founder-handback-items.md` item 2 (plus items 6-9 found during
   the build: ~21:00+ local tours now get an in-window `en_route`; the tour intro fires
   only for relays opened AFTER booking, and today's flow opens first; the role-less
   `Hey, adding {name} to the group.` is the common production case; the tenant-addressed
   intro reaches the landlord verbatim).
3. NO infra, NO new dependencies, NO secrets, NO Terraform.

## Not blocking - the human's eye

- **Deploy exposure of the unpause itself**: the first production tick after deploy sends
  every rung that is due and NOT retired - by design; the past-tour gate retires stale
  ones and the first `day_before` for tours booked before 2026-08-26 fires at the OLD
  timing (spec 4.5).
- `pollLoop` has no overlap guard (pre-existing); overlapping 30s ticks are safe (all
  writes conditional, A2P bucket paces sends) but now do real per-row reads.
- An operator-EDITED `intro_body` still sends verbatim past the tour (precedence 1, "a
  human chose it"); a quiet-hours-deferred relay open DISCARDS an edited intro
  (`routes/tours.ts:1391-1406`, pre-existing, now load-bearing for a comment).
- `member_added` raced-remove residual: `added` and `bodyFor` come from two conversation
  reads; a remove landing between them can persist a body no leg carried (harmless copy).
- `routes/dev.ts` replay-intros now replays VARIANT intros for seeded owned groups at boot.
- `contactTimeline.ts` does not project `skipReason`; a `tour_already_passed` retirement
  simply leaves the Upcoming bucket.
- Reviewer A observation: `viewOf`'s `overdue` is read by nobody (the panel refetches).

## Issues filed / resolved

- RESOLVED: `message-interpolate-token-reexpansion`, `tour-reminder-ladder-phase-b` (ledger, 9 rows).
- UPDATED: `placement-nudge-overdue-invisible-on-card` (two excluded surfaces recorded).
- FILED: `outbound-mms-viewer-scroll-capture-flake` (the gate-4 flake, untouched file).

## Numbers

33 non-merge commits on the branch (8 spec/plan/design-review before the build, 17 build,
8 review/fix/records) + 1 merge. Feature diff vs base: 64 files, +7615/-1449 (excluding
`docs/superpowers`); with records: 102 files, +18386/-1449. Branch left at its final commit.
