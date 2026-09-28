# Share Sent Outcome (Branch B) - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision 3** (2026-09-28, after adversarial plan review rounds 1 and 2 - round 1: two independent reviewers, 16 + 21 findings; round 2: 13 findings; all accepted; adjudications in `docs/superpowers/reviews/2026-09-27-share-sent-outcome/plan-review-r1-adjudications.md` and `plan-review-r2-adjudications.md`). This document is self-contained: every test and every code block a task needs is IN that task. Where a code block names a helper, that helper is defined in the task the block cites.

**Stage 1b's four interface facts are VERIFIED as built** (spec section 0's "first task"): `research-1b-as-built-findings.md`, headline and sections A-E - every retry append site stamps `retry_root` (hop cap 16) and a one-hop `broadcast_id`; `retry_outcome: 'unconfirmed'` is written at every WITHDRAW; the job's arms close the record first with no re-apply; the `retrychild#` family and the any-child-supersedes refusal exist. No correction task is needed; Task 1 is the first build task.

**Test-helper facts every sketch below relies on** (read once; the sketches use them as written): `createLogCapture()` returns `{ stream, lines, atLevel }` and a logger is built with `createLogger({ level: 'info', destination: capture.stream })` (`app/test/helpers/logCapture.ts:14-38`, the idiom at `broadcastFanOut.test.ts:181`); `atLevel(n)` is an EXACT pino level match (error 50, warn 40, info 30). The in-memory world is `createFakeWorld()` and the webhook harness `makeWebhookHarness()` (`app/test/helpers/twilioWebhookHarness.ts:504`, `:4932`); the bus is `world.events`. `zeroStats()` takes no argument (`broadcastsRepo.ts:328`). A `BroadcastItem` literal needs `created_by`, `audience_filter` and `body_template` (`:168-214`) - the sketches write `{ ...baseShare, ... }` with a file-local `baseShare` that carries them. `broadcastsRepo.integration.test.ts` seeds through the repo's own `create` (`:53-70`); the sketches call it `putShare(item)`, a file-local helper the task defines as one `PutCommand` on the table. Call order is asserted with `mock.invocationCallOrder` (`broadcastFanOut.test.ts:2500-2503`).

**Goal:** A property send (a `broadcast` row) tells one true story about whether each tenant got the property: a retry's outcome reaches the share slot by every path it can arrive, the composer's "Already sent" flag and every label, count, ledger row and milestone derive from one per-recipient state, and a Cameron-run repair brings existing rows in line.

**Architecture:** One per-recipient STATE (D1) is derived from the slot plus, within a 24-minute bound, the newest attempt's own message row and, for a queued slot of a finished share, its send-attempt record; every surface reads it through one service with two readings (safe for the composer flag, strict for everything else). A later attempt reaches its slot through ONE attempt-ordered conditional slot write (D2, a new repo primitive that names the recorded attempt in its condition and carries the stats delta) called from the status webhook's rollup, the reconcile's retry adoption and the four unresolved-end sites 1b built. The listing-send ledger gains per-share memory and a `counted` flag (D7), written by a conditional read-modify-write service; the "Property sent" milestone carries its share id and reads its words from the ledger (D6); the two "Sent to N tenants" surfaces recount at read time (D5); the share labels derive from the buckets plus an optional `retry_pending` count (D4); a dry-run-first operator script repairs history (D8).

**Tech Stack:** TypeScript (Node 24, ESM), Express, DynamoDB (`@aws-sdk/lib-dynamodb`, DynamoDB Local for integration tests), Vitest (app + dashboard), React dashboard, Playwright e2e harness with the in-repo fake-twilio, tsx for scripts.

**Spec:** `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md` (v5 + the 2026-09-28 restatement against Stage 1b as built, @4063f410 or later). D-numbers are this spec's. It reads on top of Stage 1b (`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`, section 8 "Errata as built"), SOR (`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`, section 12) and RSW.

**Branch / worktree:** `feat/share-sent-outcome` at `W:\tmp\share-sent-outcome`, cut from `main@d9cb5c04`, main synced ONCE at `cebc7d23` (= `main@3f38bcc2`, Stage 1b merged). Task 15 REPORTS later drift; it does NOT merge main again without the planner's word.

**Research maps the tasks cite** (line numbers at `cebc7d23`; re-derive by reading before editing): findings (tracked) in `docs/superpowers/reviews/2026-09-27-share-sent-outcome/research-1b-as-built-findings.md` (the retry job, the reconcile, the attempt records, the webhook) and `research-surfaces-refresh-findings.md` (everything else); byte-exact references (gitignored) in `.superpowers/sdd/research-1b-as-built-reference.md` and `research-surfaces-refresh-reference.md`. Where a test sketch names a fixture, USE THE FILE'S REAL FIXTURE NAMES (read the file first). Log-capture facts: `createLogCapture().lines` are parsed objects; `capture.atLevel(50)` takes the pino numeric level (error 50, warn 40, info 30); match on `line.msg` and fields.

**One deliverable, not fifteen.** The slices below are commit-and-review checkpoints, NOT shippable states: after Slice 1 the slot carries a pointer nobody writes; after Slice 2 outcomes reach slots that no surface reads differently yet. The branch is merge-ready only after Task 15.

**Declared deviations from the spec's wording (deliberate; the handback restates them):**
1. D8 enumerates shares with ONE Scan of the broadcasts table filtered to unit-targeted rows, not "both share indexes": a Scan is complete (pre-backfill rows too), needs no unit enumeration, and the table is small (the spec's own D8 allows a scan of a small table for the ledger).
2. The composer flag's rule leaves the repo: `priorRecipientContactIds` and its harness mirror are DELETED and the service `priorRecipientKeys` (Task 2) owns the rule, reading shares through `listByUnit`, rows through `getByTsMsgIdConsistent` and records through `sendAttemptsRepo.get`. One rule, one place; the harness now mirrors only reads.
3. A row-less attempt (the reconcile's unresolved close of a retry that was never appended) is ordered by the key `<retriedTsMsgId>~`: `~` (0x7E) sorts after `#` and every SID character, so the marker is newer than the retried row and older than any later provider timestamp. A seeded legacy ledger entry uses `!legacy` (`!` sorts before any year digit).
4. The "Not confirmed" pill takes the danger tone (the chip's tone, `StatChips.tsx`); the spec names the label only.
5. A ledger entry stores `conversationId` beside its attempt key: D6 reads the attempt's row for a `pending` entry and a row is keyed by conversation + tsMsgId.
6. D7's writer at an ORIGINAL row's rollup names the pair's contact from the row's own `recipient_contact_id` (RSW stamps it while the contact holds the number); a row without it (pre-RSW, or a number nobody held) writes no ledger entry and logs INFO. Same derivation as the pass, without a contact read.
7. `retry_pending` is emitted by the rollup as a LOWER BOUND (its own recipient) and by nothing else; the results and list routes compute the true count. The pages merge an omitted count by keeping the last value and, for a finished share with a positive value, refetching that share's stats through `GET /api/broadcasts/:id/results?view=stats` (Cameron's ruling, spec section 9). The RESULTS page additionally recounts `retry_pending` from its own rows' `retryDueAt` on its one-minute ticker, so its pill and chips never outlive a lapsed promise (the spec's "the results page ticks").
8. The ledger row's change token is a random `shares_op` stamped by every `putShareMemory`, never `updated_at` (a millisecond ISO can collide; a seeded row has none). A row without the token - absent, or seeded - takes the condition `attribute_not_exists(shares_op)`.
9. A counted ledger entry's `countedAt` is the ATTEMPT's own provider instant (the ISO in its key), never the write instant, so a delivery receipt does not move `sentAt` and the repair rewrites no dates; a seeded legacy entry keeps the row's own `sentAt`.
10. `recordSend` is RETIRED (its only runtime caller was the fan-out; seeds write raw items): one ledger writer, `putShareMemory`, through `applyShareLedgerEntry`. An individual-only pair keeps `broadcastId` ABSENT (its seeded entry is keyed `individual`; the key never rides the wire).
11. At the reconcile's two sites this branch's slot write is BOUNDED, not propagated and not silently swallowed: a thrown write is retried twice (a transient DynamoDB fault survives), then logged at ERROR and the site continues - at the unresolved-close arm the WITHDRAW runs FIRST (the promise withdrawal is the fact the thread and the route depend on) and the slot write second; at the adoption hook the slot write runs before the record close. A permanent failure (the 400 KB item-size error spec section 8 names) therefore never loops a check into the queue or the DLQ; the dropped write is the repair's residue at every site, not only the job's arms (spec section 8 is amended in this revision). The job's two arms keep `guardWrite`.
12. D1's send-attempt RECORD reads run only for the composer flag (`priorRecipientKeys`); the results, list and stats-only routes resolve states without them (the record only tells in flight from stranded, which those surfaces do not distinguish). A record NOT READ has two meanings the classifier tells apart: "the caller did not ask" (`facts.record` absent -> `in_flight`, the safe side) and "the share is past the 30-day record life" (`facts.record === 'expired'` -> `stranded`, spec D1's "reads stranded without a read"). Row and record reads run with bounded concurrency (8 at a time).
13. The webhook's enqueue-failure withdrawal (RSW's arm, `twilio.ts:3632-3656`) emits a `broadcast.updated` with `retry_pending: 0` for a share row, so a list that turned Sending on the rollup's emit turns back when the retry never got queued.
14. The results route marks each recipient `retryPending: true` when its D1 state is `pending` (so a recipient whose row read failed, pending on the safe side, is counted); the results page recounts pending ONLY on its ticker (never on an SSE overlay or before its refetch), from rows that are `retryPending` and whose `retryDueAt` is absent or still live.

## Global Constraints

- ASCII-only in every line this branch ADDS or TOUCHES (code, comments, tests, docs, log strings). `twilio.ts:3904` (the give-up line), `broadcastsRepo.ts:740` and `BroadcastResults.tsx:74` carry pre-existing non-ASCII characters; a touched line is re-worded in ASCII and its tests match the new string. Verify a NEW file with `LC_ALL=C tr -d '\11\12\15\40-\176' < FILE | wc -c` (must print 0); on a pre-existing file check the diff's added lines the same way.
- No new slot STATUS, no new share status, no new table, no new GSI, no Terraform change, no new dependency, no `.env` edit (I9). The ledger's `byContact` GSI becomes sparse by attribute ABSENCE; `tables.ts` gains `sparse: true` on it (a contract note; `gen-tables.ts` emits no `sparse`, `app/test/genTables.test.ts:111-112`) and the README deviations table (`app/src/lib/tables.ts:17-19`, `README.md:25`) records it.
- Every DynamoDB expression lists EXACTLY the attribute names and values it uses (an unused alias is a ValidationException, `app/test/aiRunsRepo.integration.test.ts:302-316`).
- Every slot write this branch adds goes through `applyAttemptOutcome` (Task 1): one conditional write carrying the stats delta (I4). The pre-existing two-write rollup for an ORIGINAL row's receipt (`twilio.ts:3949`, `:3975`) is SOR's filed residue and is not widened or "fixed" here.
- Stage 1b's record, claim and close SEMANTICS are untouched (I7): this branch only INSERTS calls at the five sites Task 6 names, placing its write BEFORE the record close at the job's two arms and BEFORE `closeFromReconcile(adopted)` at the adoption, always through `guardWrite` where the job's contract says nothing may throw (`app/src/jobs/retrySend.ts:24-27`). `MAX_HOP_COUNT`, `sqsJobConsumer.ts`, `oneToOneRetryDecision.ts` and `jobs.ts` are not edited.
- The one source of a promise is the message row (I5): nothing copies `retry_due_at` or `retry_outcome` onto a slot or a ledger entry.
- Import cycle `retrySend.ts` <-> `sendReconcile.ts` (`sendReconcile.ts:43-47`): the new services `shareAttemptOutcome.ts` and `shareLedger.ts` import repos and libs only, never a job module; `npm run smoke` proves the compiled graph.
- Dashboard copy (exact, ASCII, plain literals; staff-facing copy is not catalog-governed, `deliveryStatus.ts:1116-1117`): pills `Sent`, `Sending`, `Not confirmed`, `Not sent`; chip `Retrying`; hint `open conversation to retry`; app-side labels `Sent to N tenants` / `Sent to 1 tenant` / `No tenants reached`; milestone words `Property sent`, `Property sent - not confirmed`, `Property text failed`.
- The recipient cap `MAX_BROADCAST_RECIPIENTS` becomes 1000 (spec section 9, Cameron's gate). Tests pin the cap by the constant (`broadcastApi.test.ts:561`, `:985`) and keep passing; the budget comment `broadcastsRepo.ts:56-68` is rewritten for the sixth slot attribute.
- Log lines carry ids and counts only (broadcastId, conversationId, tsMsgId, contactKey, attempt keys, states); never a phone, a name or a body.
- E2E: never `contact-tenant-0002` / `conv-0002`; every recipient a fresh consented tenant on a per-run number (uid from 90, the `retry-send-adoption.spec.ts` precedent); never arm a fail seam on a shared seed number; a lane is booted FRESH (`E2E_SEND_RETRY_BACKOFF_MS` 10000 and `E2E_SEND_RECONCILE_DELAYS_MS` 2000,4000,8000 already ride `scripts/e2e-session.mjs:283`, `:296`); a fake arming is SINGLE-USE (`fake-twilio/src/engine/engine.ts:512-516`), re-arm after each send lands.
- Gates run BARE from the worktree in a BASH shell: `npm run typecheck`, `npm test`, `npm run smoke`, `timeout 1800 npm run e2e` (1b's green runs of the 300-spec suite took about 21-24 minutes; this branch adds one slow spec), `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` (empty list = skip; attribute errors by baseline comparison at the merge base). `npm test` needs DynamoDB Local (`npm run db:start`); restart the container before a gate run if it has served many per-file databases. Never commit during `npm run e2e`; never edit source while it runs. If `timeout` fires: `npm run e2e:stop`, then prove no listener survives on the lane's ports before re-running. A single spec runs ONLY as `npm run e2e -- <spec path>`, never a bare `npx playwright`.
- Commit discipline: bare `git status` first, `.git/MERGE_HEAD` absent, EXPLICIT paths, never `git add -A`; every commit ends with `Co-Authored-By: <the authoring model> <noreply@anthropic.com>`.
- Never merge to `main`, deploy, run the repair against dev or prod, push secrets, run terraform, or clean up the worktree. Mission records (slice reports, reviews, self-QA, handback) are COMMITTED under `docs/superpowers/reviews/2026-09-27-share-sent-outcome/` as produced.

## Review Focus

Inputs the spec implies but no task's tests exercise by default; each line names the owning task, which adds the test in its own step style.

1. A share slot keyed `phone#<E164>` (no contactId) whose retry delivers: the slot moves (matched by conversationId + retryRoot, never by the key) and the ledger entry lands on the row's `recipient_contact_id`; a row with none writes no entry and logs once. Owner: Task 4 (test "phone-keyed slot") and Task 5.
2. A slot whose ORIGINAL row's rollup was lost (slot stuck `sent`, row `failed`) and whose retry then delivers: the retry's receipt applies as a newer attempt from `sent` and the slot reads `delivered`. Owner: Task 4 (test "from sent").
3. A `broadcast.updated` payload whose `stats` omits `retry_pending` arriving at a list row whose last value is 1 for a share stored `sending`: no refetch, the value is kept (a Sending share needs no count); the same payload for a share stored `sent` triggers exactly one debounced stats refetch. Owner: Task 10.
4. A `listing_sent` milestone written before this branch (no `broadcastId`) for a pair whose ledger row has no `shares` memory reads `Property sent`; the same milestone for a pair whose row is `counted: false` reads `Property text failed`. Owner: Task 12.
5. The repair's census on a share whose original message row is missing (a deleted conversation) reports the slot as unjudgeable and writes nothing to it or its ledger row on `--apply`. Owner: Task 13.

---

## File structure

New files:
- `app/src/lib/shareAttemptOrder.ts` - the attempt order key helpers (import-free leaf): `rowlessAttemptKey`, `LEGACY_ATTEMPT_KEY`, `compareAttemptKeys`, `attemptKeyTimestampMs`.
- `app/src/services/shareRecipientState.ts` - D1: `classifyRecipient`, `mayHaveReached`, `hasReached`, `RETRY_ROW_READ_BOUND_MS`, `resolveRecipientStates`, `priorRecipientKeys`, `retryPendingCount`.
- `app/src/services/shareLedger.ts` - D7: `applyShareLedgerEntry` (the conditional read-modify-write with legacy seeding and the bounded re-read), `ledgerEntryFor` (outcome to entry).
- `app/src/services/shareAttemptOutcome.ts` - D2: `applyLaterAttempt` (the order rule, the lost-condition re-read, the ledger call, the emit) and `originalRowLedgerWrite` (the D7 write for an original row's receipt).
- `app/scripts/repair-share-outcomes.ts` - D8 (census by default, `--apply`).
- `app/test/shareAttemptOrder.test.ts`, `app/test/shareRecipientState.test.ts`, `app/test/shareLedger.test.ts`, `app/test/shareAttemptOutcome.test.ts`, `app/test/broadcastsRepoAttemptOutcome.integration.test.ts`, `app/test/listingSendsRepoShares.integration.test.ts`, `app/test/repairShareOutcomes.test.ts`.
- `e2e/tests/dashboard-next/share-sent-outcome.spec.ts` - section 7's four scenarios.

Modified files (one responsibility each):
- `app/src/repos/broadcastsRepo.ts` - `latestAttempt` on the slot; `applyAttemptOutcome`; `getByIds` (BatchGet); `deriveBroadcastStats(b, opts?)` with `retry_pending`; the cap 1000; `priorRecipientContactIds` removed.
- `app/src/repos/listingSendsRepo.ts` - `shares` memory, `counted`, `getByKeyConsistent`, `putShareMemory`, `getByKeys` (BatchGet); readers filter `counted !== false`.
- `app/src/repos/activityEventsRepo.ts` - `broadcastId?` on the record input and item.
- `app/src/lib/tables.ts` + `README.md` - the sparse note on `byContact`.
- `app/src/routes/webhooks/twilio.ts` - retry rows routed (the `retry_of` skip removed), the original row's ledger write, the promise on the emit; deps.
- `app/src/jobs/sendReconcile.ts` - the adoption hook and the `closeSlot` `retry_send` arm call.
- `app/src/jobs/retrySend.ts` - the two guarded slot-first calls; deps.
- `app/src/jobs/registerHandlers.ts` - wiring for the new deps.
- `app/src/jobs/broadcastFanOut.ts` - `recordPropertySent` writes a ledger ENTRY and a milestone with `broadcastId`; the adoption's ledger call.
- `app/src/routes/broadcasts.ts` - preview via `priorRecipientKeys`; results with per-recipient promise fields, `retry_pending`, `?view=stats`; list with `retry_pending`; deps.
- `app/src/routes/api.ts` - forwards the new deps to the broadcasts, units and contact-timeline routers.
- `app/src/routes/units.ts` - D5 recount on the property Activity projection.
- `app/src/routes/contactTimeline.ts` - D5 landlord label; D6 milestone words.
- `app/test/helpers/twilioWebhookHarness.ts` - doubles for `applyAttemptOutcome`, `getByIds`, the ledger memory, `getByKeys`, `getByKeyConsistent`; the prior-recipients mirror removed.
- `app/src/lib/seed/history.ts` - skips an un-counted ledger row.
- `dashboard/src/api/types.ts`, `endpoints.ts` - `retry_pending?`, per-recipient `retryDueAt?` / `retryOutcome?` / `latestAttempt?`, `getBroadcastStats`.
- `dashboard/src/routes/broadcasts/broadcastFormat.ts`, `StatChips.tsx`, `BroadcastResults.tsx`, `BroadcastsList.tsx`, `useBroadcastResults.ts`, `useBroadcastsList.ts`, `BroadcastStatusPill.tsx` - D3/D4.
- `dashboard/src/routes/listing/listingFormat.ts` - `No tenants reached`.
- `RUNBOOK.md` - the repair section; `docs/issues/*.md` - three closed, the sweeper amended; `e2e/support/selectors.md`.
- Tests beside each of the above, and the pins section 7 lists as rewritten.

## Work map (slices are review checkpoints; the build order is the order stated per slice - it equals the numbering except inside Slice 2)

- **Slice 1 - foundations (no surface changes its words; the one visible change is the cap, 1500 to 1000):** T1 order key + slot pointer + `applyAttemptOutcome` + `deriveBroadcastStats` opts + `getByIds` + cap; T2 D1 state service; T3 D7 ledger memory (repo, doubles, parity, readers filter, sparse note, `recordSend` retired).
- **Slice 2 - writers, built in the order T4, T7, T5, T6:** T4 `applyLaterAttempt` + `applyShareLedgerEntry` composition; T7 `recordPropertySent` (entry + milestone share id) and the adoption - BEFORE the webhook, so no window exists in which the pass writes the old ledger shape beside the webhook's new one; T5 the webhook (retry rows routed, original-row ledger write, emit with promise); T6 the five 1b sites.
- **Slice 3 - readers:** T8 the composer flag; T9 results + list routes (promise fields, `retry_pending`, `?view=stats`); T10 dashboard (types, labels, chips, hint, ticker, hook merges); T11 D5 recount; T12 D6 milestone words.
- **Slice 4 - repair, e2e, close-out:** T13 the D8 script + RUNBOOK; T14 the e2e spec + rewritten pins + `selectors.md`; T15 issues, self-QA, drift report, gates, handback.

Test commands (from the named workspace; DynamoDB Local up via `npm run db:start` at the repo root):
- app, one file: `cd app; npx vitest run test/<file>.test.ts`
- dashboard, one file: `cd dashboard; npx vitest run src/routes/broadcasts/<file>.test.tsx`
- typecheck everything: `npm run typecheck` (repo root; includes `tsc -p tsconfig.test.json`, so test literals must type-check too)

"Run it to verify it fails": most steps are true red-green. Where a test is a REGRESSION PIN already green, the step says so; never report a red state you did not see.

## Shared interfaces (canonical; each task repeats what it consumes)

```ts
// app/src/lib/shareAttemptOrder.ts  (T1) - import-free leaf
export const ROWLESS_ATTEMPT_SUFFIX = '~';
export const LEGACY_ATTEMPT_KEY = '!legacy';        // a seeded ledger entry: before every real attempt
export const INDIVIDUAL_ATTEMPT_KEY = '!individual';
export function rowlessAttemptKey(retriedTsMsgId: string): string;        // `${retriedTsMsgId}~`
export function isRowlessAttemptKey(key: string): boolean;
export function retriedOfRowless(key: string): string;                    // strips the suffix
export function compareAttemptKeys(a: string, b: string): -1 | 0 | 1;      // plain code-unit compare
export function attemptKeyTimestampMs(key: string): number | undefined;   // Date.parse of the ISO before the first '#'; undefined for '!...' keys

// app/src/repos/broadcastsRepo.ts  (T1)
// BroadcastRecipient gains:  latestAttempt?: string;   // the newest attempt's order key; ABSENT while the original is newest
export const MAX_BROADCAST_RECIPIENTS = 1000;
export interface AttemptOutcomeExpect { status: BroadcastRecipient['status']; latestAttempt: string | undefined }
applyAttemptOutcome(broadcastId: string, contactKey: string, expect: AttemptOutcomeExpect,
  next: BroadcastRecipient, statsDelta: Partial<BroadcastStats>): Promise<{ applied: boolean; item?: BroadcastItem }>;
getByIds(broadcastIds: string[], opts?: { projection?: 'stats' }): Promise<Map<string, BroadcastItem>>;  // BatchGet, chunks of 100, unprocessed keys retried once then WARNed and absent; 'stats' projects broadcastId, status, unitId, recipients, stats only
export function deriveBroadcastStats(b: Pick<BroadcastItem, 'recipients' | 'stats'>, opts?: { retryPending?: number; unconfirmedKeys?: ReadonlySet<string> }): BroadcastStats;
// BroadcastStats gains: retry_pending?: number;  // a SUB-bucket of failed; present only when a caller supplied it
// unconfirmedKeys: contactKeys whose D1 state is `unconfirmed` although the slot's code is not send_unconfirmed (the row says the chain ended unresolved): counted in `unconfirmed`, not `failed`. With no opts the function returns b.stats ITSELF for an empty map (the identity pin).

// app/src/services/shareRecipientState.ts  (T2)
export type RecipientState = 'reached' | 'pending' | 'unconfirmed' | 'in_flight' | 'stranded' | 'failed' | 'skipped';
export const RETRY_ROW_READ_BOUND_MS: number;   // RETRY_SEND_WINDOW_MS + RECONCILE_CHECK_DELAYS_MS[2] + 2 * RETRY_PROMISE_GRACE_MS + 60_000 (24 min)
export const RECORD_READ_BOUND_MS: number;      // SEND_ATTEMPT_CLEANUP_MS (30 d)
export interface RecipientFacts {
  row?: { retryDueAt?: string; retryOutcome?: string } | 'unreadable';
  record?: SendAttemptRecord | null | 'unreadable' | 'expired';  // absent = not asked (in_flight); null = read, absent (stranded); 'expired' = past the 30-day life, not read (stranded)
}
export interface ClassifiedRecipient { state: RecipientState; retryDueAt?: string; retryOutcome?: string; latestAttempt?: string }
export function classifyRecipient(share: Pick<BroadcastItem, 'status' | 'created_at'>, slot: BroadcastRecipient, facts: RecipientFacts, nowMs: number): RecipientState;
export function mayHaveReached(state: RecipientState): boolean;   // SAFE: reached | pending | unconfirmed | in_flight
export function hasReached(state: RecipientState): boolean;       // STRICT: reached
export function needsRowRead(slot: BroadcastRecipient, nowMs: number): boolean;
export function needsRecordRead(share: Pick<BroadcastItem, 'status' | 'created_at'>, slot: BroadcastRecipient, nowMs: number): boolean;
export interface RecipientStateDeps {
  messages: Pick<MessagesRepo, 'getByTsMsgIdConsistent'>;
  attempts: Pick<SendAttemptsRepo, 'get'>;
  now?: () => number; log: Logger;
}
export async function resolveRecipientStates(deps: RecipientStateDeps, share: BroadcastItem, opts?: { recordReads?: boolean }): Promise<Map<string, ClassifiedRecipient>>;  // keyed by contactKey; recordReads defaults FALSE (a queued slot of a finished share then reads `in_flight`, the safe side); reads run 8 at a time
export function retryPendingCount(states: Map<string, ClassifiedRecipient>): number;
export function unconfirmedByRow(states: Map<string, ClassifiedRecipient>, share: BroadcastItem): Set<string>;  // keys whose state is unconfirmed while the slot's code is not send_unconfirmed
export function reachedCount(share: Pick<BroadcastItem, 'recipients' | 'stats'>): number;  // delivered + sent + sending, no reads
export async function priorRecipientKeys(deps: RecipientStateDeps & { broadcasts: Pick<BroadcastsRepo, 'listByUnit'> }, unitId: string): Promise<Set<string>>;  // SAFE reading, every share of the unit; never throws (WARN + what it has)

// app/src/repos/listingSendsRepo.ts  (T3)
export type ShareLedgerState = 'counted' | 'pending' | 'unconfirmed' | 'failed';
export interface ShareLedgerEntry { attempt: string; conversationId?: string; state: ShareLedgerState; by?: 'acceptance' | 'delivery'; countedAt?: string /* the ATTEMPT's provider instant */ }
// ListingSendItem: sentAt becomes OPTIONAL (removed while nothing counts); gains  counted?: boolean;  shares?: Record<string /* broadcastId | 'individual' */, ShareLedgerEntry>;  shares_op?: string (the change token)
export interface ShareMemoryWrite { shares: Record<string, ShareLedgerEntry>; counted: boolean; sentAt: string | undefined; broadcastId: string | undefined }
getByKeyConsistent(unitId: string, contactId: string): Promise<ListingSendItem | undefined>;
putShareMemory(unitId: string, contactId: string, next: ShareMemoryWrite, expect: { token: string | undefined }): Promise<boolean>;  // false = condition failed; token undefined = attribute_not_exists(shares_op) (absent OR seeded row)
getByKeys(pairs: Array<{ unitId: string; contactId: string }>): Promise<Map<string, ListingSendItem>>;  // key `${unitId}|${contactId}`
// listByUnit / listByContact: rows with counted === false are FILTERED OUT; recordSend is REMOVED

// app/src/services/shareLedger.ts  (T3)
export type ShareLedgerOutcome = { kind: 'accepted' } | { kind: 'delivered' } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'unconfirmed' };
export function ledgerEntryFor(attempt: string, conversationId: string | undefined, outcome: ShareLedgerOutcome): ShareLedgerEntry;  // countedAt = attemptKeyTimestampMs(attempt) as ISO for a counted entry
export interface ShareLedgerDeps { listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>; log: Logger }
export async function applyShareLedgerEntry(deps: ShareLedgerDeps, args: { unitId: string; contactId: string; broadcastId: string; entry: ShareLedgerEntry }): Promise<'written' | 'refused' | 'lost'>;
export function ledgerEntryForSlot(slot: BroadcastRecipient, conversationId: string, promiseLive: boolean): ShareLedgerEntry | undefined;  // the entry a slot's OWN state implies (T13's ledger rebuild): delivered -> delivered; sent -> accepted; failed 30003 + live promise -> pending; failed send_unconfirmed -> unconfirmed; failed -> failed; queued/skipped -> undefined; attempt = slot.latestAttempt ?? slot.tsMsgId

// app/src/services/shareAttemptOutcome.ts  (T4)
export type AttemptOutcome =
  | { kind: 'sent'; carrierSentAt?: string }        // carrier-confirmed when carrierSentAt is present; a bare accept otherwise
  | { kind: 'delivered'; carrierSentAt?: string }
  | { kind: 'failed'; errorCode: string; retryDueAt?: string }
  | { kind: 'unresolved' };
export interface LaterAttempt { broadcastId: string; conversationId: string; retryRoot: string; attemptKey: string; outcome: AttemptOutcome; recipientContactId?: string }
// The pair's contact for the ledger: the slot key when it is a contact id; else recipientContactId (the send-time holder); else none (INFO, no entry).
export interface ShareAttemptOutcomeDeps {
  broadcasts: Pick<BroadcastsRepo, 'getByIdConsistent' | 'applyAttemptOutcome'>;
  ledger: ShareLedgerDeps; events: EventBus; log: Logger; now?: () => number;
}
export type ApplyResult = 'applied' | 'refused' | 'no_slot' | 'no_broadcast' | 'lost';
export async function applyLaterAttempt(deps: ShareAttemptOutcomeDeps, input: LaterAttempt): Promise<ApplyResult>;
export function wouldApply(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): boolean;   // the D2 order rule alone, no reads (T13's census)
export async function originalRowLedgerWrite(deps: Pick<ShareAttemptOutcomeDeps, 'ledger' | 'log' | 'now'>, args: { share: BroadcastItem; contactKey: string; row: Pick<MessageItem, 'tsMsgId' | 'conversationId' | 'recipient_contact_id'>; outcome: AttemptOutcome }): Promise<void>;

// app/src/repos/activityEventsRepo.ts  (T7)
// RecordActivityEventInput gains: broadcastId?: string;   ActivityEventItem gains: broadcastId?: string
```


---

### Task 1: The attempt order key, the slot pointer, `applyAttemptOutcome`, `retry_pending`, `getByIds`, the cap

**Files:**
- Create: `app/src/lib/shareAttemptOrder.ts`
- Modify: `app/src/repos/broadcastsRepo.ts` (`BroadcastRecipient` :136-166, `BroadcastStats` :86-133, `MAX_BROADCAST_RECIPIENTS` :68 and the budget comment :56-67, `deriveBroadcastStats` :270-325, the interface :364-507, `recordOutcome` :537-579 as the precedent)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the broadcasts double from :3139: mirror `applyAttemptOutcome` and `getByIds`)
- Test: `app/test/shareAttemptOrder.test.ts`, `app/test/broadcastsRepoAttemptOutcome.integration.test.ts`, `app/test/deriveBroadcastStats.test.ts` (extend), `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (parity cases beside :735-814)

**Interfaces:**
- Consumes: `BroadcastRecipient`, `BroadcastStats`, `BroadcastItem`, `recordOutcome`'s expression style, `SEND_UNCONFIRMED_CODE` (`app/src/lib/sendOutcome.ts:14`).
- Produces: everything in the shared-interfaces block under T1. `applyAttemptOutcome`'s condition: `attribute_exists(broadcastId) AND recipients.#ck.#status = :ps AND (recipients.#ck.#la = :pa | attribute_not_exists(recipients.#ck.#la))` with `#la` = `latestAttempt`; the write SETs the whole slot (`recipients.#ck = :rec`), stamps `updated_at`, ADDs the stats delta, returns ALL_NEW. `ConditionalCheckFailedException` -> `{ applied: false }`; anything else throws.

- [ ] **Step 1: Write the failing leaf tests**

`app/test/shareAttemptOrder.test.ts`:

```ts
// The attempt order key (spec D2): attempts order by the message id, which is
// `<provider ISO>#<SID>` (messagesRepo.buildTsMsgId); a row-less attempt (the
// reconcile's unresolved close of a retry never appended) sorts right after the
// row it retried; a seeded legacy ledger entry sorts before every real attempt.
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys, isRowlessAttemptKey,
  retriedOfRowless, rowlessAttemptKey,
} from '../src/lib/shareAttemptOrder.js';

const ROOT = '2026-09-28T10:00:00.000Z#SM00000000000000000000000000000001';
const RETRY = '2026-09-28T10:01:00.000Z#SM00000000000000000000000000000002';

describe('shareAttemptOrder', () => {
  it('a later provider timestamp is the newer attempt', () => {
    expect(compareAttemptKeys(RETRY, ROOT)).toBe(1);
    expect(compareAttemptKeys(ROOT, RETRY)).toBe(-1);
    expect(compareAttemptKeys(ROOT, ROOT)).toBe(0);
  });
  it('a row-less attempt sorts after the row it retried and before any later row', () => {
    const marker = rowlessAttemptKey(ROOT);
    expect(isRowlessAttemptKey(marker)).toBe(true);
    expect(retriedOfRowless(marker)).toBe(ROOT);
    expect(compareAttemptKeys(marker, ROOT)).toBe(1);
    expect(compareAttemptKeys(RETRY, marker)).toBe(1);
  });
  it('a same-second SID that sorts lower still loses to the marker (the suffix outranks any SID character)', () => {
    const sameSecondLowerSid = '2026-09-28T10:00:00.000Z#SM00000000000000000000000000000000';
    expect(compareAttemptKeys(rowlessAttemptKey(ROOT), sameSecondLowerSid)).toBe(1);
  });
  it('the legacy key sorts before every real attempt and has no timestamp', () => {
    expect(compareAttemptKeys(LEGACY_ATTEMPT_KEY, ROOT)).toBe(-1);
    expect(attemptKeyTimestampMs(LEGACY_ATTEMPT_KEY)).toBeUndefined();
  });
  it('attemptKeyTimestampMs reads the ISO prefix of a real key and of a row-less marker', () => {
    expect(attemptKeyTimestampMs(ROOT)).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
    expect(attemptKeyTimestampMs(rowlessAttemptKey(ROOT))).toBe(Date.parse('2026-09-28T10:00:00.000Z'));
    expect(attemptKeyTimestampMs('garbage')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/shareAttemptOrder.test.ts`
Expected: FAIL - cannot resolve `../src/lib/shareAttemptOrder.js`.

- [ ] **Step 3: Write the leaf**

`app/src/lib/shareAttemptOrder.ts`:

```ts
/**
 * share-sent-outcome D2: the ORDER of a recipient's attempts. An attempt's
 * key is its message id (`<provider ISO>#<SID>`, messagesRepo.buildTsMsgId),
 * so plain string order is provider-time order. Two synthetic keys exist:
 * a ROW-LESS attempt (the reconcile closed a retry `unresolved` before any
 * row was appended) is `<retried row's key>~` - `~` (0x7E) sorts after `#`
 * and every SID character, so the marker is newer than the row it retried
 * and older than any row with a later timestamp; a SEEDED legacy ledger
 * entry is `!legacy` (`!` sorts before any year digit). Import-free leaf.
 */
export const ROWLESS_ATTEMPT_SUFFIX = '~';
export const LEGACY_ATTEMPT_KEY = '!legacy';
export const INDIVIDUAL_ATTEMPT_KEY = '!individual';

export function rowlessAttemptKey(retriedTsMsgId: string): string {
  return `${retriedTsMsgId}${ROWLESS_ATTEMPT_SUFFIX}`;
}

export function isRowlessAttemptKey(key: string): boolean {
  return key.endsWith(ROWLESS_ATTEMPT_SUFFIX);
}

export function retriedOfRowless(key: string): string {
  return isRowlessAttemptKey(key) ? key.slice(0, -ROWLESS_ATTEMPT_SUFFIX.length) : key;
}

export function compareAttemptKeys(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The provider instant a key carries (the ISO before the first `#`); undefined for a synthetic `!` key or garbage. */
export function attemptKeyTimestampMs(key: string): number | undefined {
  if (key.startsWith('!')) return undefined;
  const hash = key.indexOf('#');
  if (hash <= 0) return undefined;
  const ms = Date.parse(key.slice(0, hash));
  return Number.isFinite(ms) ? ms : undefined;
}
```

- [ ] **Step 4: Run the leaf tests**

Run: `cd app; npx vitest run test/shareAttemptOrder.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing repo integration test**

`app/test/broadcastsRepoAttemptOutcome.integration.test.ts` (per-file DynamoDB Local database; copy the table setup of `app/test/broadcastsRepo.integration.test.ts:1-70` - it builds the repo with `createBroadcastsRepo` over the file's `doc`/`env`; the sketch's `putShare(item)` is a file-local helper: one `PutCommand` of `{ ...baseShare, ...item }` on `tableName('broadcasts', env)`, where `baseShare` carries the required `created_by`, `audience_filter`, `body_template`, `created_at`):

```ts
// spec D2 / I3 / I4: the ONE slot write that may leave `failed` - conditioned
// on the recorded attempt AND the status, carrying its stats delta.
import { describe, expect, it } from 'vitest';
import { zeroStats } from '../src/repos/broadcastsRepo.js';

const ROOT = '2026-09-28T10:00:00.000Z#SM1';
const RETRY = '2026-09-28T10:01:00.000Z#SM2';
const stats1 = { ...zeroStats(), audience: 1 };

describe('applyAttemptOutcome', () => {
  it('applies when the slot records no attempt (the original) and the status matches, and ADDs the delta in the same write', async () => {
    await putShare({ broadcastId: 'b1', status: 'sent', recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT } },
      stats: { ...stats1, failed: 1 } });
    const res = await repo.applyAttemptOutcome('b1', 'c1', { status: 'failed', latestAttempt: undefined },
      { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, delivered: 1 });
    expect(res.applied).toBe(true);
    expect(res.item?.recipients?.['c1']).toMatchObject({ status: 'delivered', latestAttempt: RETRY });
    expect(res.item?.stats).toMatchObject({ failed: 0, delivered: 1 });
  });
  it('refuses when the recorded attempt moved (another writer won) - no stats change', async () => {
    await putShare({ broadcastId: 'b2', status: 'sent', recipients: { c1: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY } },
      stats: { ...stats1, failed: 1 } });
    const res = await repo.applyAttemptOutcome('b2', 'c1', { status: 'failed', latestAttempt: undefined },
      { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, delivered: 1 });
    expect(res.applied).toBe(false);
    expect((await repo.getByIdConsistent('b2'))?.stats.failed).toBe(1);
  });
  it('refuses when the status moved under it', async () => {
    await putShare({ broadcastId: 'b3', status: 'sent', recipients: { c1: { status: 'delivered', conversationId: 'conv-1', tsMsgId: ROOT } }, stats: { ...stats1, delivered: 1 } });
    const res = await repo.applyAttemptOutcome('b3', 'c1', { status: 'sent', latestAttempt: undefined },
      { status: 'failed', errorCode: '30007', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { sent: -1, failed: 1 });
    expect(res.applied).toBe(false);
  });
  it('a missing broadcast is refused, never thrown', async () => {
    const res = await repo.applyAttemptOutcome('nope', 'c1', { status: 'failed', latestAttempt: undefined },
      { status: 'sent', latestAttempt: RETRY }, { failed: -1, sent: 1 });
    expect(res.applied).toBe(false);
  });
});

describe('getByIds', () => {
  it('returns the found items keyed by id and omits the missing ones', async () => {
    await putShare({ broadcastId: 'g1', status: 'sent', recipients: {}, stats: zeroStats() });
    const m = await repo.getByIds(['g1', 'missing']);
    expect([...m.keys()]).toEqual(['g1']);
  });
  it('the stats projection carries recipients, stats, status and unitId but not the template', async () => {
    const m = await repo.getByIds(['g1'], { projection: 'stats' });
    expect(m.get('g1')).toMatchObject({ broadcastId: 'g1', status: 'sent' });
    expect(m.get('g1')?.body_template).toBeUndefined();
  });
  it('an empty list reads nothing', async () => {
    expect((await repo.getByIds([])).size).toBe(0);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd app; npx vitest run test/broadcastsRepoAttemptOutcome.integration.test.ts`
Expected: FAIL - `repo.applyAttemptOutcome is not a function` (the literal's typecheck fails first; that is the red).

- [ ] **Step 7: Add the slot pointer, the primitive, `getByIds`, the stats opt-in and the cap**

In `app/src/repos/broadcastsRepo.ts`:

```ts
// BroadcastRecipient (:136-166) gains, after carrierSentAt:
  /**
   * share-sent-outcome D1/D2: the order key of the NEWEST attempt for this
   * recipient (a retry row's tsMsgId, or the row-less marker
   * shareAttemptOrder.rowlessAttemptKey). ABSENT while the original send
   * (`tsMsgId`) is the newest attempt. The promise and the chain's end are
   * NEVER copied here - they are read from that attempt's own row (I5).
   */
  latestAttempt?: string;

// BroadcastStats (:86-133) gains, after `sending?`:
  /**
   * share-sent-outcome D4: how many `failed` slots hold a LIVE retry promise
   * (a SUB-bucket of `failed`: never in the bucket sum, never persisted). Set
   * only by a caller that supplied a promise count (the results and list
   * routes; the rollup's own lower bound on its emit); ABSENT otherwise, and
   * the dashboard merges an absent count by keeping its last value.
   */
  retry_pending?: number;

// :68
export const MAX_BROADCAST_RECIPIENTS = 1000;
// the budget comment :56-67 is rewritten: six attributes per slot (status,
// conversationId, tsMsgId, errorCode, carrierSentAt, latestAttempt), about
// 230 B each, up to about 305 KB at 1000 slots when every recipient was
// retried - under the 400 KB item limit with room for the item's own fields.

// deriveBroadcastStats (:270-325) signature and return:
export function deriveBroadcastStats(
  b: Pick<BroadcastItem, 'recipients' | 'stats'>,
  opts?: { retryPending?: number; unconfirmedKeys?: ReadonlySet<string> },
): BroadcastStats {
  const recipients = b.recipients ?? {};
  const keys = Object.keys(recipients);
  if (keys.length === 0) return opts?.retryPending === undefined ? b.stats : { ...b.stats, retry_pending: opts.retryPending };  // the identity pin (deriveBroadcastStats.test.ts:26) holds without opts
  // ...the counting loop, with ONE change in the `failed` arm:
  //   if (slot.errorCode === SEND_UNCONFIRMED_CODE || opts?.unconfirmedKeys?.has(key)) unconfirmed += 1; else failed += 1;
  return {
    audience: keys.length, queued, sending, sent, delivered, failed, unconfirmed,
    skipped_opted_out, skipped_no_consent, skipped_other,
    ...(opts?.retryPending !== undefined && { retry_pending: opts.retryPending }),
  };
}

// interface additions (beside recordRecipientOutcome :462-468):
  /**
   * share-sent-outcome D2: the attempt-ordered slot write. Applies `next`
   * (the whole slot) and ADDs `statsDelta` in ONE conditional write whose
   * condition names the attempt the slot currently records (`latestAttempt`,
   * absent for the original) AND its status - so a newer attempt can leave
   * `failed`, a delayed callback for a superseded attempt cannot, and two
   * writers racing on one slot cannot both win. `{ applied: false }` on a
   * failed condition (the caller re-reads and re-decides, spec D2), a missing
   * broadcast included; anything else throws.
   */
  applyAttemptOutcome(
    broadcastId: string, contactKey: string, expect: AttemptOutcomeExpect,
    next: BroadcastRecipient, statsDelta: Partial<BroadcastStats>,
  ): Promise<{ applied: boolean; item?: BroadcastItem }>;
  /**
   * share-sent-outcome D5: BatchGet by id (chunks of 100; unprocessed keys are
   * retried once, then WARNed with their ids and left absent). `projection:
   * 'stats'` reads broadcastId, status, unitId, recipients, stats only (a
   * share item can run to 300 KB; a page of them must stay under BatchGet's
   * 16 MB response). Missing ids are absent.
   */
  getByIds(broadcastIds: string[], opts?: { projection?: 'stats' }): Promise<Map<string, BroadcastItem>>;

export interface AttemptOutcomeExpect { status: BroadcastRecipient['status']; latestAttempt: string | undefined }

// implementation (beside recordOutcome):
    async applyAttemptOutcome(broadcastId, contactKey, expect, next, statsDelta) {
      const names: Record<string, string> = { '#ck': contactKey, '#updatedAt': 'updated_at', '#status': 'status', '#la': 'latestAttempt' };
      const values: Record<string, unknown> = { ':rec': next, ':now': new Date().toISOString(), ':ps': expect.status };
      let attemptCond = 'attribute_not_exists(recipients.#ck.#la)';
      if (expect.latestAttempt !== undefined) {
        values[':pa'] = expect.latestAttempt;
        attemptCond = 'recipients.#ck.#la = :pa';
      }
      const adds: string[] = [];
      for (const [bucket, delta] of Object.entries(statsDelta)) {
        if (typeof delta !== 'number' || delta === 0) continue;
        const i = adds.length;
        names[`#a${i}`] = bucket;
        values[`:v${i}`] = delta;
        adds.push(`stats.#a${i} :v${i}`);
      }
      try {
        const { Attributes } = await doc.send(new UpdateCommand({
          TableName: table, Key: { broadcastId },
          UpdateExpression: `SET recipients.#ck = :rec, #updatedAt = :now` + (adds.length > 0 ? ` ADD ${adds.join(', ')}` : ''),
          ConditionExpression: `attribute_exists(broadcastId) AND recipients.#ck.#status = :ps AND ${attemptCond}`,
          ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW',
        }));
        return { applied: true, item: Attributes as BroadcastItem };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { applied: false };
        throw err;
      }
    },

    async getByIds(broadcastIds, opts) {
      const out = new Map<string, BroadcastItem>();
      const ids = [...new Set(broadcastIds)];
      const projection = opts?.projection === 'stats'
        ? { ProjectionExpression: 'broadcastId, #s, unitId, recipients, stats', ExpressionAttributeNames: { '#s': 'status' } }
        : {};
      for (let i = 0; i < ids.length; i += 100) {
        let keys = ids.slice(i, i + 100).map((broadcastId) => ({ broadcastId }));
        for (let round = 0; round < 2 && keys.length > 0; round += 1) {
          const res = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ...projection } } }));
          for (const item of (res.Responses?.[table] ?? []) as BroadcastItem[]) out.set(item.broadcastId, item);
          keys = (res.UnprocessedKeys?.[table]?.Keys ?? []) as Array<{ broadcastId: string }>;
        }
        if (keys.length > 0) log.warn({ count: keys.length, broadcastIds: keys.map((k) => k.broadcastId) }, 'broadcasts getByIds: keys still unprocessed after one retry - left absent');
      }
      return out;
    },
```

Import `BatchGetCommand` from `@aws-sdk/lib-dynamodb` beside the file's other commands (the precedent is `contactsRepo.ts:8`, `:871`).

- [ ] **Step 8: Mirror both in the harness double**

In `app/test/helpers/twilioWebhookHarness.ts`, the broadcasts double (from :3139; beside its `recordRecipientOutcome` mirror :3175-3330): `applyAttemptOutcome` checks the stored slot's `status === expect.status` and `latestAttempt === expect.latestAttempt` (both undefined counts as equal), refuses otherwise or when the broadcast is missing, else replaces the slot, bumps `stats` by the delta and returns a copy; `getByIds` returns the found items. Add a parity case to `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (beside :735-814) running the FOUR `applyAttemptOutcome` cases of Step 5 through the double and the real repo with the same expectations (the file's pattern: one table, both implementations).

- [ ] **Step 9: Extend the stats test**

In `app/test/deriveBroadcastStats.test.ts` (sum invariant at :118) add:

```ts
  it('retry_pending is absent unless supplied, and never joins the bucket sum', () => {
    const b = { recipients: { c1: { status: 'failed' as const, errorCode: '30003' } }, stats: { ...zeroStats(), audience: 1 } };
    expect(deriveBroadcastStats(b).retry_pending).toBeUndefined();
    const withPending = deriveBroadcastStats(b, { retryPending: 1 });
    expect(withPending.retry_pending).toBe(1);
    expect(withPending.failed).toBe(1); // the sub-bucket does not shrink failed
  });
  it('an unconfirmedKeys entry moves a failed slot into unconfirmed (the row said its chain ended unresolved)', () => {
    const b = { recipients: { c1: { status: 'failed' as const, errorCode: '30003' } }, stats: { ...zeroStats(), audience: 1 } };
    expect(deriveBroadcastStats(b, { unconfirmedKeys: new Set(['c1']) })).toMatchObject({ failed: 0, unconfirmed: 1 });
  });
  it('the empty-map passthrough returns the persisted object itself when no option is supplied (the :26 pin), and a copy with retry_pending when one is', () => {
    const persisted = zeroStats();
    expect(deriveBroadcastStats({ recipients: {}, stats: persisted })).toBe(persisted);
    expect(deriveBroadcastStats({ recipients: {}, stats: persisted }, { retryPending: 0 })).toEqual({ ...persisted, retry_pending: 0 });
  });
```

- [ ] **Step 10: Run the files and typecheck**

Run: `cd app; npx vitest run test/shareAttemptOrder.test.ts test/broadcastsRepoAttemptOutcome.integration.test.ts test/deriveBroadcastStats.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/broadcastApi.test.ts`
Expected: PASS. `broadcastApi.test.ts:561` and `:985` pin the cap by the constant and stay green at 1000. Then `npm run typecheck` from the root: exit 0.

- [ ] **Step 11: Commit**

```bash
git status
git add app/src/lib/shareAttemptOrder.ts app/src/repos/broadcastsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/shareAttemptOrder.test.ts app/test/broadcastsRepoAttemptOutcome.integration.test.ts app/test/deriveBroadcastStats.test.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts
git commit -m "feat(broadcasts): the attempt order key, the slot's latestAttempt pointer, applyAttemptOutcome (one attempt-ordered conditional write with its stats delta), getByIds, retry_pending opt-in, cap 1000 (share-sent-outcome T1)"
```

---

### Task 2: The recipient state (D1) - classification, the two readings, the bounded reads, the prior-recipients rule

**Files:**
- Create: `app/src/services/shareRecipientState.ts`
- Test: `app/test/shareRecipientState.test.ts`

**Interfaces:**
- Consumes: `BroadcastRecipient`, `BroadcastItem`, `BroadcastsRepo.listByUnit` (`broadcastsRepo.ts:388`, paged via `ListBroadcastsOpts.exclusiveStartKey`), `MessagesRepo.getByTsMsgIdConsistent` (`messagesRepo.ts:1526`), `SendAttemptsRepo.get` + `SendAttemptRecord` (`sendAttemptsRepo.ts:90-100`, `:360-363`), `SEND_ATTEMPT_CLEANUP_MS` (`:48`), `RETRY_SEND_WINDOW_MS`, `RETRY_PROMISE_GRACE_MS`, `RETRY_OUTCOME_UNCONFIRMED`, `isRetryPromiseLive` (`app/src/lib/retrySendWindow.ts:15`, `:29`, `:37`, `:99`), `RECONCILE_CHECK_DELAYS_MS` (`app/src/lib/sendOutcome.ts:30`), `SEND_UNCONFIRMED_CODE` (`:14`), `attemptKeyTimestampMs`, `isRowlessAttemptKey`, `retriedOfRowless` (Task 1).
- Produces: the T2 block of the shared interfaces. State rules, verbatim from spec D1:
  - `skipped` -> `skipped`; `delivered` -> `reached`; `sent` -> `reached` (confirmed or not);
  - `queued`: share `sending` -> `in_flight`; else the record fact: NOT ASKED (`facts.record === undefined` - the routes never read records) -> `in_flight` (the safe side); `'expired'` (the caller asked, but the share is past the 30-day record life so nothing was read) -> `stranded` (spec D1: "reads stranded without a read"); read and absent (`null`) or `done` with `refused` | `rejected` | `enqueue_failed` | `redrive_refused` -> `stranded`; any other shape -> `in_flight`; a record read that failed (`'unreadable'`) -> `in_flight` (safe);
  - `failed` with `errorCode === SEND_UNCONFIRMED_CODE` -> `unconfirmed`;
  - `failed` with `errorCode === '30003'` and a row fact: `retryOutcome === 'unconfirmed'` -> `unconfirmed`; else `isRetryPromiseLive(retryDueAt, nowMs)` -> `pending`; else `failed`; a row read that failed (`'unreadable'`) -> `pending` (safe); no row fact supplied (outside the bound) -> `failed`;
  - any other `failed` -> `failed`.
  - `needsRowRead`: status `failed`, errorCode `30003`, and `attemptKeyTimestampMs(slot.latestAttempt ?? slot.tsMsgId)` within `RETRY_ROW_READ_BOUND_MS` of `nowMs` (a slot with no timestamp reads nothing). The row read is on `retriedOfRowless(key)` (a row-less marker reads the RETRIED row, which carries the outcome).
  - `needsRecordRead`: status `queued`, share not `sending`, and `Date.parse(share.created_at)` within `RECORD_READ_BOUND_MS`; the record is the BROADCAST owner's: `{ kind: 'broadcast', broadcastId, contactKey }`.
  - `retryPendingCount` = the number of `pending` states. `unconfirmedByRow(states, share)` = the keys whose state is `unconfirmed` while the slot's `errorCode !== SEND_UNCONFIRMED_CODE` (the row said unresolved; the slot never learned it). `reachedCount(share)` = `delivered + sent + (sending ?? 0)` of `deriveBroadcastStats(share)` (no reads). `priorRecipientKeys` = the union of contactKeys whose state satisfies `mayHaveReached`, over every page of `listByUnit(unitId)` (every stored status), resolved WITH record reads; a `listByUnit` failure logs WARN and returns what it has.
  - `resolveRecipientStates(deps, share, opts)`: record reads run ONLY with `opts.recordReads === true` (the composer flag); with them, a queued slot of a finished share older than `RECORD_READ_BOUND_MS` gets `facts.record = 'expired'` (no read) and a younger one is read; without them `facts.record` stays absent and the slot reads `in_flight` (the safe side). Reads run with bounded concurrency (8 at a time) through a small `mapLimit` helper in the same file; each read's failure is caught per slot.

- [ ] **Step 1: Write the failing tests**

`app/test/shareRecipientState.test.ts` (pure functions with fakes; no DynamoDB):

```ts
// spec D1: one per-recipient state, two readings. Every row of the state
// table, both read bounds, and the safe direction on a failed read.
import { describe, expect, it } from 'vitest';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { RETRY_PROMISE_WITHDRAWN_AT } from '../src/lib/retrySendWindow.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import {
  RECORD_READ_BOUND_MS, RETRY_ROW_READ_BOUND_MS, classifyRecipient, hasReached, mayHaveReached,
  needsRecordRead, needsRowRead, priorRecipientKeys, reachedCount, resolveRecipientStates, retryPendingCount, unconfirmedByRow,
} from '../src/services/shareRecipientState.js';
import { createLogger } from '../src/lib/logger.js';            // read the real path of the app's pino factory (broadcastFanOut.test.ts:181 imports it)
import { createLogCapture } from './helpers/logCapture.js';   // { stream, lines, atLevel }
const captured = () => { const capture = createLogCapture(); return { capture, log: createLogger({ level: 'info', destination: capture.stream }) }; };

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ROOT = '2026-09-28T11:50:00.000Z#SM1'; // 10 min old
const share = (status: BroadcastItem['status'], createdAt = '2026-09-28T11:49:00.000Z') => ({ status, created_at: createdAt });
const slot = (s: Partial<BroadcastRecipient> & { status: BroadcastRecipient['status'] }): BroadcastRecipient => ({ conversationId: 'conv-1', tsMsgId: ROOT, ...s });

describe('classifyRecipient - the state table', () => {
  it('skipped -> skipped; delivered / sent (confirmed or not) -> reached', () => {
    expect(classifyRecipient(share('sent'), slot({ status: 'skipped', errorCode: 'opted_out' }), {}, NOW)).toBe('skipped');
    expect(classifyRecipient(share('sent'), slot({ status: 'delivered' }), {}, NOW)).toBe('reached');
    expect(classifyRecipient(share('sent'), slot({ status: 'sent' }), {}, NOW)).toBe('reached');
    expect(classifyRecipient(share('sent'), slot({ status: 'sent', carrierSentAt: '2026-09-28T11:50:01.000Z' }), {}, NOW)).toBe('reached');
  });
  it('queued in a sending share is in flight, whatever the record says', () => {
    expect(classifyRecipient(share('sending'), slot({ status: 'queued' }), {}, NOW)).toBe('in_flight');
  });
  it('queued in a finished share: a record NOT ASKED is in flight (safe); expired (past the 30-day life) is stranded; read-and-absent or a never-went record is stranded; any other record is in flight; an unreadable record is in flight', () => {
    const q = slot({ status: 'queued' });
    expect(classifyRecipient(share('failed'), q, {}, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: 'expired' }, NOW)).toBe('stranded');
    expect(classifyRecipient(share('failed'), q, { record: null }, NOW)).toBe('stranded');
    for (const outcome of ['refused', 'rejected', 'enqueue_failed', 'redrive_refused'] as const) {
      expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome } as never }, NOW)).toBe('stranded');
    }
    expect(classifyRecipient(share('failed'), q, { record: { state: 'attempting' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome: 'unresolved' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: { state: 'done', outcome: 'retryable' } as never }, NOW)).toBe('in_flight');
    expect(classifyRecipient(share('failed'), q, { record: 'unreadable' }, NOW)).toBe('in_flight');
  });
  it('failed send_unconfirmed is unconfirmed; failed with a live promise is pending; withdrawn, lapsed or absent is failed; an unresolved outcome is unconfirmed', () => {
    const f = slot({ status: 'failed', errorCode: '30003' });
    expect(classifyRecipient(share('sent'), slot({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }), {}, NOW)).toBe('unconfirmed');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: '2026-09-28T12:05:00.000Z' } }, NOW)).toBe('pending');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: '2026-09-28T11:57:00.000Z' } }, NOW)).toBe('failed'); // lapsed: due + 2 min < now
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT } }, NOW)).toBe('failed');
    expect(classifyRecipient(share('sent'), f, { row: {} }, NOW)).toBe('failed');
    expect(classifyRecipient(share('sent'), f, { row: { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: 'unconfirmed' } }, NOW)).toBe('unconfirmed');
    expect(classifyRecipient(share('sent'), f, { row: 'unreadable' }, NOW)).toBe('pending');
    expect(classifyRecipient(share('sent'), f, {}, NOW)).toBe('failed'); // outside the bound: no fact, the slot is authoritative
  });
  it('a failed slot with any other code is failed without a read', () => {
    expect(classifyRecipient(share('sent'), slot({ status: 'failed', errorCode: '30007' }), {}, NOW)).toBe('failed');
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30007' }), NOW)).toBe(false);
  });
});

describe('the two readings', () => {
  it('SAFE counts reached, pending, unconfirmed, in_flight; STRICT counts reached only', () => {
    expect(['reached', 'pending', 'unconfirmed', 'in_flight'].every((s) => mayHaveReached(s as never))).toBe(true);
    expect(['failed', 'skipped', 'stranded'].some((s) => mayHaveReached(s as never))).toBe(false);
    expect(hasReached('reached')).toBe(true);
    expect(['pending', 'unconfirmed', 'in_flight', 'failed', 'skipped', 'stranded'].some((s) => hasReached(s as never))).toBe(false);
  });
});

describe('the read bounds', () => {
  it('RETRY_ROW_READ_BOUND_MS is the constants sum: 15 + 4 + 2 + 2 + 1 minutes', () => {
    expect(RETRY_ROW_READ_BOUND_MS).toBe(24 * 60_000);
    expect(RECORD_READ_BOUND_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });
  it('needsRowRead: a young failed-30003 slot reads; an old one does not; the newest attempt key decides the age', () => {
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003' }), NOW)).toBe(true);
    const old = '2026-09-28T11:30:00.000Z#SM0'; // 30 min old
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', tsMsgId: old }), NOW)).toBe(false);
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', tsMsgId: old, latestAttempt: ROOT }), NOW)).toBe(true);
    expect(needsRowRead(slot({ status: 'failed', errorCode: '30003', latestAttempt: rowlessAttemptKey(ROOT) }), NOW)).toBe(true);
  });
  it('needsRecordRead: queued in a finished share younger than 30 days reads; a sending share or an old share does not', () => {
    expect(needsRecordRead(share('failed'), slot({ status: 'queued' }), NOW)).toBe(true);
    expect(needsRecordRead(share('sending'), slot({ status: 'queued' }), NOW)).toBe(false);
    expect(needsRecordRead(share('failed', '2026-08-01T00:00:00.000Z'), slot({ status: 'queued' }), NOW)).toBe(false);
  });
  it('with recordReads, a queued slot of a finished share past the 30-day life reads stranded WITHOUT a read; without recordReads it reads in flight', async () => {
    const { deps: d } = deps();
    const old = item('failed', { c3: slot({ status: 'queued' }) });
    (old as { created_at: string }).created_at = '2026-08-01T00:00:00.000Z';
    recordReadCount = 0;
    expect((await resolveRecipientStates(d, old, { recordReads: true })).get('c3')?.state).toBe('stranded');
    expect(recordReadCount).toBe(0);
    expect((await resolveRecipientStates(d, old)).get('c3')?.state).toBe('in_flight');
    // and the flag: an old route-failed share does NOT flag its audience (the round-2 HIGH)
    const broadcasts = { async listByUnit() { return { items: [old], lastEvaluatedKey: undefined }; } };
    expect((await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1')).size).toBe(0);
  });
});

describe('resolveRecipientStates and priorRecipientKeys', () => {
  const rows = new Map<string, { retry_due_at?: string; retry_outcome?: string }>();
  const records = new Map<string, { state: string; outcome?: string } | undefined>();
  let recordReadCount = 0;
  const deps = (opts?: { rowThrows?: boolean; recordThrows?: boolean }) => {
    const { capture, log } = captured();
    return {
      capture,
      deps: {
        messages: { async getByTsMsgIdConsistent(_c: string, ts: string) { if (opts?.rowThrows) throw new Error('boom'); const r = rows.get(ts); return r === undefined ? undefined : ({ tsMsgId: ts, ...r } as never); } },
        attempts: { async get(owner: { contactKey: string }) { recordReadCount += 1; if (opts?.recordThrows) throw new Error('boom'); return records.get(owner.contactKey) as never; } },
        now: () => NOW, log,
      },
    };
  };
  const item = (status: BroadcastItem['status'], recipients: Record<string, BroadcastRecipient>): BroadcastItem =>
    ({ broadcastId: 'b1', unitId: 'unit-1', status, created_at: '2026-09-28T11:49:00.000Z', recipients, stats: {}, created_by: 'u', audience_filter: {}, body_template: 't' } as never);

  it('reads a row only for young failed-30003 slots; reads a record only when asked (recordReads) and only for queued slots of a finished share; the map carries the facts', async () => {
    rows.set(ROOT, { retry_due_at: '2026-09-28T12:05:00.000Z' });
    records.set('c3', undefined);
    const { deps: d } = deps();
    const share1 = item('failed', {
      c1: slot({ status: 'failed', errorCode: '30003' }),
      c2: slot({ status: 'failed', errorCode: '30007' }),
      c3: slot({ status: 'queued' }),
      c4: slot({ status: 'delivered' }),
    });
    recordReadCount = 0;
    const noRecords = await resolveRecipientStates(d, share1);
    expect(recordReadCount).toBe(0);
    expect(noRecords.get('c3')?.state).toBe('in_flight');
    const states = await resolveRecipientStates(d, share1, { recordReads: true });
    expect(recordReadCount).toBe(1);
    expect(states.get('c1')).toMatchObject({ state: 'pending', retryDueAt: '2026-09-28T12:05:00.000Z' });
    expect(states.get('c2')?.state).toBe('failed');
    expect(states.get('c3')?.state).toBe('stranded');
    expect(states.get('c4')?.state).toBe('reached');
    expect(retryPendingCount(states)).toBe(1);
    expect(reachedCount(share1)).toBe(1);
  });
  it('unconfirmedByRow names a failed-30003 slot whose row says unresolved, never a send_unconfirmed slot', async () => {
    rows.set(ROOT, { retry_due_at: RETRY_PROMISE_WITHDRAWN_AT, retry_outcome: 'unconfirmed' });
    const { deps: d } = deps();
    const share1 = item('sent', { c1: slot({ status: 'failed', errorCode: '30003' }), c2: slot({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }) });
    const states = await resolveRecipientStates(d, share1);
    expect([...unconfirmedByRow(states, share1)]).toEqual(['c1']);
  });
  it('a failed row read reads pending and is logged; a failed record read reads in flight', async () => {
    const { deps: d, capture } = deps({ rowThrows: true, recordThrows: true });
    const states = await resolveRecipientStates(d, item('failed', { c1: slot({ status: 'failed', errorCode: '30003' }), c3: slot({ status: 'queued' }) }), { recordReads: true });
    expect(states.get('c1')?.state).toBe('pending');
    expect(states.get('c3')?.state).toBe('in_flight');
    expect(capture.atLevel(40).length).toBe(2);
  });
  it('priorRecipientKeys unions the SAFE reading over every share of the unit, whatever its stored status', async () => {
    const { deps: d } = deps();
    const broadcasts = { async listByUnit() { return { items: [
      item('failed', { c1: slot({ status: 'failed', errorCode: '30007' }), c2: slot({ status: 'sent' }) }),
      item('sent', { c3: slot({ status: 'skipped', errorCode: 'manual_mode' }), 'phone#+15550001111': slot({ status: 'delivered' }) }),
    ], nextCursor: null }; } };
    const keys = await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1');
    expect([...keys].sort()).toEqual(['c2', 'phone#+15550001111']);
  });
  it('priorRecipientKeys never throws: a listByUnit failure logs WARN and returns what it has', async () => {
    const { deps: d, capture } = deps();
    const broadcasts = { async listByUnit() { throw new Error('index missing'); } };
    expect((await priorRecipientKeys({ ...d, broadcasts: broadcasts as never }, 'unit-1')).size).toBe(0);
    expect(capture.atLevel(40).length).toBe(1);
  });
});
```

Read `app/test/broadcastsRepo.integration.test.ts` for the real `listByUnit` page shape (`BroadcastsPage`: `{ items, ... }` - use its field names in the fake above, and page on `exclusiveStartKey` in the service).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd app; npx vitest run test/shareRecipientState.test.ts`
Expected: FAIL - cannot resolve `../src/services/shareRecipientState.js`.

- [ ] **Step 3: Write the service**

`app/src/services/shareRecipientState.ts`:

```ts
/**
 * share-sent-outcome D1: ONE per-recipient state for a property send, derived
 * from the slot plus - inside two bounds - the newest attempt's own message
 * row (its promise and its chain's end) and, for a queued slot of a finished
 * share, the recipient's send-attempt record. Two readings: SAFE (the review
 * list's "Already sent") and STRICT (labels, counts, ledger, milestone). The
 * share's STORED status is never read to decide whether a tenant got the
 * property (I1); it only tells a running pass from a finished one.
 */
import type { Logger } from 'pino';
import type { BroadcastItem, BroadcastRecipient, BroadcastsRepo } from '../repos/broadcastsRepo.js';
import { deriveBroadcastStats } from '../repos/broadcastsRepo.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';
import type { SendAttemptRecord, SendAttemptsRepo } from '../repos/sendAttemptsRepo.js';
import { SEND_ATTEMPT_CLEANUP_MS } from '../repos/sendAttemptsRepo.js';
import { RECONCILE_CHECK_DELAYS_MS, SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { RETRY_OUTCOME_UNCONFIRMED, RETRY_PROMISE_GRACE_MS, RETRY_SEND_WINDOW_MS, isRetryPromiseLive } from '../lib/retrySendWindow.js';
import { attemptKeyTimestampMs, retriedOfRowless } from '../lib/shareAttemptOrder.js';

export type RecipientState = 'reached' | 'pending' | 'unconfirmed' | 'in_flight' | 'stranded' | 'failed' | 'skipped';

/** The longest a promise can be live, from the newest attempt's own timestamp: the window, 1b's unknown-outcome refresh (last check delay + grace), the liveness grace, one minute of clock skew. 24 minutes today. */
export const RETRY_ROW_READ_BOUND_MS =
  RETRY_SEND_WINDOW_MS + RECONCILE_CHECK_DELAYS_MS[RECONCILE_CHECK_DELAYS_MS.length - 1]! + 2 * RETRY_PROMISE_GRACE_MS + 60_000;
/** A send-attempt record lives 30 days; an older strand reads stranded without a read. */
export const RECORD_READ_BOUND_MS = SEND_ATTEMPT_CLEANUP_MS;

const NEVER_WENT = new Set(['refused', 'rejected', 'enqueue_failed', 'redrive_refused']);
const RETRIED_CODE = '30003';

export interface RecipientFacts {
  row?: { retryDueAt?: string; retryOutcome?: string } | 'unreadable';
  /** absent = the caller did not ask; null = read, absent; 'expired' = past the record's life, not read; 'unreadable' = the read threw. */
  record?: SendAttemptRecord | null | 'unreadable' | 'expired';
}
export interface ClassifiedRecipient { state: RecipientState; retryDueAt?: string; retryOutcome?: string; latestAttempt?: string }

export function classifyRecipient(
  share: Pick<BroadcastItem, 'status' | 'created_at'>, slot: BroadcastRecipient, facts: RecipientFacts, nowMs: number,
): RecipientState {
  switch (slot.status) {
    case 'skipped': return 'skipped';
    case 'delivered': case 'sent': return 'reached';
    case 'queued': {
      if (share.status === 'sending') return 'in_flight';
      const rec = facts.record;
      if (rec === undefined || rec === 'unreadable') return 'in_flight';   // not asked, or the read threw: the safe side
      if (rec === null || rec === 'expired') return 'stranded';            // read and absent, or past the record's life
      return rec.state === 'done' && rec.outcome !== undefined && NEVER_WENT.has(rec.outcome) ? 'stranded' : 'in_flight';
    }
    case 'failed': {
      if (slot.errorCode === SEND_UNCONFIRMED_CODE) return 'unconfirmed';
      if (slot.errorCode !== RETRIED_CODE) return 'failed';
      const row = facts.row;
      if (row === undefined) return 'failed';
      if (row === 'unreadable') return 'pending';
      if (row.retryOutcome === RETRY_OUTCOME_UNCONFIRMED) return 'unconfirmed';
      return isRetryPromiseLive(row.retryDueAt, nowMs) ? 'pending' : 'failed';
    }
  }
}

export function mayHaveReached(state: RecipientState): boolean {
  return state === 'reached' || state === 'pending' || state === 'unconfirmed' || state === 'in_flight';
}
export function hasReached(state: RecipientState): boolean { return state === 'reached'; }

function newestKey(slot: BroadcastRecipient): string | undefined { return slot.latestAttempt ?? slot.tsMsgId; }

export function needsRowRead(slot: BroadcastRecipient, nowMs: number): boolean {
  if (slot.status !== 'failed' || slot.errorCode !== RETRIED_CODE) return false;
  const key = newestKey(slot);
  const ts = key === undefined ? undefined : attemptKeyTimestampMs(key);
  return ts !== undefined && nowMs - ts <= RETRY_ROW_READ_BOUND_MS;
}
export function needsRecordRead(share: Pick<BroadcastItem, 'status' | 'created_at'>, slot: BroadcastRecipient, nowMs: number): boolean {
  if (slot.status !== 'queued' || share.status === 'sending') return false;
  const created = Date.parse(share.created_at);
  return Number.isFinite(created) && nowMs - created <= RECORD_READ_BOUND_MS;
}

export interface RecipientStateDeps {
  messages: Pick<MessagesRepo, 'getByTsMsgIdConsistent'>;
  attempts: Pick<SendAttemptsRepo, 'get'>;
  now?: () => number;
  log: Logger;
}

const READ_CONCURRENCY = 8;
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]!); }
  }));
  return out;
}

export async function resolveRecipientStates(deps: RecipientStateDeps, share: BroadcastItem, opts?: { recordReads?: boolean }): Promise<Map<string, ClassifiedRecipient>> {
  const nowMs = (deps.now ?? Date.now)();
  const entries = Object.entries(share.recipients ?? {});
  const classified = await mapLimit(entries, READ_CONCURRENCY, async ([contactKey, slot]): Promise<[string, ClassifiedRecipient]> => {
    const facts: RecipientFacts = {};
    if (needsRowRead(slot, nowMs) && slot.conversationId !== undefined) {
      const key = retriedOfRowless(newestKey(slot)!);
      try {
        const row = await deps.messages.getByTsMsgIdConsistent(slot.conversationId, key);
        facts.row = row === undefined ? {} : { ...(row.retry_due_at !== undefined && { retryDueAt: row.retry_due_at }), ...(row.retry_outcome !== undefined && { retryOutcome: row.retry_outcome }) };
      } catch (err) {
        deps.log.warn({ err, broadcastId: share.broadcastId, conversationId: slot.conversationId, tsMsgId: key }, 'share recipient state: attempt row read failed - reading the recipient as pending (safe)');
        facts.row = 'unreadable';
      }
    }
    if (opts?.recordReads === true && slot.status === 'queued' && share.status !== 'sending') {
      if (!needsRecordRead(share, slot, nowMs)) {
        facts.record = 'expired';
      } else {
        try {
          const rec = await deps.attempts.get({ kind: 'broadcast', broadcastId: share.broadcastId, contactKey });
          facts.record = rec ?? null;
        } catch (err) {
          deps.log.warn({ err, broadcastId: share.broadcastId, contactKey }, 'share recipient state: attempt record read failed - reading the recipient as in flight (safe)');
          facts.record = 'unreadable';
        }
      }
    }
    const state = classifyRecipient(share, slot, facts, nowMs);
    const row = facts.row !== undefined && facts.row !== 'unreadable' ? facts.row : undefined;
    return [contactKey, {
      state,
      ...(row?.retryDueAt !== undefined && { retryDueAt: row.retryDueAt }),
      ...(row?.retryOutcome !== undefined && { retryOutcome: row.retryOutcome }),
      ...(slot.latestAttempt !== undefined && { latestAttempt: slot.latestAttempt }),
    }];
  });
  return new Map(classified);
}

export function retryPendingCount(states: Map<string, ClassifiedRecipient>): number {
  let n = 0;
  for (const s of states.values()) if (s.state === 'pending') n += 1;
  return n;
}

/** Keys whose D1 state is unconfirmed although the slot's own code is not send_unconfirmed (the row said the chain ended unresolved). */
export function unconfirmedByRow(states: Map<string, ClassifiedRecipient>, share: Pick<BroadcastItem, 'recipients'>): Set<string> {
  const keys = new Set<string>();
  for (const [key, s] of states) {
    if (s.state === 'unconfirmed' && share.recipients?.[key]?.errorCode !== SEND_UNCONFIRMED_CODE) keys.add(key);
  }
  return keys;
}

/** The STRICT reading over the slots, no reads: recipients the carrier accepted or delivered. */
export function reachedCount(share: Pick<BroadcastItem, 'recipients' | 'stats'>): number {
  const s = deriveBroadcastStats(share);
  return s.delivered + s.sent + (s.sending ?? 0);
}

/** The composer flag's set (D1 SAFE reading) over every share of the unit. Never throws. */
export async function priorRecipientKeys(deps: RecipientStateDeps & { broadcasts: Pick<BroadcastsRepo, 'listByUnit'> }, unitId: string): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.broadcasts.listByUnit(unitId, { ...(exclusiveStartKey !== undefined && { exclusiveStartKey }) });
      for (const share of page.items) {
        const states = await resolveRecipientStates(deps, share, { recordReads: true });
        for (const [contactKey, s] of states) if (mayHaveReached(s.state)) keys.add(contactKey);
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  } catch (err) {
    deps.log.warn({ unitId, err, priorCount: keys.size }, 'priorRecipientKeys: byUnit read failed - returning what was resolved');
  }
  deps.log.info({ unitId, priorCount: keys.size }, 'broadcast prior-recipients resolved');
  return keys;
}
```

Read `broadcastsRepo.ts:687-700` for `BroadcastsPage`'s cursor field name (`lastEvaluatedKey` in the repo's `queryIndex` page, :582-616; the public page may name it differently - use the real one).

- [ ] **Step 4: Run the tests and typecheck**

Run: `cd app; npx vitest run test/shareRecipientState.test.ts` - PASS. `npm run typecheck` - exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/shareRecipientState.ts app/test/shareRecipientState.test.ts
git commit -m "feat(broadcasts): the recipient state service - D1's state table, the two readings, the 24-minute row bound and the 30-day record bound, priorRecipientKeys (share-sent-outcome T2)"
```

---

### Task 3: The ledger's per-share memory (D7) - repo, service, doubles, parity, readers filter, the sparse note

**Files:**
- Modify: `app/src/repos/listingSendsRepo.ts` (`ListingSendItem` :36-51, the interface :83-96, `recordSend` :136-178 - kept, DEPRECATED, retired in Task 7 -, `listByUnit` :182-190, `listByContact` :192-202)
- Create: `app/src/services/shareLedger.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (the ledger double :3085-3134)
- Modify: `app/src/lib/tables.ts` (:418-424 `byContact`), `README.md:25` (the deviations table), `app/src/lib/seed/history.ts:995-1008` (skip `counted === false`)
- Test: `app/test/listingSendsRepoShares.integration.test.ts`, `app/test/shareLedger.test.ts`, `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts` (parity), `app/test/tables.test.ts:86-96` (the sparse pin), `app/test/listingSendsApi.test.ts` (a `counted: false` row is absent from both GET routes)

**Interfaces:**
- Consumes: `queryAll`, `UpdateCommand`, `GetCommand`, `BatchGetCommand`, `ConditionalCheckFailedException`, `randomUUID`; `LEGACY_ATTEMPT_KEY`, `INDIVIDUAL_ATTEMPT_KEY`, `compareAttemptKeys`, `attemptKeyTimestampMs` (Task 1).
- Produces: the T3 block of the shared interfaces. `ListingSendItem.sentAt` becomes OPTIONAL (`sentAt?: string`; the readers and `toListingSendRow` treat an absent one as "not listed" - the projections only ever see counted rows). `putShareMemory` SETs `shares`, `counted`, `shares_op = :op` (a fresh `randomUUID()`), `updated_at = :now`, `created_at = if_not_exists(created_at, :now)`, `via = if_not_exists(via, :via)` (`'broadcast'`), and either SETs `sentAt` + `broadcastId` (both supplied) or SETs `sentAt` and REMOVEs `broadcastId` (an individual-only counted pair) or REMOVEs both (nothing counts); condition `attribute_not_exists(shares_op)` when `expect.token` is undefined (an absent row OR a seeded/legacy row with no token - both are "nobody has written memory here yet"; a concurrent first write loses the condition and re-reads), else `shares_op = :tok`. `applyShareLedgerEntry` rule (spec D7, verbatim): read consistently; a row with no `shares` seeds one entry from itself (`broadcastId` -> key = that id, attempt `LEGACY_ATTEMPT_KEY`, state `counted` by `acceptance`, `countedAt = row.sentAt`; no `broadcastId` -> key `individual`, attempt `INDIVIDUAL_ATTEMPT_KEY`); the existing entry for the share is `counted` by `delivery` -> `refused` (terminal); else `compareAttemptKeys(entry.attempt, existing.attempt)`: `1` -> apply; `0` -> forward only (`counted`/acceptance -> `counted`/delivery | `pending` | `failed`; `pending` -> `failed`; anything else refused); `-1` -> apply only when the incoming entry is `counted` by `delivery`; no entry -> apply. Then `counted` = any entry `counted`; `sentAt` = the latest `countedAt` among counted entries and `broadcastId` = that entry's key unless it is `individual`; write; a lost condition re-reads and re-applies up to 3 times, then `'lost'` with ONE ERROR (ids only). `ledgerEntryFor(attempt, conversationId, outcome)`: a counted entry's `countedAt` is `new Date(attemptKeyTimestampMs(attempt)).toISOString()` - the attempt's own provider instant; a synthetic key has none and is never passed here.

- [ ] **Step 1: Write the failing repo test**

`app/test/listingSendsRepoShares.integration.test.ts` (per-file database; copy the setup of `app/test/listingSendsRepo.integration.test.ts:1-55`):

```ts
// spec D7: the ledger row's per-share memory, the counted flag, the sparse GSI by ABSENCE, the change token.
import { describe, expect, it } from 'vitest';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
// ...setup: createListingSendsRepo over the per-file database (read listingSendsRepo.integration.test.ts); `doc`, `env`, `tableName`.

const A1 = { attempt: '2026-09-28T10:00:00.000Z#SM1', state: 'counted' as const, by: 'acceptance' as const, countedAt: '2026-09-28T10:00:00.000Z' };

describe('putShareMemory', () => {
  it('creates the row when no token is expected and none exists; a second tokenless write loses (the first write stamped the token)', async () => {
    const next = { shares: { b1: A1 }, counted: true, sentAt: A1.countedAt, broadcastId: 'b1' };
    expect(await repo.putShareMemory('unit-1', 'c1', next, { token: undefined })).toBe(true);
    expect(await repo.putShareMemory('unit-1', 'c1', next, { token: undefined })).toBe(false);
    const row = await repo.getByKeyConsistent('unit-1', 'c1');
    expect(row).toMatchObject({ counted: true, sentAt: A1.countedAt, broadcastId: 'b1', via: 'broadcast' });
    expect(typeof row?.shares_op).toBe('string');
  });
  it('a SEEDED row (created_at, sentAt, no token - the full-world matrix shape) accepts a tokenless first write', async () => {
    await doc.send(new PutCommand({ TableName: tableName('listing_sends', env), Item: { unitId: 'unit-mx', contactId: 'c-mx', sentAt: '2026-08-01T00:00:00.000Z', via: 'broadcast', broadcastId: 'b-old', created_at: '2026-08-01T00:00:00.000Z' } }));
    expect(await repo.putShareMemory('unit-mx', 'c-mx', { shares: { 'b-old': { ...A1, attempt: '!legacy', countedAt: '2026-08-01T00:00:00.000Z' } }, counted: true, sentAt: '2026-08-01T00:00:00.000Z', broadcastId: 'b-old' }, { token: undefined })).toBe(true);
  });
  it('the current token wins; a stale token loses; nothing-counted REMOVES sentAt and broadcastId, the byContact index drops the row and the base reader filters it; a re-count brings it back', async () => {
    const first = await repo.getByKeyConsistent('unit-1', 'c1');
    const cleared = { shares: { b1: { attempt: A1.attempt, state: 'failed' as const } }, counted: false, sentAt: undefined, broadcastId: undefined };
    expect(await repo.putShareMemory('unit-1', 'c1', cleared, { token: 'not-the-token' })).toBe(false);
    expect(await repo.putShareMemory('unit-1', 'c1', cleared, { token: first!.shares_op })).toBe(true);
    const row = await repo.getByKeyConsistent('unit-1', 'c1');
    expect(row?.counted).toBe(false);
    expect(row?.sentAt).toBeUndefined();
    expect(row?.broadcastId).toBeUndefined();
    expect(await repo.listByContact('c1')).toEqual([]);   // the GSI is sparse by absence
    expect(await repo.listByUnit('unit-1')).toEqual([]);  // the base-table reader filters counted === false
    const recounted = { shares: { b1: { attempt: '2026-09-28T10:05:00.000Z#SM2', state: 'counted' as const, by: 'delivery' as const, countedAt: '2026-09-28T10:05:00.000Z' } }, counted: true, sentAt: '2026-09-28T10:05:00.000Z', broadcastId: 'b1' };
    expect(await repo.putShareMemory('unit-1', 'c1', recounted, { token: row!.shares_op })).toBe(true);
    expect((await repo.listByContact('c1')).map((r) => r.sentAt)).toEqual(['2026-09-28T10:05:00.000Z']);  // back in the index
  });
  it('an individual-only counted pair keeps sentAt and no broadcastId', async () => {
    expect(await repo.putShareMemory('unit-2', 'c1', { shares: { individual: { attempt: '!individual', state: 'counted', by: 'acceptance', countedAt: '2026-07-01T00:00:00.000Z' } }, counted: true, sentAt: '2026-07-01T00:00:00.000Z', broadcastId: undefined }, { token: undefined })).toBe(true);
    const row = await repo.getByKeyConsistent('unit-2', 'c1');
    expect(row).toMatchObject({ counted: true, sentAt: '2026-07-01T00:00:00.000Z' });
    expect(row?.broadcastId).toBeUndefined();
  });
  it('getByKeys returns the found pairs keyed unitId|contactId', async () => {
    const m = await repo.getByKeys([{ unitId: 'unit-1', contactId: 'c1' }, { unitId: 'unit-9', contactId: 'c9' }]);
    expect([...m.keys()]).toEqual(['unit-1|c1']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails** - `cd app; npx vitest run test/listingSendsRepoShares.integration.test.ts` (`putShareMemory` is not a function).

- [ ] **Step 3: Extend the repo**

```ts
export type ShareLedgerState = 'counted' | 'pending' | 'unconfirmed' | 'failed';
export interface ShareLedgerEntry {
  /** The attempt this entry records (shareAttemptOrder key; `!legacy` / `!individual` for a seeded entry). */
  attempt: string;
  /** The attempt row's conversation (D6 reads the row for a pending entry). Absent on a seeded entry. */
  conversationId?: string;
  state: ShareLedgerState;
  /** For `counted`: what counted it. A DELIVERY-counted entry is terminal (I2). */
  by?: 'acceptance' | 'delivery';
  /** ISO - the ATTEMPT's own provider instant (never a write instant): the row's sentAt follows the latest counted one. */
  countedAt?: string;
}
// ListingSendItem: `sentAt?: string` (REMOVED while nothing counts); gains
  counted?: boolean;                                  // ABSENT on a legacy row = counted
  shares?: Record<string, ShareLedgerEntry>;          // keyed by broadcastId, or `individual`
  shares_op?: string;                                 // the change token every putShareMemory stamps
export interface ShareMemoryWrite { shares: Record<string, ShareLedgerEntry>; counted: boolean; sentAt: string | undefined; broadcastId: string | undefined }
// interface gains:
  getByKeyConsistent(unitId: string, contactId: string): Promise<ListingSendItem | undefined>;
  putShareMemory(unitId: string, contactId: string, next: ShareMemoryWrite, expect: { token: string | undefined }): Promise<boolean>;
  getByKeys(pairs: Array<{ unitId: string; contactId: string }>): Promise<Map<string, ListingSendItem>>;
// recordSend: kept this task with a `@deprecated share-sent-outcome T7 retires it` doc line; Task 7 deletes it.

    async putShareMemory(unitId, contactId, next, expect) {
      const now = new Date().toISOString();
      const sets = ['shares = :shares', 'counted = :counted', 'shares_op = :op', 'updated_at = :now', 'created_at = if_not_exists(created_at, :now)', 'via = if_not_exists(via, :via)'];
      const removes: string[] = [];
      const values: Record<string, unknown> = { ':shares': next.shares, ':counted': next.counted, ':op': randomUUID(), ':now': now, ':via': 'broadcast' };
      if (next.sentAt !== undefined) { sets.push('sentAt = :sentAt'); values[':sentAt'] = next.sentAt; } else removes.push('sentAt');
      if (next.broadcastId !== undefined) { sets.push('broadcastId = :bid'); values[':bid'] = next.broadcastId; } else removes.push('broadcastId');
      let condition = 'attribute_not_exists(shares_op)';
      if (expect.token !== undefined) { condition = 'shares_op = :tok'; values[':tok'] = expect.token; }
      try {
        await doc.send(new UpdateCommand({
          TableName: table, Key: { unitId, contactId },
          UpdateExpression: `SET ${sets.join(', ')} REMOVE ${removes.join(', ')}`.replace(/ REMOVE $/, ''),
          ConditionExpression: condition, ExpressionAttributeValues: values,
        }));
        return true;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return false;
        throw err;
      }
    },
```

`getByKeyConsistent` (a `GetCommand` with `ConsistentRead: true`) and `getByKeys` (the Task 1 BatchGet idiom on `{ unitId, contactId }` keys, WARN on leftover unprocessed keys) as in revision 1; `listByUnit` and `listByContact` filter `r.counted !== false` on the `queryAll` result. `toListingSendRow` (:104-118) throws if `sentAt` is absent (it is only ever called on counted rows; the guard documents it).

- [ ] **Step 4: Write the failing service test**

`app/test/shareLedger.test.ts` (an in-memory fake of `getByKeyConsistent` / `putShareMemory` with a token; no DynamoDB):

```ts
// spec D7: order-independence, legacy seeding, the delivery-terminal rule, the attempt-instant clock, the bounded re-read.
import { describe, expect, it } from 'vitest';
import type { ListingSendItem, ShareMemoryWrite } from '../src/repos/listingSendsRepo.js';
import { LEGACY_ATTEMPT_KEY } from '../src/lib/shareAttemptOrder.js';
import { applyShareLedgerEntry, ledgerEntryFor } from '../src/services/shareLedger.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';

const A1 = '2026-09-28T10:00:00.000Z#SM1';
const A2 = '2026-09-28T10:01:00.000Z#SM2';
function fakeLedger(seed?: Partial<ListingSendItem>, opts?: { loseFirst?: number }) {
  let row: ListingSendItem | undefined = seed === undefined ? undefined : ({ unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 't0', updated_at: 't0', ...seed } as ListingSendItem);
  let losses = opts?.loseFirst ?? 0;
  let tick = 0;
  return {
    get row() { return row; },
    listingSends: {
      async getByKeyConsistent() { return row === undefined ? undefined : { ...row }; },
      async putShareMemory(_u: string, _c: string, next: ShareMemoryWrite, expect: { token: string | undefined }) {
        if (losses > 0) { losses -= 1; row = { ...(row ?? { unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 'now', updated_at: 'now' } as ListingSendItem), shares_op: `bump${tick++}` }; return false; }
        if (row?.shares_op !== expect.token) return false;
        const base: ListingSendItem = row ?? ({ unitId: 'u', contactId: 'c', via: 'broadcast', created_at: 'now', updated_at: 'now' } as ListingSendItem);
        row = { ...base, shares: next.shares, counted: next.counted, shares_op: `tok${tick++}` };
        if (next.sentAt !== undefined) row.sentAt = next.sentAt; else delete row.sentAt;
        if (next.broadcastId !== undefined) row.broadcastId = next.broadcastId; else delete row.broadcastId;
        return true;
      },
    },
  };
}
const captured = () => { const capture = createLogCapture(); return { capture, log: createLogger({ level: 'info', destination: capture.stream }) }; };
const deps = (f: ReturnType<typeof fakeLedger>) => ({ listingSends: f.listingSends, log: captured().log });
const write = (f: ReturnType<typeof fakeLedger>, broadcastId: string, attempt: string, kind: 'accepted' | 'delivered' | 'pending' | 'failed' | 'unconfirmed') =>
  applyShareLedgerEntry(deps(f), { unitId: 'u', contactId: 'c', broadcastId, entry: ledgerEntryFor(attempt, 'conv', { kind }) });

describe('applyShareLedgerEntry', () => {
  it('creates the row on the first write (callback before the pass) and refuses the pass''s later acceptance for the same attempt', async () => {
    const f = fakeLedger();
    expect(await write(f, 'b1', A1, 'failed')).toBe('written');
    expect(f.row?.counted).toBe(false);
    expect(await write(f, 'b1', A1, 'accepted')).toBe('refused');
  });
  it('a counted entry''s sentAt is the ATTEMPT''s provider instant, and a delivery of the same attempt does not move it', async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'accepted');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T10:00:00.000Z', broadcastId: 'b1' });
    expect(await write(f, 'b1', A1, 'delivered')).toBe('written');
    expect(f.row?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery', countedAt: '2026-09-28T10:00:00.000Z' });
    expect(f.row?.sentAt).toBe('2026-09-28T10:00:00.000Z');
    expect(await write(f, 'b1', A2, 'failed')).toBe('refused'); // delivery is terminal
  });
  it('pending -> failed moves forward; pending -> pending again is refused; nothing moves back', async () => {
    const g = fakeLedger();
    await write(g, 'b1', A1, 'pending');
    expect(g.row?.counted).toBe(false);
    expect(await write(g, 'b1', A1, 'failed')).toBe('written');
    expect(await write(g, 'b1', A1, 'pending')).toBe('refused');
  });
  it('a newer attempt replaces a failed entry and the pair counts again at the newer attempt''s instant; an older attempt is refused unless it is a delivery', async () => {
    const f = fakeLedger();
    await write(f, 'b1', A1, 'failed');
    expect(await write(f, 'b1', A2, 'accepted')).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-28T10:01:00.000Z' });
    expect(await write(f, 'b1', A1, 'failed')).toBe('refused');
    expect(await write(f, 'b1', A1, 'delivered')).toBe('written');
    expect(f.row?.shares?.['b1']).toMatchObject({ attempt: A1, by: 'delivery', countedAt: '2026-09-28T10:00:00.000Z' });
  });
  it('a legacy row seeds its own share as a counted entry at the row''s own sentAt, which survives a newer share''s failure', async () => {
    const f = fakeLedger({ sentAt: '2026-09-01T00:00:00.000Z', broadcastId: 'b-old' });
    await write(f, 'b-new', A1, 'failed');
    expect(f.row?.shares?.['b-old']).toMatchObject({ attempt: LEGACY_ATTEMPT_KEY, state: 'counted', countedAt: '2026-09-01T00:00:00.000Z' });
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-09-01T00:00:00.000Z', broadcastId: 'b-old' });
  });
  it('an individual-only legacy row seeds an `individual` entry; when a share also counts, sentAt and broadcastId follow the latest counted entry', async () => {
    const f = fakeLedger({ sentAt: '2026-07-01T00:00:00.000Z' });
    await write(f, 'b1', A1, 'accepted');
    expect(f.row?.shares?.['individual']).toMatchObject({ state: 'counted', countedAt: '2026-07-01T00:00:00.000Z' });
    expect(f.row).toMatchObject({ sentAt: '2026-09-28T10:00:00.000Z', broadcastId: 'b1' });
    await write(f, 'b1', A1, 'failed');
    expect(await write(f, 'b1', A2, 'failed')).toBe('written');
    expect(f.row).toMatchObject({ counted: true, sentAt: '2026-07-01T00:00:00.000Z' });
    expect(f.row?.broadcastId).toBeUndefined();
  });
  it('a lost condition re-reads and re-applies; past the bound it reports lost with one ERROR', async () => {
    const f = fakeLedger({ shares: {}, counted: false, shares_op: 't' }, { loseFirst: 2 });
    expect(await write(f, 'b1', A1, 'accepted')).toBe('written');
    const g = fakeLedger({ shares: {}, counted: false, shares_op: 't' }, { loseFirst: 10 });
    const { capture, log } = captured();
    expect(await applyShareLedgerEntry({ listingSends: g.listingSends, log }, { unitId: 'u', contactId: 'c', broadcastId: 'b1', entry: ledgerEntryFor(A1, 'conv', { kind: 'accepted' }) })).toBe('lost');
    expect(capture.atLevel(50).length).toBe(1);
  });
});
```

- [ ] **Step 5: Write the service**

`app/src/services/shareLedger.ts`:

```ts
/** share-sent-outcome D7: the listing-send ledger follows the rule - only reached attempts count; every write is a conditional read-modify-write on the row's change token. */
import type { Logger } from 'pino';
import type { ListingSendItem, ListingSendsRepo, ShareLedgerEntry, ShareMemoryWrite } from '../repos/listingSendsRepo.js';
import type { BroadcastRecipient } from '../repos/broadcastsRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys } from '../lib/shareAttemptOrder.js';

export type ShareLedgerOutcome = { kind: 'accepted' } | { kind: 'delivered' } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'unconfirmed' };
export interface ShareLedgerDeps { listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>; log: Logger }
const MAX_REAPPLY = 3;
const INDIVIDUAL_KEY = 'individual';

export function ledgerEntryFor(attempt: string, conversationId: string | undefined, outcome: ShareLedgerOutcome): ShareLedgerEntry {
  const base = { attempt, ...(conversationId !== undefined && { conversationId }) };
  const at = attemptKeyTimestampMs(attempt);
  const countedAt = at === undefined ? undefined : new Date(at).toISOString();
  switch (outcome.kind) {
    case 'accepted': return { ...base, state: 'counted', by: 'acceptance', ...(countedAt !== undefined && { countedAt }) };
    case 'delivered': return { ...base, state: 'counted', by: 'delivery', ...(countedAt !== undefined && { countedAt }) };
    case 'pending': return { ...base, state: 'pending' };
    case 'failed': return { ...base, state: 'failed' };
    case 'unconfirmed': return { ...base, state: 'unconfirmed' };
  }
}

function seeded(row: ListingSendItem | undefined): Record<string, ShareLedgerEntry> {
  if (row === undefined) return {};
  if (row.shares !== undefined) return { ...row.shares };
  if (row.sentAt === undefined) return {};
  return row.broadcastId !== undefined
    ? { [row.broadcastId]: { attempt: LEGACY_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: row.sentAt } }
    : { [INDIVIDUAL_KEY]: { attempt: INDIVIDUAL_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: row.sentAt } };
}

/** Whether `next` may replace `existing` for the same share (spec D7 order rule). */
function mayReplace(existing: ShareLedgerEntry | undefined, next: ShareLedgerEntry): boolean {
  if (existing === undefined) return true;
  if (existing.state === 'counted' && existing.by === 'delivery') return false;
  const cmp = compareAttemptKeys(next.attempt, existing.attempt);
  if (cmp === 1) return true;
  if (cmp === -1) return next.state === 'counted' && next.by === 'delivery';
  if (existing.state === 'counted') return next.state === 'counted' ? next.by === 'delivery' : next.state === 'pending' || next.state === 'failed';
  if (existing.state === 'pending') return next.state === 'failed';
  return false;
}

function summarize(shares: Record<string, ShareLedgerEntry>): Pick<ShareMemoryWrite, 'counted' | 'sentAt' | 'broadcastId'> {
  let latest: { key: string; at: string } | undefined;
  for (const [key, e] of Object.entries(shares)) {
    if (e.state !== 'counted' || e.countedAt === undefined) continue;
    if (latest === undefined || e.countedAt > latest.at) latest = { key, at: e.countedAt };
  }
  if (latest === undefined) return { counted: false, sentAt: undefined, broadcastId: undefined };
  return { counted: true, sentAt: latest.at, broadcastId: latest.key === INDIVIDUAL_KEY ? undefined : latest.key };
}

/** The entry a slot's OWN state implies (the repair's ledger rebuild, T13): the slot is the durable record, the ledger follows it. */
export function ledgerEntryForSlot(slot: BroadcastRecipient, conversationId: string, promiseLive: boolean): ShareLedgerEntry | undefined {
  const attempt = slot.latestAttempt ?? slot.tsMsgId;
  if (attempt === undefined) return undefined;
  switch (slot.status) {
    case 'delivered': return ledgerEntryFor(attempt, conversationId, { kind: 'delivered' });
    case 'sent': return ledgerEntryFor(attempt, conversationId, { kind: 'accepted' });
    case 'failed':
      if (slot.errorCode === SEND_UNCONFIRMED_CODE) return ledgerEntryFor(attempt, conversationId, { kind: 'unconfirmed' });
      return ledgerEntryFor(attempt, conversationId, { kind: slot.errorCode === '30003' && promiseLive ? 'pending' : 'failed' });
    default: return undefined;
  }
}

export async function applyShareLedgerEntry(deps: ShareLedgerDeps, args: { unitId: string; contactId: string; broadcastId: string; entry: ShareLedgerEntry }): Promise<'written' | 'refused' | 'lost'> {
  const ids = { unitId: args.unitId, contactId: args.contactId, broadcastId: args.broadcastId, attempt: args.entry.attempt, state: args.entry.state };
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const row = await deps.listingSends.getByKeyConsistent(args.unitId, args.contactId);
    const shares = seeded(row);
    if (!mayReplace(shares[args.broadcastId], args.entry)) return 'refused';
    shares[args.broadcastId] = args.entry;
    const next: ShareMemoryWrite = { shares, ...summarize(shares) };
    if (await deps.listingSends.putShareMemory(args.unitId, args.contactId, next, { token: row?.shares_op })) return 'written';
  }
  deps.log.error(ids, 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it');
  return 'lost';
}
```

- [ ] **Step 6: Run both, the parity, the pins; typecheck**

Mirror `getByKeyConsistent`, `putShareMemory` (with the `shares_op` token), `getByKeys`, the optional `sentAt`, `counted`/`shares` and the readers' filter in the harness double (:3085-3134); add a parity case beside `twilioWebhookHarnessRepoAdditions.integration.test.ts:735-814` running Step 1's first three cases through both. In `app/src/lib/tables.ts:418-424` add `sparse: true` to `byContact` with a one-line comment (`share-sent-outcome D7: sentAt is REMOVED when no share counts`); extend `app/test/tables.test.ts:86-96` to pin it; add the row to the README deviations table (`README.md:25`, the `tables.ts:17-19` convention). In `app/src/lib/seed/history.ts:995-1008` skip a row with `counted === false` or no `sentAt` (no seed has one; the guard documents the contract). In `app/test/listingSendsApi.test.ts` add: a row written `counted: false` through `putShareMemory` is absent from `GET /api/contacts/:id/listings-sent` and `GET /api/units/:id/recipients`.

Run: `cd app; npx vitest run test/listingSendsRepoShares.integration.test.ts test/shareLedger.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/tables.test.ts test/listingSendsApi.test.ts test/seedHistory.test.ts test/genTables.test.ts test/listingSendsRepo.integration.test.ts` - PASS (the last file's `recordSend` cases still pass: the method is only deprecated here). `npm run typecheck` - exit 0 (the optional `sentAt` may surface readers that assumed a string: `toListingSendRow` and the seed history are the two; fix them in this task).

- [ ] **Step 7: Commit**

```bash
git status
git add app/src/repos/listingSendsRepo.ts app/src/services/shareLedger.ts app/test/helpers/twilioWebhookHarness.ts app/src/lib/tables.ts README.md app/src/lib/seed/history.ts app/test/listingSendsRepoShares.integration.test.ts app/test/shareLedger.test.ts app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts app/test/tables.test.ts app/test/listingSendsApi.test.ts
git commit -m "feat(ledger): per-share memory, the counted flag, a change token and the sparse byContact index; applyShareLedgerEntry - the order rule, legacy seeding, delivery-terminal, the attempt-instant clock, the bounded re-read (share-sent-outcome T3)"
```

---

### Task 4: `applyLaterAttempt` (D2) and the original row's ledger write

**Files:**
- Create: `app/src/services/shareAttemptOutcome.ts`
- Test: `app/test/shareAttemptOutcome.test.ts` (the in-memory world `createFakeWorld()` from `app/test/helpers/twilioWebhookHarness.ts:504` as the broadcasts and ledger repos - its doubles from Tasks 1 and 3; `world.events` is the bus, :302)

**Interfaces:**
- Consumes: `applyAttemptOutcome`, `getByIdConsistent` (Task 1); `applyShareLedgerEntry`, `ledgerEntryFor` (Task 3); `deriveBroadcastStats`; `compareAttemptKeys` (Task 1); `SEND_UNCONFIRMED_CODE`; `isRetryPromiseLive`; `EventBus` (`app/src/lib/events.ts`) and the `broadcast.updated` payload shape `{ broadcastId, status, stats }` (`:146-150`).
- Produces: the T4 block of the shared interfaces. The D2 rule, verbatim:
  1. read the share consistently; none -> `'no_broadcast'` (WARN). Find the slot whose `conversationId === input.conversationId && tsMsgId === input.retryRoot`; none -> `'no_slot'` (the CALLER picks the level: ERROR for a retry row, WARN otherwise).
  2. `current = slot.latestAttempt ?? slot.tsMsgId`; `cmp = compareAttemptKeys(input.attemptKey, current)`.
  3. refuse unless `slot.status` is `failed` or `sent` (never from `queued`, `delivered`, `skipped` - spec D2/I3); refuse an older attempt (`cmp === -1`) unless `outcome.kind === 'delivered'`; for the same attempt (`cmp === 0`) allow only forward moves from `sent`: to `delivered`, to `failed`, or `sent` -> `sent` gaining `carrierSentAt`; everything else refused (a row-less marker re-applied is a no-op refusal; a same-attempt move from `failed` is refused - failed is terminal in the message machine).
  4. `next`: `sent` -> `{ status: 'sent', carrierSentAt? }`; `delivered` -> `{ status: 'delivered', carrierSentAt? }` (the OUTCOME's instant; for the same attempt the slot's existing `carrierSentAt` is kept when the outcome carries none); `failed` -> `{ status: 'failed', errorCode }`; `unresolved` -> `{ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE }`; always `conversationId`, `tsMsgId` (the ORIGINAL's), and `latestAttempt = input.attemptKey`. A NEWER attempt replaces the carrier instant (spec D2): it never inherits the previous attempt's `carrierSentAt`.
  5. the delta: persisted buckets are `queued | sent | delivered | failed | unconfirmed` (`bucketOf(slot)`: `failed` with `SEND_UNCONFIRMED_CODE` is `unconfirmed`); `{ [from]: -1, [to]: +1 }` when they differ.
  6. write with `expect = { status: slot.status, latestAttempt: slot.latestAttempt }`; a refused condition re-reads and re-decides up to 3 times (the loser re-applies: a retry's `failed` that lost to its own `sent` wins on the second pass), then `'lost'` with ONE WARN carrying the ids.
  7. on `applied`: the ledger entry for the pair. The pair's contact (spec D7): the slot key when it is a contact id (not `phone#...`); else `input.recipientContactId` (the send-time holder the row recorded); else INFO and no write. `delivered` -> `delivered`; `sent` -> `accepted`; `failed` with a live `retryDueAt` -> `pending`; `failed` -> `failed`; `unresolved` -> `unconfirmed`; the entry's `attempt` = `input.attemptKey`, `conversationId` = `input.conversationId`; only when the share has a `unitId`. Then emit `broadcast.updated` with `deriveBroadcastStats(item, { retryPending: 1 })` when the outcome is a `failed` with a live promise, else `deriveBroadcastStats(item)` (the count stays UNSET).
- `originalRowLedgerWrite`: the same entry mapping for an ORIGINAL row's receipt (`attempt` = `row.tsMsgId`), contact = the slot key when a contact id, else `row.recipient_contact_id`; none -> INFO `share ledger: no contact for the pair - no ledger entry` and return; no `unitId` -> return. It takes the slot key (the caller found the slot).

- [ ] **Step 1: Write the failing tests**

`app/test/shareAttemptOutcome.test.ts`:

```ts
// spec D2: one attempt-ordered transition, every refusal, every allowed move,
// the lost-condition re-apply, the delivered-at-any-age exception, the stats
// delta, the ledger call and the emit - through all outcome kinds.
import { describe, expect, it } from 'vitest';
import { createFakeWorld } from './helpers/twilioWebhookHarness.js';
import { SEND_UNCONFIRMED_CODE } from '../src/lib/sendOutcome.js';
import { rowlessAttemptKey } from '../src/lib/shareAttemptOrder.js';
import { applyLaterAttempt, originalRowLedgerWrite } from '../src/services/shareAttemptOutcome.js';
import { createLogger } from '../src/lib/logger.js';
import { createLogCapture } from './helpers/logCapture.js';
import type { BroadcastItem, BroadcastRecipient } from '../src/repos/broadcastsRepo.js';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ROOT = '2026-09-28T11:50:00.000Z#SM1';
const RETRY = '2026-09-28T11:51:00.000Z#SM2';
const LATER = '2026-09-28T11:52:00.000Z#SM3';
const baseShare = { broadcastId: 'b1', unitId: 'unit-1', status: 'sent', created_at: '2026-09-28T11:49:00.000Z', created_by: 'user-1', audience_filter: {}, body_template: 'hi',
  stats: { audience: 1, queued: 0, sent: 0, delivered: 0, failed: 1, skipped_opted_out: 0, skipped_no_consent: 0 } } as unknown as BroadcastItem;

function world(slot: Partial<BroadcastRecipient>, contactKey = 'c1', share: Partial<BroadcastItem> = {}) {
  const w = createFakeWorld();
  w.broadcasts.set('b1', { ...baseShare, ...share, recipients: { [contactKey]: { status: 'failed', errorCode: '30003', conversationId: 'conv-1', tsMsgId: ROOT, ...slot } } });
  const capture = createLogCapture();
  const log = createLogger({ level: 'info', destination: capture.stream });
  const emitted: Array<{ broadcastId: string; stats: { retry_pending?: number } }> = [];
  w.events.on('broadcast.updated', (e) => emitted.push(e as never));
  const deps = { broadcasts: w.broadcastsRepo, ledger: { listingSends: w.listingSendsRepo, log }, events: w.events, log, now: () => NOW };
  return { w, deps, capture, emitted, slot: () => w.broadcasts.get('b1')!.recipients![contactKey]!, share: () => w.broadcasts.get('b1')!, ledger: (c = 'c1') => w.listingSendsRepo.getByKeyConsistent('unit-1', c) };
}
const base = { broadcastId: 'b1', conversationId: 'conv-1', retryRoot: ROOT };

describe('applyLaterAttempt', () => {
  it('a newer attempt delivered: the slot leaves failed with the NEW carrier instant, stats move failed -> delivered in one write, the ledger counts by delivery at the attempt''s instant, the emit carries no retry_pending', async () => {
    const x = world({ carrierSentAt: '2026-09-28T11:50:01.000Z' });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'delivered', latestAttempt: RETRY, tsMsgId: ROOT, carrierSentAt: '2026-09-28T11:51:01.000Z' });
    expect(x.share().stats).toMatchObject({ failed: 0, delivered: 1 });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ attempt: RETRY, state: 'counted', by: 'delivery', conversationId: 'conv-1', countedAt: '2026-09-28T11:51:00.000Z' });
    expect(x.emitted[0]?.stats.retry_pending).toBeUndefined();
  });
  it('a newer attempt delivered WITHOUT a carrier instant drops the old attempt''s', async () => {
    const x = world({ carrierSentAt: '2026-09-28T11:50:01.000Z' });
    await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } });
    expect(x.slot().carrierSentAt).toBeUndefined();
  });
  it('a newer attempt failed 30003 with a live promise: failed stays failed, the ledger entry is pending, the emit carries retry_pending 1', async () => {
    const x = world({});
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T12:05:00.000Z' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: '30003', latestAttempt: RETRY });
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('pending');
    expect(x.emitted[0]?.stats.retry_pending).toBe(1);
  });
  it('a row-less unresolved end: send_unconfirmed, the unconfirmed bucket, the ledger entry unconfirmed; re-applied it is a refused no-op; a LATER real attempt (an adoption) supersedes it', async () => {
    const x = world({});
    const marker = rowlessAttemptKey(ROOT);
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: marker, outcome: { kind: 'unresolved' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: marker });
    expect(x.share().stats).toMatchObject({ failed: 0, unconfirmed: 1 });
    expect((await x.ledger())?.shares?.['b1']?.state).toBe('unconfirmed');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: marker, outcome: { kind: 'unresolved' } })).toBe('refused');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'sent', latestAttempt: RETRY });
    expect(x.share().stats).toMatchObject({ unconfirmed: 0, sent: 1 });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'acceptance' });
  });
  it('refusals: queued, delivered and skipped never move; an older attempt never applies; a same-attempt late sent after failed is refused', async () => {
    const q = world({ status: 'queued', errorCode: undefined });
    expect(await applyLaterAttempt(q.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('refused');
    const d = world({ status: 'delivered', errorCode: undefined, latestAttempt: RETRY });
    expect(await applyLaterAttempt(d.deps, { ...base, attemptKey: LATER, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('refused');
    const s = world({ status: 'skipped', errorCode: 'manual_mode' });
    expect(await applyLaterAttempt(s.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('refused');
    const o = world({ latestAttempt: LATER });
    expect(await applyLaterAttempt(o.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('refused');
    const f = world({ latestAttempt: RETRY });
    expect(await applyLaterAttempt(f.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent' } })).toBe('refused');
  });
  it('the delivered-at-any-age exception: an older attempt''s delivery applies over a newer failure and the slot records the delivered attempt', async () => {
    const x = world({ latestAttempt: LATER, errorCode: '30007' });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'delivered', latestAttempt: RETRY });
  });
  it('from sent (a lost original rollup): a newer attempt applies, and the same attempt moves sent -> sent-with-carrier -> delivered keeping its carrier instant', async () => {
    const x = world({ status: 'sent', errorCode: undefined });
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent' } })).toBe('applied');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:05.000Z' } })).toBe('applied');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'delivered', carrierSentAt: '2026-09-28T11:51:05.000Z' });
  });
  it('a phone-keyed slot moves by conversation + root; its ledger entry lands on the row''s recipient contact, and none is written without one', async () => {
    const x = world({}, 'phone#+15550002222');
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'sent', carrierSentAt: '2026-09-28T11:51:01.000Z' } })).toBe('applied');
    expect(await x.ledger('c-held')).toBeUndefined();
    expect(x.capture.atLevel(30).some((l) => String(l.msg).includes('no ledger entry'))).toBe(true);
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c-held' })).toBe('applied');
    expect((await x.ledger('c-held'))?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery' });
  });
  it('a contact-keyed slot ignores a differing row recipient (the send-time contact is the slot key)', async () => {
    const x = world({});
    await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'delivered' }, recipientContactId: 'c-other' });
    expect(await x.ledger('c1')).toBeDefined();
    expect(await x.ledger('c-other')).toBeUndefined();
  });
  it('a lost condition re-reads and re-applies: the retry''s failed that loses to its own sent wins on the second pass', async () => {
    const x = world({});
    let raced = false;
    const real = x.deps.broadcasts.applyAttemptOutcome.bind(x.deps.broadcasts);
    x.deps.broadcasts = { ...x.deps.broadcasts, async applyAttemptOutcome(id, key, expect, next, delta) {
      if (!raced) { raced = true; await real(id, key, expect, { status: 'sent', conversationId: 'conv-1', tsMsgId: ROOT, latestAttempt: RETRY }, { failed: -1, sent: 1 }); }
      return real(id, key, expect, next, delta);
    } };
    expect(await applyLaterAttempt(x.deps, { ...base, attemptKey: RETRY, outcome: { kind: 'failed', errorCode: '30007' } })).toBe('applied');
    expect(x.slot()).toMatchObject({ status: 'failed', errorCode: '30007', latestAttempt: RETRY });
    expect(x.share().stats).toMatchObject({ failed: 1, sent: 0 });
  });
  it('no slot and no broadcast are reported, never thrown', async () => {
    const x = world({});
    expect(await applyLaterAttempt(x.deps, { ...base, retryRoot: 'other', attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('no_slot');
    expect(await applyLaterAttempt(x.deps, { ...base, broadcastId: 'nope', attemptKey: RETRY, outcome: { kind: 'delivered' } })).toBe('no_broadcast');
  });
});

describe('originalRowLedgerWrite', () => {
  it('a failed 30003 with a live promise is pending; a delivered row (a different share) counts by delivery at its instant; a failed 30007 is failed; no contact writes nothing', async () => {
    const x = world({});
    const row = { tsMsgId: ROOT, conversationId: 'conv-1', recipient_contact_id: 'c1' };
    await originalRowLedgerWrite(x.deps, { share: x.share(), contactKey: 'c1', row, outcome: { kind: 'failed', errorCode: '30003', retryDueAt: '2026-09-28T12:05:00.000Z' } });
    expect((await x.ledger())?.shares?.['b1']).toMatchObject({ attempt: ROOT, state: 'pending' });
    const y = world({ status: 'sent', errorCode: undefined });
    await originalRowLedgerWrite(y.deps, { share: y.share(), contactKey: 'c1', row, outcome: { kind: 'delivered' } });
    expect((await y.ledger())?.shares?.['b1']).toMatchObject({ state: 'counted', by: 'delivery', countedAt: '2026-09-28T11:50:00.000Z' });
    const z = world({}, 'phone#+15550003333');
    await originalRowLedgerWrite(z.deps, { share: z.share(), contactKey: 'phone#+15550003333', row: { tsMsgId: ROOT, conversationId: 'conv-1' }, outcome: { kind: 'failed', errorCode: '30007' } });
    expect(await z.ledger('c1')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails** - `cd app; npx vitest run test/shareAttemptOutcome.test.ts` (module missing).

- [ ] **Step 3: Write the service**

`app/src/services/shareAttemptOutcome.ts`:

```ts
/** share-sent-outcome D2: a later attempt reaches its slot through ONE attempt-ordered transition; D7: the ledger follows. */
import type { Logger } from 'pino';
import type { BroadcastItem, BroadcastRecipient, BroadcastsRepo, BroadcastStats } from '../repos/broadcastsRepo.js';
import { deriveBroadcastStats } from '../repos/broadcastsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';
import type { EventBus } from '../lib/events.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { isRetryPromiseLive } from '../lib/retrySendWindow.js';
import { compareAttemptKeys } from '../lib/shareAttemptOrder.js';
import { applyShareLedgerEntry, ledgerEntryFor, type ShareLedgerDeps, type ShareLedgerOutcome } from './shareLedger.js';

export type AttemptOutcome =
  | { kind: 'sent'; carrierSentAt?: string }
  | { kind: 'delivered'; carrierSentAt?: string }
  | { kind: 'failed'; errorCode: string; retryDueAt?: string }
  | { kind: 'unresolved' };
export interface LaterAttempt { broadcastId: string; conversationId: string; retryRoot: string; attemptKey: string; outcome: AttemptOutcome; recipientContactId?: string }
export interface ShareAttemptOutcomeDeps {
  broadcasts: Pick<BroadcastsRepo, 'getByIdConsistent' | 'applyAttemptOutcome'>;
  ledger: ShareLedgerDeps; events: EventBus; log: Logger; now?: () => number;
}
export type ApplyResult = 'applied' | 'refused' | 'no_slot' | 'no_broadcast' | 'lost';
type Bucket = 'queued' | 'sent' | 'delivered' | 'failed' | 'unconfirmed';
const MAX_REAPPLY = 3;

function bucketOf(slot: Pick<BroadcastRecipient, 'status' | 'errorCode'>): Bucket | undefined {
  if (slot.status === 'skipped') return undefined;
  if (slot.status === 'failed') return slot.errorCode === SEND_UNCONFIRMED_CODE ? 'unconfirmed' : 'failed';
  return slot.status;
}
function nextSlot(slot: BroadcastRecipient, input: LaterAttempt, sameAttempt: boolean): BroadcastRecipient {
  const keep = { ...(slot.conversationId !== undefined && { conversationId: slot.conversationId }), ...(slot.tsMsgId !== undefined && { tsMsgId: slot.tsMsgId }), latestAttempt: input.attemptKey };
  const o = input.outcome;
  const carrier = o.kind === 'sent' || o.kind === 'delivered' ? (o.carrierSentAt ?? (sameAttempt ? slot.carrierSentAt : undefined)) : undefined;
  switch (o.kind) {
    case 'sent': return { ...keep, status: 'sent', ...(carrier !== undefined && { carrierSentAt: carrier }) };
    case 'delivered': return { ...keep, status: 'delivered', ...(carrier !== undefined && { carrierSentAt: carrier }) };
    case 'failed': return { ...keep, status: 'failed', errorCode: o.errorCode };
    case 'unresolved': return { ...keep, status: 'failed', errorCode: SEND_UNCONFIRMED_CODE };
  }
}
/** The D2 order rule alone, no reads (the repair's census asks it before counting a slot "to move"). */
export function wouldApply(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): boolean {
  return allowed(slot, input) !== undefined;
}
/** The D2 order rule: may `input` move `slot`? Returns the comparison when allowed. */
function allowed(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): { cmp: -1 | 0 | 1 } | undefined {
  if (slot.status !== 'failed' && slot.status !== 'sent') return undefined;
  const cmp = compareAttemptKeys(input.attemptKey, slot.latestAttempt ?? slot.tsMsgId ?? '');
  if (cmp === 1) return { cmp };
  if (cmp === -1) return input.outcome.kind === 'delivered' ? { cmp } : undefined;
  if (slot.status !== 'sent') return undefined;                                   // same attempt: failed is terminal
  if (input.outcome.kind === 'delivered' || input.outcome.kind === 'failed') return { cmp };
  return input.outcome.kind === 'sent' && slot.carrierSentAt === undefined && input.outcome.carrierSentAt !== undefined ? { cmp } : undefined;
}
function ledgerOutcome(o: AttemptOutcome, nowMs: number): ShareLedgerOutcome {
  switch (o.kind) {
    case 'delivered': return { kind: 'delivered' };
    case 'sent': return { kind: 'accepted' };
    case 'unresolved': return { kind: 'unconfirmed' };
    case 'failed': return isRetryPromiseLive(o.retryDueAt, nowMs) ? { kind: 'pending' } : { kind: 'failed' };
  }
}
/** spec D7: the slot key when it is a contact id; else the row's send-time holder; else none. */
function pairContact(contactKey: string, recipientContactId: string | undefined): string | undefined {
  return contactKey.startsWith('phone#') ? recipientContactId : contactKey;
}
async function writeLedger(deps: Pick<ShareAttemptOutcomeDeps, 'ledger' | 'log' | 'now'>, share: BroadcastItem, contactId: string | undefined, attempt: string, conversationId: string, outcome: AttemptOutcome): Promise<void> {
  if (typeof share.unitId !== 'string' || share.unitId.length === 0) return;
  if (contactId === undefined) { deps.log.info({ broadcastId: share.broadcastId, conversationId, attempt }, 'share ledger: no contact for the pair - no ledger entry'); return; }
  const entry = ledgerEntryFor(attempt, conversationId, ledgerOutcome(outcome, (deps.now ?? Date.now)()));
  try { await applyShareLedgerEntry(deps.ledger, { unitId: share.unitId, contactId, broadcastId: share.broadcastId, entry }); }
  catch (err) { deps.log.error({ err, broadcastId: share.broadcastId, contactId, attempt }, 'share ledger: entry write failed (best-effort)'); }
}

export async function applyLaterAttempt(deps: ShareAttemptOutcomeDeps, input: LaterAttempt): Promise<ApplyResult> {
  const ids = { broadcastId: input.broadcastId, conversationId: input.conversationId, retryRoot: input.retryRoot, attempt: input.attemptKey, outcome: input.outcome.kind };
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const share = await deps.broadcasts.getByIdConsistent(input.broadcastId);
    if (share === undefined) { deps.log.warn(ids, 'share attempt outcome: broadcast not found'); return 'no_broadcast'; }
    const found = Object.entries(share.recipients ?? {}).find(([, s]) => s.conversationId === input.conversationId && s.tsMsgId === input.retryRoot);
    if (found === undefined) return 'no_slot';
    const [contactKey, slot] = found;
    const ok = allowed(slot, input);
    if (ok === undefined) return 'refused';
    const next = nextSlot(slot, input, ok.cmp === 0);
    const from = bucketOf(slot); const to = bucketOf(next);
    const delta: Partial<BroadcastStats> = from !== to ? { ...(from !== undefined && { [from]: -1 }), ...(to !== undefined && { [to]: 1 }) } : {};
    const res = await deps.broadcasts.applyAttemptOutcome(input.broadcastId, contactKey, { status: slot.status, latestAttempt: slot.latestAttempt }, next, delta);
    if (!res.applied) continue;
    const item = res.item ?? share;
    await writeLedger(deps, item, pairContact(contactKey, input.recipientContactId), input.attemptKey, input.conversationId, input.outcome);
    const pending = input.outcome.kind === 'failed' && isRetryPromiseLive(input.outcome.retryDueAt, (deps.now ?? Date.now)());
    deps.events.emit('broadcast.updated', { broadcastId: item.broadcastId, status: item.status, stats: deriveBroadcastStats(item, pending ? { retryPending: 1 } : undefined) });
    deps.log.info({ ...ids, contactKey, from: slot.status, to: next.status }, 'share attempt outcome applied');
    return 'applied';
  }
  deps.log.warn(ids, 'share attempt outcome: the slot write lost its condition past the re-read bound - the repair heals it');
  return 'lost';
}

export async function originalRowLedgerWrite(
  deps: Pick<ShareAttemptOutcomeDeps, 'ledger' | 'log' | 'now'>,
  args: { share: BroadcastItem; contactKey: string; row: Pick<MessageItem, 'tsMsgId' | 'conversationId' | 'recipient_contact_id'>; outcome: AttemptOutcome },
): Promise<void> {
  await writeLedger(deps, args.share, pairContact(args.contactKey, args.row.recipient_contact_id), args.row.tsMsgId, args.row.conversationId, args.outcome);
}
```

Check the `EventBus.emit` signature and the typed event map (`app/src/lib/events.ts:297`) before writing the emit; `deriveBroadcastStats` on `item` (ALL_NEW) is the same zero-extra-read idiom the rollup uses (`twilio.ts:3978-3982`).

- [ ] **Step 4: Run and typecheck** - `cd app; npx vitest run test/shareAttemptOutcome.test.ts` PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/shareAttemptOutcome.ts app/test/shareAttemptOutcome.test.ts
git commit -m "feat(broadcasts): applyLaterAttempt - the attempt-ordered slot transition with its stats delta, the lost-condition re-apply, the delivered-at-any-age exception, the ledger call and the emit; the original row's ledger write (share-sent-outcome T4)"
```

---

### Task 5: The status webhook - retry rows routed, the original row's ledger write, the promise on the emit

Built AFTER Task 7 (Slice 2 order T4, T7, T5, T6), so the pass already writes the new ledger shape when the webhook starts writing entries.

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (deps :248-266 and the repo construction at :562-570 - `createXRepo({ logger: deps.logger })`, no `doc` in scope; the 30003 decision :3452-3467; the rollup gate :3520-3545; `rollIntoBroadcast` :3853-3984; the give-up line :3904)
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (`makeWebhookHarness`'s `webhooks` block :5110-5140: pass `listingSendsRepo: world.listingSendsRepo`)
- Test: `app/test/twilioStatusWebhook.test.ts` (the rollup block :245-373; the skip pin :374-424 REWRITTEN)

**Interfaces:**
- Consumes: `applyLaterAttempt`, `originalRowLedgerWrite` (Task 4); `message.retry_of`, `message.retry_root`, `message.broadcast_id`, `message.recipient_contact_id` (the row read at :3346-3370 - it is the PRE-write image and stays so; nothing re-reads it); the retry decision `oneToOneRetry` (:3452-3460) whose `runAt` is exactly what the status write stamped as `retry_due_at` (:3462-3467).
- Produces: `TwilioWebhookDeps` gains `listingSendsRepo?: ListingSendsRepo` (constructed like the others: `deps.listingSendsRepo ?? createListingSendsRepo({ logger: log })`). THE PROMISE VALUE: `const promisedAt = oneToOneRetry?.kind === 'retry' ? oneToOneRetry.runAt.toISOString() : undefined;` - never `message.retry_due_at` (the pre-write image; a first 30003 failure holds none). The gate at :3529 becomes `if (typeof message.broadcast_id === 'string' && message.broadcast_id.length > 0)`; inside: `if (message.retry_of !== undefined)` -> the RETRY path: `retry_root` missing -> ONE ERROR `broadcast delivery rollup: retry row without retry_root - unrouted (the repair stamps it)` and return; else `applyLaterAttempt(...)` with `attemptKey = message.tsMsgId`, `retryRoot = message.retry_root`, `outcome = outcomeOf(mappedStatus, ErrorCode, promisedAt, now)`, `recipientContactId = message.recipient_contact_id`; `'no_slot'` -> ONE ERROR (a routing bug); else the ORIGINAL path: `rollIntoBroadcast(..., promisedAt)` as today (it returns the updated item), then `originalRowLedgerWrite` for a `delivered` or `failed` transition with the slot key `rollIntoBroadcast` matched (return `{ item, contactKey }`). `outcomeOf` maps ONLY `sent` (-> `{ kind: 'sent', carrierSentAt: now }`), `delivered` (-> `{ kind: 'delivered' }` - the rollup stamps no carrier instant on a delivery today, and D2's same-attempt rule keeps the slot's), `failed` / `undelivered` (-> `{ kind: 'failed', errorCode: ErrorCode ?? 'unknown', retryDueAt: promisedAt }`); any other status (`queued`, `accepted`, `sending`) returns undefined and the retry path does nothing (spec D2 names confirmed-sent, delivered and failed). The give-up line :3904 keeps WARN and is re-worded in ASCII: `broadcast delivery rollup: no matching recipient slot - ignored` (grep the tests for the old string). The terminal-branch emit (:3975-3982) passes `{ retryPending: 1 }` when `next === 'failed' && errorCode === '30003' && isRetryPromiseLive(promisedAt, Date.now())`. THE WITHDRAWAL EMIT (deviation 13): RSW's enqueue-failure arm (:3632-3656) withdraws the promise AFTER the rollup emitted `retry_pending: 1`; when the row carries `broadcast_id`, that arm also emits `broadcast.updated` with `deriveBroadcastStats(share, { retryPending: 0 })` for the share the rollup returned (keep `rolled?.item` in scope; a retry row's withdrawal re-reads the share by id), so a list that turned Sending turns back.

- [ ] **Step 1: Rewrite the skip pin, add the new cases, and one case that would catch a stale-image read**

In `app/test/twilioStatusWebhook.test.ts`, replace the block at :374-424 with (fixtures: read the file's share and row builders around :200-244 and reuse them; `ROOT_SID` / `RETRY_SID` name the SIDs of a share's original row and its retry row - the retry row carries `broadcast_id`, `retry_of` ROOT, `retry_root` ROOT, `recipient_contact_id: 'c-1'`):

```ts
  it('a receipt for a share-RETRY row reaches the ORIGINAL slot through the attempt-ordered transition: delivered leaves failed, stats move, broadcast.updated fires, the ledger counts by delivery', async () => {
    const res = await postStatus({ MessageSid: RETRY_SID, MessageStatus: 'delivered' });
    expect(res.status).toBe(200);
    expect(world.broadcasts.get('b-1')!.recipients!['c-1']).toMatchObject({ status: 'delivered', tsMsgId: ROOT, latestAttempt: RETRY });
    expect(world.broadcasts.get('b-1')!.stats).toMatchObject({ failed: 0, delivered: 1 });
    expect(updatedEvents.at(-1)).toMatchObject({ broadcastId: 'b-1' });
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1'))?.shares?.['b-1']).toMatchObject({ state: 'counted', by: 'delivery' });
  });
  it('a retry row WITHOUT retry_root logs one ERROR and touches nothing', async () => {
    const res = await postStatus({ MessageSid: ORPHAN_RETRY_SID, MessageStatus: 'delivered' });
    expect(res.status).toBe(200);
    expect(capture.atLevel(50).filter((l) => String(l.msg).includes('unrouted')).length).toBe(1);
    expect(world.broadcasts.get('b-1')!.recipients!['c-1']!.status).toBe('failed');
  });
  it('a retry row whose root matches no slot logs one ERROR (a routing bug)', async () => {
    await postStatus({ MessageSid: STRAY_RETRY_SID, MessageStatus: 'delivered' });
    expect(capture.atLevel(50).filter((l) => String(l.msg).includes('no matching recipient slot')).length).toBe(1);
  });
  it('a retry row''s own 30003 failure with a new promise: the slot stays failed on the newer attempt, the emit carries retry_pending 1, the ledger entry is pending - the promise from the decision (the read returns a copy here too)', async () => {
    const real = world.messagesRepo.getByProviderSid.bind(world.messagesRepo);
    world.messagesRepo.getByProviderSid = async (sid) => { const r = await real(sid); return r === undefined ? undefined : { ...r }; };
    await postStatus({ MessageSid: RETRY_SID, MessageStatus: 'undelivered', ErrorCode: '30003' });
    expect(world.broadcasts.get('b-1')!.recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: '30003', latestAttempt: RETRY });
    expect(updatedEvents.at(-1)).toMatchObject({ stats: { retry_pending: 1 } });
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1'))?.shares?.['b-1']?.state).toBe('pending');
  });
  it('an ORIGINAL row''s 30003 failure with a promise: the slot fails as today, the emit carries retry_pending 1, the ledger entry is pending - and the promise comes from the decision, not from the row image the webhook read before writing', async () => {
    // Pin the source of the value: make the world's read return a COPY (the
    // double returns the live element, which would hide a stale-image read).
    const real = world.messagesRepo.getByProviderSid.bind(world.messagesRepo);
    world.messagesRepo.getByProviderSid = async (sid) => { const r = await real(sid); return r === undefined ? undefined : { ...r }; };
    const res = await postStatus({ MessageSid: ROOT_SID, MessageStatus: 'undelivered', ErrorCode: '30003' });
    expect(res.status).toBe(200);
    expect(updatedEvents.at(-1)).toMatchObject({ broadcastId: 'b-1', stats: { failed: 1, retry_pending: 1 } });
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1'))?.shares?.['b-1']?.state).toBe('pending');
  });
  it('an ORIGINAL row''s delivered receipt counts the ledger entry by delivery at the row''s instant; a 30007 failure writes failed; a phone-keyed slot whose row has no recipient contact writes nothing', async () => {
    await postStatus({ MessageSid: ROOT_SID, MessageStatus: 'delivered' });
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1'))?.shares?.['b-1']).toMatchObject({ state: 'counted', by: 'delivery', countedAt: ROOT.slice(0, ROOT.indexOf('#')) });
    await postStatus({ MessageSid: ROOT2_SID, MessageStatus: 'undelivered', ErrorCode: '30007' });   // share b-2, slot phone#..., row without recipient_contact_id
    expect(await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-2')).toBeUndefined();
  });
  it('a queued / accepted status on a retry row transitions the row but touches no slot', async () => {
    const before = updatedEvents.length;
    await postStatus({ MessageSid: RETRY_SID, MessageStatus: 'accepted' });
    expect(world.broadcasts.get('b-1')!.recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: '30003' });
    expect(updatedEvents.length).toBe(before);
  });
  it('an original row''s 30003 whose retry enqueue FAILS: the withdrawal emits broadcast.updated with retry_pending 0 after the rollup''s 1', async () => {
    world.jobs.enqueue = async () => { throw new Error('sqs down'); };   // read how the file fails an enqueue (the RSW withdrawal pin around :3632-3656's tests)
    await postStatus({ MessageSid: ROOT_SID, MessageStatus: 'undelivered', ErrorCode: '30003' });
    const forShare = updatedEvents.filter((e) => e.broadcastId === 'b-1');
    expect(forShare.at(-2)?.stats.retry_pending).toBe(1);
    expect(forShare.at(-1)?.stats.retry_pending).toBe(0);
  });
```

Keep the pins at :245 (original-row miss re-read), :296 and :344 (carrierSentAt) green; the give-up-line assertion in :245's block matches the ASCII text.

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/twilioStatusWebhook.test.ts`.

- [ ] **Step 3: Wire the harness, edit the webhook**

Harness: in `makeWebhookHarness`'s `webhooks` block (:5110-5140) add `listingSendsRepo: world.listingSendsRepo` beside `broadcastsRepo`.

`twilio.ts`:

```ts
// deps: + listingSendsRepo?: ListingSendsRepo;   at :562-570:
const listingSends = deps.listingSendsRepo ?? createListingSendsRepo({ logger: log });
const shareOutcomeDeps: ShareAttemptOutcomeDeps = { broadcasts, ledger: { listingSends, log }, events, log };

// after the 30003 decision (:3452-3467), in scope for the rollup:
const promisedAt = oneToOneRetry?.kind === 'retry' ? oneToOneRetry.runAt.toISOString() : undefined;

// :3520-3545 becomes:
if (transitioned) {
  if (typeof message.broadcast_id === 'string' && message.broadcast_id.length > 0) {
    try {
      if (message.retry_of !== undefined) {
        await rollRetryIntoBroadcast(shareOutcomeDeps, message, mappedStatus, ErrorCode, promisedAt);
      } else {
        const rolled = await rollIntoBroadcast(broadcasts, events, log, message.broadcast_id, message.conversationId, message.tsMsgId, mappedStatus, ErrorCode, statusRetryDelayMs, promisedAt);
        const outcome = outcomeOf(mappedStatus, ErrorCode, promisedAt);
        if (rolled !== undefined && outcome !== undefined && outcome.kind !== 'sent') {
          await originalRowLedgerWrite(shareOutcomeDeps, { share: rolled.item, contactKey: rolled.contactKey, row: message, outcome });
        }
      }
    } catch (err) {
      log.error({ err, providerSid: MessageSid, broadcastId: message.broadcast_id }, 'broadcast delivery rollup failed (best-effort; the message row is already updated)');
    }
  }
  ...
}

function outcomeOf(status: DeliveryStatus, errorCode: string | undefined, promisedAt: string | undefined): AttemptOutcome | undefined {
  if (status === 'delivered') return { kind: 'delivered' };
  if (status === 'failed' || status === 'undelivered') return { kind: 'failed', errorCode: errorCode ?? 'unknown', ...(promisedAt !== undefined && { retryDueAt: promisedAt }) };
  if (status === 'sent') return { kind: 'sent', carrierSentAt: new Date().toISOString() };
  return undefined;
}

async function rollRetryIntoBroadcast(deps: ShareAttemptOutcomeDeps, message: MessageItem, status: DeliveryStatus, errorCode: string | undefined, promisedAt: string | undefined): Promise<void> {
  const outcome = outcomeOf(status, errorCode, promisedAt);
  if (outcome === undefined) return;
  const ids = { broadcastId: message.broadcast_id, conversationId: message.conversationId, tsMsgId: message.tsMsgId };
  if (typeof message.retry_root !== 'string' || message.retry_root.length === 0) {
    deps.log.error(ids, 'broadcast delivery rollup: retry row without retry_root - unrouted (the repair stamps it)');
    return;
  }
  const result = await applyLaterAttempt(deps, {
    broadcastId: message.broadcast_id!, conversationId: message.conversationId, retryRoot: message.retry_root, attemptKey: message.tsMsgId, outcome,
    ...(message.recipient_contact_id !== undefined && { recipientContactId: message.recipient_contact_id }),
  });
  if (result === 'no_slot') deps.log.error({ ...ids, retryRoot: message.retry_root }, 'broadcast delivery rollup: no matching recipient slot for a retry row - a routing bug');
}
```

`rollIntoBroadcast` returns `{ item, contactKey } | undefined` (the ALL_NEW item it already has at :3975 or the re-read at :3933, and the matched key) and takes `promisedAt?: string` last, passing `{ retryPending: 1 }` to the terminal-branch emit when `next === 'failed' && errorCode === '30003' && isRetryPromiseLive(promisedAt, Date.now())`. The rollup's `sent` branch (:3915-3940) is unchanged for original rows.

- [ ] **Step 4: Run the webhook suite, the harness suites, typecheck** - `cd app; npx vitest run test/twilioStatusWebhook.test.ts test/twilioWebhookHarnessRetryFields.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts` PASS; `npm run typecheck` exit 0; the touched lines are ASCII (`git diff -U0 -- app/src/routes/webhooks/twilio.ts | grep '^+' | LC_ALL=C tr -d '\11\12\15\40-\176' | wc -c` prints 0).

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/webhooks/twilio.ts app/test/helpers/twilioWebhookHarness.ts app/test/twilioStatusWebhook.test.ts
git commit -m "feat(webhook): a share-retry row's receipt reaches its slot (routed by broadcast_id + retry_root through applyLaterAttempt); the original row's ledger entry; the promise taken from the retry decision; retry_pending 1 on a 30003-with-promise emit; give-up line ASCII (share-sent-outcome T5)"
```

---

### Task 6: The five 1b sites - the retry adoption, the reconcile's unresolved close, the job's two arms

**Files:**
- Modify: `app/src/jobs/sendReconcile.ts` (`Ctx` :325-335 and the lazy repo construction in the handler; `runCheck`'s found arm :541-558; `closeSlot`'s `retry_send` arm :1347-1372; the `Found` verdict type)
- Modify: `app/src/jobs/retrySend.ts` (deps :281-312; `onUnknown` :851-880; `handOff`'s catch :798-819)
- Test: `app/test/sendReconcile.test.ts` (the `retry_send owner` block :3015-4048), `app/test/retrySendAttempt.test.ts` (`wire()` :96-118 gains the two repos; cases beside :1289 and :1336)

`registerHandlers.ts` is NOT edited: it passes only `sendAttemptsRepo` (`:59-72`) and every job builds its other repos lazily; the two new deps default the same way.

**Interfaces:**
- Consumes: `applyLaterAttempt` (Task 4); `rowlessAttemptKey` (Task 1); `guardWrite` (`app/src/lib/guardWrite.ts:16-29`); in the reconcile: `r.owner` (`RetrySendOwner`), `r.row` (the RETRIED row, consistent), `c.broadcasts`, `c.events`, `c.log`; in the job: `owner`, `retried`, `octx`, `log` (reference section 6).
- Produces:
  - A shared helper in `shareAttemptOutcome.ts`: `applyLaterAttemptBounded(deps, input): Promise<ApplyResult | 'threw'>` - calls `applyLaterAttempt`, and on a THROW retries twice (a transient DynamoDB fault survives; a permanent one, the 400 KB item-size error, does not loop), then logs ONE ERROR with the ids and returns `'threw'`. Deviation 11: the reconcile sites use it; nothing propagates out of a share slot write, so a permanent failure never loops a check into the queue or the DLQ, and a dropped write is the repair's residue.
  - Site 5 (adoption), `runCheck` found arm, BEFORE `closeFromReconcile(adopted)` at :542, when `r.owner.kind === 'retry_send'` and `r.row?.broadcast_id` is a string: `applyLaterAttemptBounded(shareDeps(c), { broadcastId, conversationId: r.owner.conversationId, retryRoot: r.owner.retryRoot, attemptKey: verdict.tsMsgId, outcome: mapAdopted(verdict), recipientContactId: verdict.recipientContactId })`; then the close as built. `Found` gains `tsMsgId`, `errorCode?`, `carrierSentAt?` and `recipientContactId?` - set by `adoptRetry` from the appended row and the provider message (`carrierSentAt` from the provider's `date_sent` exactly as the share adoption does, `broadcastFanOut.ts:1415`), and by `ownRetryRow` from the pointer's row read. `mapAdopted`: `delivered` -> `{ kind: 'delivered', carrierSentAt }`; `failed`/`undelivered` -> `{ kind: 'failed', errorCode: verdict.errorCode ?? 'unknown' }`; `sent` (carrier-confirmed) -> `{ kind: 'sent', carrierSentAt }`; anything else -> `{ kind: 'sent' }` (accepted, not yet confirmed). A missing broadcast (test 10a seeds none) is `'no_broadcast'`: WARN, continue. A crash (the process dies) between the hook and the close still leaves the record `reconciling`, and the redelivered check re-finds the row through its own child pointer and re-runs the hook (spec D2's crash window).
  - Sites 1 and 2, `closeSlot`'s `retry_send` arm (:1366): the WITHDRAW FIRST, exactly as built (its throw-on-lost contract stands), THEN, when `code === SEND_UNCONFIRMED_CODE && r.row !== undefined && typeof r.row.broadcast_id === 'string'`: `applyLaterAttemptBounded(shareDeps(c), { ..., attemptKey: rowlessAttemptKey(r.owner.retriedTsMsgId), outcome: { kind: 'unresolved' }, recipientContactId: r.row.recipient_contact_id })`. A redelivered check (after a lost WITHDRAW) re-runs this arm through `slotCloseOf(unresolved)`; a re-applied slot write is a refused no-op.
  - Sites 3 and 4, the job: deps `broadcastsRepo?` and `listingSendsRepo?` (built lazily like `contactsRepo`, :390-401's idiom); a `markShareUnconfirmed()` helper in scope of both arms; at `onUnknown` immediately before `finish(...)` (:860) and at `handOff`'s catch immediately before `guardWrite(closeFromReconcile)` (:800): `await guardWrite(log, octx, 'shareSlotUnconfirmed', () => applyLaterAttempt(shareOutcome, { broadcastId: retried.broadcast_id, conversationId: owner.conversationId, retryRoot: owner.retryRoot, attemptKey: rowlessAttemptKey(owner.retriedTsMsgId), outcome: { kind: 'unresolved' }, recipientContactId: retried.recipient_contact_id }))`, only when `typeof retried.broadcast_id === 'string'`. Nothing throws (guardWrite); the record close follows as built.

- [ ] **Step 1: Add the reconcile tests**

In `app/test/sendReconcile.test.ts`, inside the `retry_send owner` block (fixtures: the share-root cases at :3885 seed a share row; 10a at :3154 seeds a share row with NO broadcast item; read how the block builds `world`, `owner`, `runCheck` and `capture`):

```ts
    it('adopting a share retry (found, adopted) moves the original slot as a newer attempt BEFORE the record closes - the slot write precedes closeFromReconcile in call order', async () => {
      // fixture: broadcast 'b-9' with slot c-1 failed 30003 on ROOT; retried row ROOT carries broadcast_id 'b-9'; the provider list returns the retry text as delivered
      const slotSpy = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
      const closeSpy = vi.spyOn(world.sendAttemptsRepo, 'closeFromReconcile');
      await runCheck(/* the retry_send owner ref for ROOT attempt 1 */);
      expect(slotSpy.mock.invocationCallOrder[0]).toBeLessThan(closeSpy.mock.invocationCallOrder[0]!);
      expect(world.broadcasts.get('b-9')!.recipients!['c-1']).toMatchObject({ status: 'delivered', latestAttempt: expect.stringContaining('#') });
      expect(await world.sendAttemptsRepo.get(owner)).toMatchObject({ state: 'done', outcome: 'adopted' });
    });
    it('a transient slot-write fault at the adoption hook is retried and the slot lands; a permanent one is ONE ERROR and the record still closes adopted (never a failed check)', async () => {
      let calls = 0;
      const real = world.broadcastsRepo.applyAttemptOutcome.bind(world.broadcastsRepo);
      world.broadcastsRepo.applyAttemptOutcome = async (...a) => { calls += 1; if (calls === 1) throw new Error('dynamo blip'); return real(...a); };
      await runCheck(/* ref */);
      expect(world.broadcasts.get('b-9')!.recipients!['c-1']!.status).toBe('delivered');
      expect((await world.sendAttemptsRepo.get(owner))?.outcome).toBe('adopted');
      world.broadcastsRepo.applyAttemptOutcome = async () => { throw new Error('Item size has exceeded the maximum allowed size'); };
      await runCheck(/* a second owner ref on another share fixture */);
      expect(capture.atLevel(50).filter((l) => String(l.msg).includes('share slot write failed')).length).toBe(1);
      expect((await world.sendAttemptsRepo.get(owner2))?.outcome).toBe('adopted');
    });
    it('a process crash between the adoption hook and the record close (simulated: the close throws once) leaves the record reconciling; the redelivered check re-finds the adopted row through its child pointer and re-runs the hook as a de-duplicated re-adoption', async () => {
      let thrown = false;
      const realClose = world.sendAttemptsRepo.closeFromReconcile.bind(world.sendAttemptsRepo);
      world.sendAttemptsRepo.closeFromReconcile = async (...a) => { if (!thrown) { thrown = true; throw new Error('crash'); } return realClose(...a); };
      await expect(runCheck(/* ref */)).rejects.toThrow('crash');
      expect((await world.sendAttemptsRepo.get(owner))?.state).toBe('reconciling');
      expect(world.broadcasts.get('b-9')!.recipients!['c-1']!.status).toBe('delivered');   // the hook ran before the close
      await runCheck(/* the same ref redelivered */);
      expect((await world.sendAttemptsRepo.get(owner))?.outcome).toBe('adopted');
      expect(world.broadcasts.get('b-9')!.stats.delivered).toBe(1);   // the re-run hook was a refused no-op
    });
    it('10a: adopting a share retry whose broadcast item is missing logs WARN and still closes adopted', async () => {
      await runCheck(/* the 10a ref */);
      expect(capture.atLevel(40).some((l) => String(l.msg).includes('broadcast not found'))).toBe(true);
      expect((await world.sendAttemptsRepo.get(owner10a))?.outcome).toBe('adopted');
    });
    it('an unresolved close of a share retry writes send_unconfirmed on the original slot as a row-less attempt, then withdraws the promise; the redelivered check re-applies both as no-ops; ONE unresolved ERROR in total', async () => {
      await runCheck(/* a ref whose lookup ends unresolved */);
      const slot = world.broadcasts.get('b-9')!.recipients!['c-1'];
      expect(slot).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(ROOT) });
      expect(world.broadcasts.get('b-9')!.stats).toMatchObject({ failed: 0, unconfirmed: 1 });
      expect((await world.messagesRepo.getByTsMsgIdConsistent('conv-1', ROOT))?.retry_outcome).toBe('unconfirmed');
      expect(capture.atLevel(50).length).toBe(1);
      await runCheck(/* redelivered */);
      expect(capture.atLevel(50).length).toBe(1);
    });
    it('at the unresolved close the WITHDRAW runs first: a permanently failing slot write is ONE ERROR, the promise is still withdrawn and the check does not fail', async () => {
      world.broadcastsRepo.applyAttemptOutcome = async () => { throw new Error('Item size has exceeded the maximum allowed size'); };
      await runCheck(/* unresolved ref */);
      expect((await world.messagesRepo.getByTsMsgIdConsistent('conv-1', ROOT))?.retry_outcome).toBe('unconfirmed');
      expect((await world.sendAttemptsRepo.get(owner))).toMatchObject({ state: 'done', outcome: 'unresolved' });
      expect(capture.atLevel(50).filter((l) => String(l.msg).includes('share slot write failed')).length).toBe(1);
    });
```

Keep every existing pin in the block green (`:3505` "one ERROR", `:3698` / `:3708` "ONE unresolved ERROR in total", `:4007` / `:4015` holder naming).

- [ ] **Step 2: Add the job tests**

In `app/test/retrySendAttempt.test.ts`: extend `wire()` (:96-118) with `broadcastsRepo: world.broadcastsRepo, listingSendsRepo: world.listingSendsRepo`; beside the FW1 C-5 cases (:1289 second unknown; :1336 hand-off enqueue failure):

```ts
  it('second unknown on a share retry: the original slot reads send_unconfirmed and the slot write PRECEDES the record close in call order; still ONE close ERROR', async () => {
    // fixture: the retried row carries broadcast_id 'b-1'; the share exists in world.broadcasts with slot c-1 failed 30003 on ROOT; redriveCount 1; the adapter throws unknown
    const slotSpy = vi.spyOn(world.broadcastsRepo, 'applyAttemptOutcome');
    const finishSpy = vi.spyOn(world.sendAttemptsRepo, 'finishAttempt');
    await runJob(payload);
    expect(slotSpy.mock.invocationCallOrder[0]).toBeLessThan(finishSpy.mock.invocationCallOrder[0]!);
    expect(world.broadcasts.get('b-1')!.recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE });
    expect(capture.atLevel(50).length).toBe(1);
  });
  it('a hand-off enqueue failure on a share retry: the slot write goes first and is guarded - a slot write that throws is ONE guard ERROR and the close still runs', async () => {
    world.broadcastsRepo.applyAttemptOutcome = async () => { throw new Error('dynamo down'); };
    await runJob(payload);
    expect(capture.atLevel(50).filter((l) => String(l.msg).includes('failure-arm write failed')).length).toBe(1);
    expect(await world.sendAttemptsRepo.get(owner)).toMatchObject({ state: 'done', outcome: 'unresolved', cause: 'enqueue_failed' });
  });
  // "A later attempt supersedes the unconfirmed slot the job wrote": after the
  // job closes the record nothing adopts, so the superseding attempt is a NEW
  // one (a staff Retry row's receipt). That path is Task 4's service test
  // ("a LATER real attempt supersedes it") and Task 5's webhook route; no job
  // test claims it.
  it('a retry of a one-to-one text that is NOT a share (no broadcast_id) writes no slot and reads no broadcast', async () => {
    const reads = vi.spyOn(world.broadcastsRepo, 'getByIdConsistent');
    await runJob(payloadForPlainRow);
    expect(reads).not.toHaveBeenCalled();
  });
```

(`runReconcileCheck` is the reconcile-side runner from `sendReconcile.test.ts`; if the two suites cannot share it, put the "later adoption supersedes" case in `sendReconcile.test.ts` with the slot pre-set to `send_unconfirmed` + the row-less marker, which Task 4's unit test already covers at the service level.)

- [ ] **Step 3: Run to see the reds** - `cd app; npx vitest run test/sendReconcile.test.ts test/retrySendAttempt.test.ts`.

- [ ] **Step 4: Insert the calls**

`sendReconcile.ts`:

```ts
// Ctx (:325-335) gains: listingSends: ListingSendsRepo (built lazily beside the others in the handler from deps.listingSendsRepo)
function shareDeps(c: Ctx): ShareAttemptOutcomeDeps {
  return { broadcasts: c.broadcasts, ledger: { listingSends: c.listingSends, log: c.log }, events: c.events, log: c.log };
}
// shareAttemptOutcome.ts gains:
export async function applyLaterAttemptBounded(deps: ShareAttemptOutcomeDeps, input: LaterAttempt): Promise<ApplyResult | 'threw'> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await applyLaterAttempt(deps, input); } catch (err) { last = err; }
  }
  deps.log.error({ err: last, broadcastId: input.broadcastId, conversationId: input.conversationId, retryRoot: input.retryRoot, attempt: input.attemptKey }, 'share slot write failed after retries (best-effort; the repair heals it)');
  return 'threw';
}
// found arm (:541-558), before :542:
      if (r.owner.kind === 'retry_send' && r.row !== undefined && typeof r.row.broadcast_id === 'string' && verdict.tsMsgId !== undefined) {
        const applied = await applyLaterAttemptBounded(shareDeps(c), {
          broadcastId: r.row.broadcast_id, conversationId: r.owner.conversationId, retryRoot: r.owner.retryRoot,
          attemptKey: verdict.tsMsgId, outcome: mapAdopted(verdict),
          ...(verdict.recipientContactId !== undefined && { recipientContactId: verdict.recipientContactId }),
        });
        if (applied === 'no_broadcast') c.log.warn({ ...base, broadcastId: r.row.broadcast_id }, 'send.reconcile: broadcast not found for an adopted share retry - slot not written');
      }
// Found gains: tsMsgId?: string; errorCode?: string; carrierSentAt?: string; recipientContactId?: string
//   - adoptRetry sets them from the appended (or deduped, re-read) row and the provider message (carrierSentAt = m.dateSent as the share adoption maps it);
//   - ownRetryRow sets tsMsgId from the pointer, errorCode / recipientContactId / carrierSentAt from the pointer's row read.
// closeSlot retry_send arm (:1366): the WITHDRAW as built (first), then:
      if (code === SEND_UNCONFIRMED_CODE && r.row !== undefined && typeof r.row.broadcast_id === 'string') {
        await applyLaterAttemptBounded(shareDeps(c), {
          broadcastId: r.row.broadcast_id, conversationId: r.owner.conversationId, retryRoot: r.owner.retryRoot,
          attemptKey: rowlessAttemptKey(r.owner.retriedTsMsgId), outcome: { kind: 'unresolved' },
          ...(r.row.recipient_contact_id !== undefined && { recipientContactId: r.row.recipient_contact_id }),
        });
      }
```

`retrySend.ts`:

```ts
// deps: + broadcastsRepo?: BroadcastsRepo; listingSendsRepo?: ListingSendsRepo;  (built lazily in the handler like contactsRepo, :390-401's idiom; shareOutcome = { broadcasts, ledger: { listingSends, log }, events, log })
async function markShareUnconfirmed(): Promise<void> {
  if (typeof retried.broadcast_id !== 'string') return;
  await guardWrite(log, octx, 'shareSlotUnconfirmed', () =>
    applyLaterAttempt(shareOutcome, {
      broadcastId: retried.broadcast_id!, conversationId: owner.conversationId, retryRoot: owner.retryRoot,
      attemptKey: rowlessAttemptKey(owner.retriedTsMsgId), outcome: { kind: 'unresolved' },
      ...(retried.recipient_contact_id !== undefined && { recipientContactId: retried.recipient_contact_id }),
    }));
}
// onUnknown (:859): `await markShareUnconfirmed();` as the FIRST statement of the secondUnknownWouldClose branch, before finish(...)
// handOff catch (:798): `await markShareUnconfirmed();` as the FIRST statement of the catch, before guardWrite(closeFromReconcile)
```

The import cycle note (`sendReconcile.ts:43-47`) is respected: `shareAttemptOutcome.ts` imports no job module.

- [ ] **Step 5: Run the suites, the smoke, typecheck** - `cd app; npx vitest run test/sendReconcile.test.ts test/retrySendAttempt.test.ts test/retryChain.test.ts` PASS; from the root `npm run typecheck` (exit 0) and `npm run smoke` (exit 0).

- [ ] **Step 6: Commit**

```bash
git status
git add app/src/services/shareAttemptOutcome.ts app/src/jobs/sendReconcile.ts app/src/jobs/retrySend.ts app/test/shareAttemptOutcome.test.ts app/test/sendReconcile.test.ts app/test/retrySendAttempt.test.ts
git commit -m "feat(retry): a share retry's outcome reaches its slot from the adoption (before the record close) and from all four unresolved-end sites (slot first and guarded at the job's arms; after the WITHDRAW and bounded at the reconcile's) (share-sent-outcome T6)"
```

---

### Task 7: `recordPropertySent` writes a ledger ENTRY and a milestone with its share id; the share adoption follows

Built SECOND in Slice 2 (after Task 4, before Task 5).

**Files:**
- Modify: `app/src/repos/activityEventsRepo.ts` (`RecordActivityEventInput` :86-94, `ActivityEventItem` :65-82, `record` :125-148)
- Modify: `app/src/jobs/broadcastFanOut.ts` (`recordPropertySent` :1202-1252; its callers `afterSend` :817-832 and the adoption :1456-1468)
- Modify: `app/src/repos/listingSendsRepo.ts` (DELETE `recordSend` :136-178 and its interface entry - Task 3 deprecated it; no runtime caller remains), `app/test/helpers/twilioWebhookHarness.ts` (the activity-events double :3056-3073 passes `broadcastId` through; the ledger double drops `recordSend`)
- Test: `app/test/broadcastFanOut.test.ts` (the ledger pins :979-1054 and :2510), `app/test/listingSendsRepo.integration.test.ts` (:56-150 - the `recordSend` cases are REWRITTEN as `putShareMemory` cases or dropped where Task 3's new file already covers them), `app/test/listingSendsApi.test.ts` (20 `recordSend` calls) and `app/test/contactsBatchReads.test.ts:151` - both seed through a new test helper `seedListingSend(repo, { unitId, contactId, sentAt, broadcastId? })` in `app/test/helpers/listingSendSeed.ts` that calls `putShareMemory` with one counted entry

**Interfaces:**
- Consumes: `applyShareLedgerEntry`, `ledgerEntryFor` (Task 3); the pass's recorded slot (`record phase` :931-959 writes `conversationId` + `tsMsgId` on the slot BEFORE `afterSend` runs at :949 - read it and take the appended row's `tsMsgId` from that scope); the adoption's row (`adoptBroadcastRecipient` has the adopted message: its `tsMsgId`, `delivery_status`).
- Produces: `RecordActivityEventInput.broadcastId?: string`, stored as `broadcastId` on the item (a plain attribute; the SK and the projection are unchanged); the harness double stores it too. `recordPropertySent(repos, log, ctx, args)` gains `args.attempt: { tsMsgId: string; conversationId: string; outcome: 'accepted' | 'delivered' }`: the milestone is recorded with `broadcastId: args.broadcastId` (timing unchanged: at acceptance); the ledger write becomes `applyShareLedgerEntry(...)` with `ledgerEntryFor(attempt.tsMsgId, attempt.conversationId, { kind: attempt.outcome })` - `accepted` for the pass, `delivered` for an adoption of a delivered row, `accepted` for an adopted sent row. Best-effort as today (ERROR, never fails the send). `recordSend` is deleted: the ONE ledger writer is `putShareMemory` through `applyShareLedgerEntry`.

- [ ] **Step 1: Adjust the fan-out pins and add cases**

In `app/test/broadcastFanOut.test.ts` (read :979-1054 first):

```ts
  it('after a recorded send the ledger row carries a counted-by-acceptance entry for THIS share and the milestone carries the share id', async () => {
    await runPass(/* one recipient, the adapter accepts */);
    const row = await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1');
    expect(row).toMatchObject({ counted: true, broadcastId: 'b-1' });
    expect(row?.shares?.['b-1']).toMatchObject({ state: 'counted', by: 'acceptance', conversationId: 'conv-1' });
    const milestone = (await world.activityEventsRepo.listByContact('c-1')).items.find((e) => e.type === 'listing_sent');
    expect(milestone).toMatchObject({ label: 'Property sent', refType: 'unit', refId: 'unit-1', broadcastId: 'b-1' });
  });
  it('a failure callback that landed first (a failed entry on the row) is not overwritten by the pass''s acceptance for the same attempt', async () => {
    // seed the ledger row with shares['b-1'] = { attempt: ROOT, state: 'failed' } through putShareMemory, then run the pass whose appended row is ROOT
    await runPass(/* ... */);
    expect((await world.listingSendsRepo.getByKeyConsistent('unit-1', 'c-1'))?.shares?.['b-1']?.state).toBe('failed');
  });
  it('the adoption of a DELIVERED row counts the entry by delivery; of a SENT row by acceptance; a failed adopted row writes no property rows (as today)', async () => {
    // the existing adoption fixtures at :1456-1468's tests
  });
```

The pins at :996, :1009, :1028, :1042 and :2510 (rows before the record close) keep their assertions but read `shares`/`counted` where they read `sentAt`/`broadcastId` (`sentAt` is still set on a counted row, at the attempt's provider instant). The swallowed-ledger pin at :1054-1083 stubs `recordSend` to throw and matches "listing-send row failed": REWRITE it to stub `world.listingSendsRepo.putShareMemory` (throw) and match `recording listing-send entry failed` - the swallow is still the contract.

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/broadcastFanOut.test.ts`.

- [ ] **Step 3: Edit the repo input and the fan-out**

`activityEventsRepo.ts`: `broadcastId?: string` on both types; `record` stores `...(input.broadcastId !== undefined && { broadcastId: input.broadcastId })`.

`broadcastFanOut.ts`:

```ts
async function recordPropertySent(
  repos: { activityEvents: ActivityEventsRepo; listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'> },
  log: Logger, ctx: Record<string, unknown>,
  args: { contactId: string; unitId: string | undefined; broadcastId: string; attempt: { tsMsgId: string; conversationId: string; outcome: 'accepted' | 'delivered' } },
): Promise<void> {
  const unitId = args.unitId;
  const hasUnit = typeof unitId === 'string' && unitId.length > 0;
  try {
    await repos.activityEvents.record({
      contactId: args.contactId, type: 'listing_sent', label: 'Property sent',
      refType: hasUnit ? 'unit' : 'broadcast', refId: hasUnit ? unitId : args.broadcastId,
      broadcastId: args.broadcastId,   // share-sent-outcome D6: the timeline reads this milestone's words from the ledger entry of THIS share
    });
  } catch (milestoneErr) {
    log.error({ err: milestoneErr, ...ctx }, 'broadcastFanOut: recording listing_sent milestone failed (best-effort)');
  }
  if (hasUnit) {
    try {
      // share-sent-outcome D7: an ENTRY for this attempt, not a blind upsert - a
      // failure callback that landed first is not overwritten (the order rule),
      // and the pair's sentAt is the attempt's own provider instant.
      await applyShareLedgerEntry({ listingSends: repos.listingSends, log }, {
        unitId, contactId: args.contactId, broadcastId: args.broadcastId,
        entry: ledgerEntryFor(args.attempt.tsMsgId, args.attempt.conversationId, { kind: args.attempt.outcome }),
      });
    } catch (sendErr) {
      log.error({ err: sendErr, ...ctx }, 'broadcastFanOut: recording listing-send entry failed (best-effort)');
    }
  }
}
```

Callers: `afterSend` (:817-832) passes `attempt: { tsMsgId: <the appended row's tsMsgId>, conversationId, outcome: 'accepted' }`; the adoption (:1456-1468) passes the adopted row's `tsMsgId` and `outcome: rowStatus === 'delivered' ? 'delivered' : 'accepted'`. The fan-out's deps type for `listingSends` narrows to the two methods (the harness double has them from Task 3). Delete `recordSend` from the repo interface, the implementation and the harness double; rewrite `listingSendsRepo.integration.test.ts:56-150` (its upsert cases become `putShareMemory` create/refresh cases; the `listByUnit` / `listByContact` ordering cases seed through `putShareMemory`). The activity-events double (:3056-3073) stores `broadcastId` when present.

- [ ] **Step 4: Run and typecheck** - `cd app; npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts test/listingSendsApi.test.ts test/listingSendsRepo.integration.test.ts test/seedHistory.test.ts` PASS; `npm run typecheck` exit 0 (`grep -rn recordSend app dashboard e2e` shows nothing). (`sendReconcile.test.ts`'s property-row pins at :385-387, :429-430, :456-457, :1826-1827, :1844-1854, :1898-1899 read the row's `sentAt`/`broadcastId`: still set on a counted row, now at the attempt's instant - update an assertion that pinned "now".)

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/repos/activityEventsRepo.ts app/src/jobs/broadcastFanOut.ts app/src/repos/listingSendsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/helpers/listingSendSeed.ts app/test/broadcastFanOut.test.ts app/test/listingSendsRepo.integration.test.ts app/test/listingSendsApi.test.ts app/test/contactsBatchReads.test.ts
git commit -m "feat(broadcasts): the pass and the adoption write a ledger ENTRY (counted by acceptance or delivery) and a milestone carrying its share id; recordSend retired (share-sent-outcome T7)"
```

---

### Task 8: The composer flag reads the SAFE state (D1) - the preview route, the repo method retired, the pins rewritten

**Files:**
- Modify: `app/src/routes/broadcasts.ts` (deps :69-78; the preview's prior set :516-549)
- Modify: `app/src/routes/api.ts` (:1029-1043 - forward `messagesRepo` and `sendAttemptsRepo` to the broadcasts router)
- Modify: `app/src/repos/broadcastsRepo.ts` (DELETE `priorRecipientContactIds` :702-745 and its interface entry :389-399), `app/test/helpers/twilioWebhookHarness.ts` (DELETE the mirror :3367-3380)
- Test: `app/test/broadcastApi.test.ts` (:1088, :1118, :1154, :1183, :1207), `app/test/broadcastsRepo.integration.test.ts` (:298, :347, :359 - the repo cases MOVE to the service test or are deleted with the method)

**Interfaces:**
- Consumes: `priorRecipientKeys` (Task 2).
- Produces: `BroadcastsRouterDeps` gains `messagesRepo?: MessagesRepo` and `sendAttemptsRepo?: SendAttemptsRepo` (resolved with the router's other defaults); the preview calls `priorRecipientKeys({ broadcasts, messages, attempts, log }, broadcast.unitId)`; the per-candidate flag (`alreadySentThisProperty`, :547-549) and the response field (`priorRecipientContactIds`, :569) are unchanged in shape. `api.ts` forwards the two repos exactly as it forwards `contactsRepo` (`:1029-1043`).

- [ ] **Step 1: Rewrite the route pins**

In `app/test/broadcastApi.test.ts` (read the fixtures around :1080-1220 first):

```ts
  it('is set by a prior share whose recipient REACHED (sent, delivered) and by one still in flight in a sending share', async () => { /* the :1088 case, extended with a queued slot in a sending share */ });
  it('is set for a tenant whose failed 30003 text carries a live retry promise (the safe reading)', async () => {
    // fixture: a prior share (any stored status) with slot c-1 failed 30003 on ROOT, ROOT's row retry_due_at = now + 5 min
    expect(preview.candidates.find((c) => c.contactId === 'c-1')?.alreadySentThisProperty).toBe(true);
  });
  it('is set for a Not-confirmed slot even when the share finalized failed (closes unconfirmed-share-invites-resend)', async () => { /* slot failed send_unconfirmed in a stored-failed share */ });
  it('is NOT set for a final failure: a 30007 failure, a 30003 whose promise lapsed, a 30003 whose chain ended unresolved-then-lapsed is Not confirmed instead', async () => {
    // three slots; assert false, false, true respectively
  });
  it('is NOT set by a prior DRAFT (queued slots, no record) nor by a FAILED share whose queued slots have no record (stranded); IS set for a failed share''s queued slot that has a live record', async () => {
    // seed an attempting record for one slot through world.sendAttemptsRepo (owner { kind: 'broadcast', broadcastId, contactKey })
  });
  it('a failed row read never empties the set (the safe direction)', async () => {
    world.messagesRepo.getByTsMsgIdConsistent = async () => { throw new Error('boom'); };
    // the pending tenant is still flagged; a reached tenant in the same share is still flagged
  });
```

The :1118 (phone# key) and :1154 (no unitId) cases keep; :1207 ("a failed one still is") is REPLACED by the final-failure case above. In `app/test/broadcastsRepo.integration.test.ts` delete the whole `priorRecipientContactIds` describe block (it starts at :298 and its third case at :359 runs past :370 - delete to the block's closing brace, not to a line number); its "unions sent/sending only" premise no longer exists.

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/broadcastApi.test.ts`.

- [ ] **Step 3: Edit the route, the deps, delete the repo method and its mirror**

```ts
// routes/broadcasts.ts :516-524 becomes:
    const priorRecipients =
      broadcast.unitId !== undefined
        ? await priorRecipientKeys({ broadcasts, messages, attempts, log }, broadcast.unitId)
        : new Set<string>();
// deps: messagesRepo?: MessagesRepo; sendAttemptsRepo?: SendAttemptsRepo; resolved:
//   const messages = deps.messagesRepo ?? createMessagesRepo({ ... the router's default-construction idiom ... });
//   const attempts = deps.sendAttemptsRepo ?? createSendAttemptsRepo({ ... });
```

Delete `priorRecipientContactIds` from the repo (:389-399, :702-745) and the harness (:3367-3380); `grep -rn priorRecipientContactIds app dashboard e2e` must show only the wire field name in the preview response and the dashboard's use of it.

- [ ] **Step 4: Run, typecheck** - `cd app; npx vitest run test/broadcastApi.test.ts test/broadcastsRepo.integration.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts` PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/broadcasts.ts app/src/routes/api.ts app/src/repos/broadcastsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/broadcastApi.test.ts app/test/broadcastsRepo.integration.test.ts
git commit -m "feat(broadcasts): the review list's Already sent flag reads the SAFE recipient state (priorRecipientKeys); the repo's interim rule and its mirror retired (share-sent-outcome T8)"
```

---

### Task 9: The results and list routes - per-recipient promise fields, `retry_pending`, `?view=stats`

**Files:**
- Modify: `app/src/routes/broadcasts.ts` (`EnrichedRecipient` :196-200, `enrichRecipients` :223-258, `toBroadcastResults` :280-298, `toBroadcastSummary` :301-315, the list route :803-840, the results route :786-797)
- Test: `app/test/broadcastApi.test.ts` (:1247, :1285 results/list cases; new cases)

**Interfaces:**
- Consumes: `resolveRecipientStates`, `retryPendingCount` (Task 2); `deriveBroadcastStats(b, { retryPending })` (Task 1); the router deps from Task 8.
- Produces:
  - Results: for each recipient, the wire slot gains `retryDueAt?`, `retryOutcome?`, `latestAttempt?` from the state map (only when present); `stats` = `deriveBroadcastStats(broadcast, { retryPending: retryPendingCount(states), unconfirmedKeys: unconfirmedByRow(states, broadcast) })` (the count is ALWAYS present on the results and list payloads - the routes are the truth; a slot whose row says its chain ended unresolved counts as Not confirmed, not Failed). Query `?view=stats` (the only accepted value; anything else is 400 `invalid_view`) returns `{ broadcastId, status, unitId, stats, created_at }` with NO `recipients` and NO contact reads (the `enrichRecipients` BatchGet at :231 is skipped); the state resolution runs WITHOUT record reads (`resolveRecipientStates(deps, b)` - the default; only young failed-30003 slots read a row, 8 at a time).
  - List: each summary's `stats` carries `retry_pending` AND the same `unconfirmedKeys` re-bucketing (one `resolveRecipientStates` per row, no record reads; a page of finished shares with no young 30003 slots costs no extra read), so the list and the results page agree on Not confirmed. The pin `broadcastApi.test.ts:1271-1282` (`toEqual` on the results stats) is REWRITTEN to include `retry_pending: 0`.
  - Per recipient the results payload also carries `retryPending: true` when the D1 state is `pending` (deviation 14) - a recipient whose row read failed is pending with no `retryDueAt`, and the page's ticker recount must still count it.

- [ ] **Step 1: Write the failing route tests**

In `app/test/broadcastApi.test.ts`:

```ts
  it('results: a failed-30003 recipient whose row holds a live promise carries retryDueAt and latestAttempt, and stats.retry_pending counts it', async () => {
    // fixture: share b-1, slot c-1 failed 30003 on ROOT with latestAttempt RETRY; RETRY row retry_due_at = now + 5 min
    const res = await request(app).get('/api/broadcasts/b-1/results');
    expect(res.status).toBe(200);
    expect(res.body.recipients['c-1']).toMatchObject({ status: 'failed', errorCode: '30003', retryDueAt: expect.any(String), latestAttempt: RETRY });
    expect(res.body.stats).toMatchObject({ failed: 1, retry_pending: 1 });
  });
  it('results: a recipient whose chain ended unresolved carries retryOutcome unconfirmed, is counted in stats.unconfirmed (not failed), and has no live promise; an old 30003 failure carries neither (no read)', async () => {
    // fixture: slot c-1 failed 30003 on ROOT whose row carries retry_outcome unconfirmed + the withdrawn sentinel; slot c-2 failed 30003 on a 40-minute-old row
    const res = await request(app).get('/api/broadcasts/b-2/results');
    expect(res.body.recipients['c-1']).toMatchObject({ retryOutcome: 'unconfirmed' });
    expect(res.body.recipients['c-1'].retryDueAt).toBeUndefined();
    expect(res.body.recipients['c-2'].retryOutcome).toBeUndefined();
    expect(res.body.stats).toMatchObject({ failed: 1, unconfirmed: 1, retry_pending: 0 });
  });
  it('results and list read NO send-attempt records (the composer flag alone reads them)', async () => {
    const reads = vi.spyOn(world.sendAttemptsRepo, 'get');
    await request(app).get('/api/broadcasts/b-1/results');
    await request(app).get('/api/broadcasts');
    expect(reads).not.toHaveBeenCalled();
  });
  it('results ?view=stats returns the share and its stats with retry_pending, no recipients, and reads no contacts', async () => {
    const res = await request(app).get('/api/broadcasts/b-1/results?view=stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ broadcastId: 'b-1', status: 'sent', stats: { retry_pending: 1 } });
    expect(res.body.recipients).toBeUndefined();
    expect(contactReads).toBe(0);   // instrument world.contactsRepo.getDisplaysByIds
  });
  it('results ?view=other is 400 invalid_view', async () => { /* ... */ });
  it('list: every summary carries stats.retry_pending (0 when nothing is pending)', async () => {
    const res = await request(app).get('/api/broadcasts');
    expect(res.body.broadcasts.every((b: { stats: { retry_pending?: number } }) => typeof b.stats.retry_pending === 'number')).toBe(true);
  });
```

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/broadcastApi.test.ts`.

- [ ] **Step 3: Edit the routes**

```ts
// results route (:786-797):
  router.get('/broadcasts/:broadcastId/results', async (req, res) => {
    const { broadcastId } = req.params;
    const view = req.query['view'];
    if (view !== undefined && view !== 'stats') { res.status(400).json({ error: 'invalid_view' }); return; }
    const broadcast = await broadcasts.getById(broadcastId);
    if (!broadcast) { res.status(404).json({ error: 'broadcast_not_found' }); return; }
    const states = await resolveRecipientStates({ messages, attempts, log }, broadcast);   // no record reads here (deviation 12)
    const stats = deriveBroadcastStats(broadcast, { retryPending: retryPendingCount(states), unconfirmedKeys: unconfirmedByRow(states, broadcast) });
    if (view === 'stats') { res.json(toBroadcastStatsView(broadcast, stats)); return; }
    const recipients = await enrichRecipients(contacts, broadcast.recipients ?? {}, states);
    res.json(toBroadcastResults(broadcast, recipients, stats));
  });
// enrichRecipients gains `states?: Map<string, ClassifiedRecipient>` and spreads
// retryDueAt / retryOutcome / latestAttempt from states.get(key) onto each EnrichedRecipient
// (EnrichedRecipient :196-200 gains the three optional fields).
// toBroadcastResults(b, recipients, stats) uses the supplied stats; toBroadcastStatsView(b, stats):
function toBroadcastStatsView(b: BroadcastItem, stats: BroadcastStats): Record<string, unknown> {
  return { broadcastId: b.broadcastId, status: b.status, unitId: b.unitId ?? null, stats, created_at: b.created_at };
}
// enrichRecipients also sets `retryPending: true` on a recipient whose state is 'pending'.
// list route (:831-834): per item,
//   const states = await resolveRecipientStates({ messages, attempts, log }, b);
//   toBroadcastSummary(b, deriveBroadcastStats(b, { retryPending: retryPendingCount(states), unconfirmedKeys: unconfirmedByRow(states, b) }))
// toBroadcastSummary(b, stats) takes the stats instead of deriving them.
```

The per-row state resolution on the list reads nothing for a share with no young failed-30003 slot and no queued slot in a finished share (Task 2's bounds); a 50-row page of ordinary shares costs the same as today.

- [ ] **Step 4: Run, typecheck** - `cd app; npx vitest run test/broadcastApi.test.ts` PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/broadcasts.ts app/test/broadcastApi.test.ts
git commit -m "feat(broadcasts): results carry each recipient's promise facts and the true retry_pending; ?view=stats skips the recipient list; the list carries retry_pending (share-sent-outcome T9)"
```

---

### Task 10: The dashboard - types, the label table (D4), the chips, the badge's reason and the hint (D3), the ticker, the hook merges

**Files:**
- Modify: `dashboard/src/api/types.ts` (`BroadcastStats` :2965-2987, `BroadcastRecipient` :3020-3042, `BroadcastRecipientView` :3064-3080, `BroadcastUpdatedEvent` :3119-3127), `dashboard/src/api/endpoints.ts` (`getBroadcastResults` :1876-1885; new `getBroadcastStats`)
- Modify: `dashboard/src/routes/broadcasts/broadcastFormat.ts` (`presentShareLabel` :97-105; `shareRecipientReason` :162-172; `toRecipientViews` :193-222), `DeliveryBadge.tsx` (props :20-31, the call at :34-37 - the ONLY caller of `shareRecipientReason`), `StatChips.tsx` (:24-28 the `Chip.tone` type, :30-40 the chips, plus its CSS module for a `progress` tone), `BroadcastResults.tsx` (:48-76 the row; :146 the pill; the `last_error` alert), `BroadcastsList.tsx` (:144), `useBroadcastResults.ts` (:118-138), `useBroadcastsList.ts` (:111-124)
- Test: `broadcastFormat.test.ts` (:185, :214-231, :241-247), `StatChips.test.tsx` (:33-147 chips, :250 pill; :177-181 is a DeliveryBadge render test - it moves with the badge), `DeliveryBadge.test.tsx` (create if absent; else extend), `BroadcastResults.test.tsx` (:139, :160, :227), `useBroadcastResults.test.tsx` (:70-160), `BroadcastsList.test.tsx` (:69; new SSE cases)

**Interfaces:**
- Consumes: `deliveryReason(errorCode, { retryScheduled, retryUnconfirmed })` (`deliveryStatus.ts:1157-1205`), `isRetryPromiseLive` + `RETRY_OUTCOME_UNCONFIRMED` (`retryPromise.ts:33`, `:43-48`), `serverNowMs` (`api/serverClock.ts:47`), the Timeline ticker precedent (`Timeline.tsx:756`, `:2218-2248`), `skippedTotal` (:113-115).
- Produces:
  - Types: `BroadcastStats.retry_pending?: number` (the bucket-sum comment :2960-2964 says it is a SUB-bucket of failed, never in the sum); `BroadcastRecipient` and `BroadcastRecipientView` gain `tsMsgId?` (the view drops it today - keep it), `retryDueAt?`, `retryOutcome?`, `latestAttempt?`; `getBroadcastStats(id)` = GET `/api/broadcasts/:id/results?view=stats` returning `{ broadcastId, status, unitId, stats, created_at }`.
  - `presentShareLabel(status, stats)`: `draft` and `sending` keep the stored label/tone; for `sent` or `failed` with `stats`: `delivered + sent + (sending ?? 0) > 0` -> `{ 'Sent', 'positive' }`; else `(retry_pending ?? 0) > 0` -> `{ 'Sending', 'progress' }`; else `(unconfirmed ?? 0) > 0` -> `{ 'Not confirmed', 'danger' }`; else `{ 'Not sent', audience > 0 && skippedTotal(stats) >= audience ? 'neutral' : 'danger' }`; no stats -> the stored label. `Failed` is no longer produced for a finished share.
  - `StatChips`: `Chip.tone` gains `'progress'` with a CSS class; `Failed` = `Math.max(0, failed - (retry_pending ?? 0))`; a `Retrying` chip (`retry_pending ?? 0`, tone `progress`) after Failed; the balance note (:1-11) names the sub-bucket.
  - `shareRecipientReason(status, errorCode, opts?: { retryDueAt?, retryOutcome?, serverNowMs })`: a failed row calls `deliveryReason(errorCode, { retryScheduled: opts !== undefined && isRetryPromiseLive(opts.retryDueAt, opts.serverNowMs), retryUnconfirmed: opts?.retryOutcome === RETRY_OUTCOME_UNCONFIRMED })`.
  - `DeliveryBadge` props gain `retryDueAt?`, `retryOutcome?`, `serverNowMs?` and pass them to `shareRecipientReason`; `RecipientRow` passes them from the view plus the page's clock snapshot.
  - The row's hint: `failed && errorCode !== SEND_UNCONFIRMED_CODE && retryOutcome !== 'unconfirmed' && contactId !== undefined && (tsMsgId !== undefined || latestAttempt !== undefined) && !isRetryPromiseLive(retryDueAt, serverNowMs)`; the copy line :74 is re-worded ASCII-safe (`open conversation to retry`, no glyph).
  - `BroadcastResults` snapshots `serverNowMs()` in state and re-judges every 60 s while visible (the Timeline's `STALE_TICK_MS` pattern, :2218-2248). ONLY on a tick (never on an SSE overlay, never before the first refetch) the page recounts `retry_pending` from its rows: `rows.filter(r => r.retryPending === true && (r.retryDueAt === undefined || isRetryPromiseLive(r.retryDueAt, serverNowMs))).length` (deviation 14: a row the route marked pending with no due instant - its row read failed - stays counted), stored as a `tickCount` state that overrides `stats.retry_pending` for the pill and the chips until the next payload replaces the stats (a payload clears the override). So between an SSE event and its refetch the event's count stands (no Not sent flash), and a promise that lapses with no event moves the header at the next tick as it moves the row. The `last_error` alert renders only when the pill reads `Not sent`.
  - `useBroadcastResults`: the overlay merges `stats: { ...e.stats, ...(e.stats.retry_pending === undefined && prev.stats.retry_pending !== undefined && { retry_pending: prev.stats.retry_pending }) }`; the debounced refetch (already there) replaces it with the route's truth.
  - `useBroadcastsList`: the patch merges the same way; and when `e.stats.retry_pending === undefined && (row.stats.retry_pending ?? 0) > 0 && (e.status === 'sent' || e.status === 'failed')`, schedules ONE debounced (400 ms, per row) `getBroadcastStats(e.broadcastId)` whose result replaces the row's `status` + `stats`; a row not on the page is ignored; a share stored `sending` never refetches.

- [ ] **Step 1: Rewrite the pins and add the cases** (dashboard workspace; read each file's fixtures first)

`broadcastFormat.test.ts` - the `presentShareLabel` block at :214-231 and the D22 block at :241-247. Three pins FLIP under the new rule and are rewritten: `:224` (`sent`, audience 2, skipped_other 1, failed 1 - nothing reached) -> `Not sent` / `danger`; `:228` (`sent`, `stats()` - audience 0, nothing reached) -> `Not sent` / `danger`; `:242` (`sent`, skipped 1 + unconfirmed 1) -> `Not confirmed` / `danger`. `:223` (delivered 1) keeps `Sent`; `:226` (`failed`, failed 1) -> `Not sent` / `danger`; `:225`/`:227`/`:229` (`sending`, `draft`, no stats) keep. Add: none reached + `retry_pending` 1 -> `Sending` / `progress`; all queued in a stored-failed share -> `Not sent` / `danger`; `shareRecipientReason` with a live promise reads RSW's "will retry" copy, with `retryOutcome` unconfirmed reads the unconfirmed copy, with a lapsed promise the plain 30003 copy (:185 is the pin that flips).
`StatChips.test.tsx`: the order pin :77 gains `Retrying` after `Failed`; the sum pin balances (`Failed + Retrying = failed`); add: `retry_pending` 1 with `failed` 1 renders Failed 0 + Retrying 1; a kept `retry_pending` above `failed` clamps Failed at 0. The DeliveryBadge render test at :177-181 (a 30003 row promises nothing) MOVES to `DeliveryBadge.test.tsx` and gains: with `retryDueAt` live it reads the "will retry" copy; with `retryOutcome` unconfirmed the unconfirmed copy; lapsed the plain copy.
`BroadcastResults.test.tsx`: :139 (hint on a keyless failed row) flips to NO hint; add: hint on a failed row with a message id and no promise; no hint with a live promise (fake `serverNowMs`); no hint on `retryOutcome` unconfirmed; the ticker: advance 60 s past the promise and the hint appears AND the pill moves from `Sending` to `Not sent` with the Retrying chip at 0 (the recount); an SSE overlay with `retry_pending: 1` arriving before the refetch keeps `Sending` (no recount until a tick); a row with `retryPending: true` and no `retryDueAt` is still counted on a tick; `last_error` shown only under `Not sent`; :160, :227 keep.
`useBroadcastResults.test.tsx`: an event without `retry_pending` keeps the previous value until the refetch replaces it.
`BroadcastsList.test.tsx`: an event without `retry_pending` on a `sent` row with `retry_pending` 1 triggers one `getBroadcastStats` call (mock the endpoint) and the row takes its result; the same event on a `sending` row triggers none; an event WITH `retry_pending` replaces without a fetch; two events inside 400 ms trigger one fetch.

- [ ] **Step 2: Run to see the reds** - `cd dashboard; npx vitest run src/routes/broadcasts`.

- [ ] **Step 3: Implement**

```ts
// broadcastFormat.ts
export function presentShareLabel(status: BroadcastStatus, stats?: BroadcastStats): { label: string; tone: BroadcastStatusTone } {
  if ((status === 'sent' || status === 'failed') && stats !== undefined) {
    if (stats.delivered + stats.sent + (stats.sending ?? 0) > 0) return { label: 'Sent', tone: 'positive' };
    if ((stats.retry_pending ?? 0) > 0) return { label: 'Sending', tone: 'progress' };
    if ((stats.unconfirmed ?? 0) > 0) return { label: 'Not confirmed', tone: 'danger' };
    const allSkipped = stats.audience > 0 && skippedTotal(stats) >= stats.audience;
    return { label: 'Not sent', tone: allSkipped ? 'neutral' : 'danger' };
  }
  return { label: BROADCAST_STATUS_LABELS[status], tone: BROADCAST_STATUS_TONE[status] };
}
export interface RecipientReasonOptions { retryDueAt?: string; retryOutcome?: string; serverNowMs: number }
export function shareRecipientReason(status: BroadcastRecipient['status'], errorCode: string | undefined, opts?: RecipientReasonOptions): string | undefined {
  if (status === 'skipped') return shareSkipReason(errorCode);
  if (status === 'failed') {
    if (errorCode === 'no_contact') return 'No contact or phone on file';
    return deliveryReason(errorCode, {
      retryScheduled: opts !== undefined && isRetryPromiseLive(opts.retryDueAt, opts.serverNowMs),
      retryUnconfirmed: opts?.retryOutcome === RETRY_OUTCOME_UNCONFIRMED,
    }) ?? 'Delivery failed';
  }
  return undefined;
}
// DeliveryBadge.tsx: props + { retryDueAt?: string; retryOutcome?: string; serverNowMs?: number };
//   const reason = shareRecipientReason(status, errorCode, serverNowMs !== undefined ? { retryDueAt, retryOutcome, serverNowMs } : undefined);
// StatChips.tsx: type Chip = { label: string; value: number; tone?: 'success' | 'danger' | 'progress' };  chips:
//   { label: 'Failed', value: Math.max(0, stats.failed - (stats.retry_pending ?? 0)), tone: 'danger' },
//   { label: 'Retrying', value: stats.retry_pending ?? 0, tone: 'progress' },
// BroadcastResults.tsx: const [serverNow, setServerNow] = useState(() => serverNowMs()); const [tickCount, setTickCount] = useState<number | undefined>(undefined);
//   a visibility-gated 60 s interval: const now = serverNowMs(); setServerNow(now); setTickCount(rows.filter((r) => r.retryPending === true && (r.retryDueAt === undefined || isRetryPromiseLive(r.retryDueAt, now))).length);
//   an effect on `results` (every payload, SSE overlay or refetch) does setTickCount(undefined);
//   const liveStats = results === null ? null : tickCount === undefined ? results.stats : { ...results.stats, retry_pending: tickCount };
//   the pill (:146) and <StatChips stats={liveStats} /> read liveStats; RecipientRow gets serverNow. BroadcastRecipientView gains retryPending?: boolean (from the wire).
// useBroadcastsList.ts onBroadcastUpdated:
    (e) => {
      setRows((prev) => prev.map((r) => {
        if (r.broadcastId !== e.broadcastId) return r;
        const kept = e.stats.retry_pending === undefined && r.stats.retry_pending !== undefined ? { retry_pending: r.stats.retry_pending } : {};
        return { ...r, status: e.status, stats: { ...e.stats, ...kept } };
      }));
      const row = rowsRef.current.find((r) => r.broadcastId === e.broadcastId);
      if (row !== undefined && e.stats.retry_pending === undefined && (row.stats.retry_pending ?? 0) > 0 && (e.status === 'sent' || e.status === 'failed')) {
        scheduleStatsRefetch(e.broadcastId);   // per-row 400 ms debounce -> getBroadcastStats -> setRows(replace status + stats)
      }
    }
```

`rowsRef` mirrors `rows` (a `useRef` kept in sync in an effect) so the handler reads the latest value without re-subscribing; `scheduleStatsRefetch` keeps a `Map<string, timeout>` in a ref and clears it on unmount.

- [ ] **Step 4: Run the dashboard suites, typecheck** - `cd dashboard; npx vitest run src/routes/broadcasts src/api` PASS; `npm run typecheck` exit 0. Every touched copy line ASCII.

- [ ] **Step 5: Commit**

```bash
git status
git add dashboard/src/api/types.ts dashboard/src/api/endpoints.ts dashboard/src/routes/broadcasts/broadcastFormat.ts dashboard/src/routes/broadcasts/DeliveryBadge.tsx dashboard/src/routes/broadcasts/StatChips.tsx dashboard/src/routes/broadcasts/StatChips.module.css dashboard/src/routes/broadcasts/BroadcastResults.tsx dashboard/src/routes/broadcasts/BroadcastsList.tsx dashboard/src/routes/broadcasts/useBroadcastResults.ts dashboard/src/routes/broadcasts/useBroadcastsList.ts dashboard/src/routes/broadcasts/broadcastFormat.test.ts dashboard/src/routes/broadcasts/DeliveryBadge.test.tsx dashboard/src/routes/broadcasts/StatChips.test.tsx dashboard/src/routes/broadcasts/BroadcastResults.test.tsx dashboard/src/routes/broadcasts/useBroadcastResults.test.tsx dashboard/src/routes/broadcasts/BroadcastsList.test.tsx
git commit -m "feat(dashboard): share labels derive from recipients (Sent / Sending / Not confirmed / Not sent), the Retrying chip, the badge's reason and the row's hint on a server-clock ticker that recounts pending, the hooks merge an omitted retry_pending and refetch a finished share's stats (share-sent-outcome T10)"
```

(The CSS module's real name: read `StatChips.tsx`'s import; adjust the `git add` path.)

---

### Task 11: "Sent to N tenants" recounts at read time (D5) - the property Activity card and the landlord timeline

**Files:**
- Modify: `app/src/routes/units.ts` (deps :72-90; the activity route :1240-1276 and its projection :183-213)
- Modify: `app/src/routes/contactTimeline.ts` (deps :109-140; `unitAuditToMilestone` :684-699; the landlord gather + merge :1309-1348)
- Modify: `app/src/routes/api.ts` (forward `broadcastsRepo` to both routers)
- Modify: `dashboard/src/routes/listing/listingFormat.ts` (:130-136)
- Test: `app/test/unitsApiActivity.test.ts` (:158), `app/test/contactTimeline.test.ts` (:1048, :1089-1096), `dashboard/src/routes/listing/listingFormat.test.ts` (:180-192)

**Interfaces:**
- Consumes: `getByIds(ids, { projection: 'stats' })` (Task 1), `reachedCount` (Task 2).
- Produces: Units activity: after `listByEntity`, collect the `broadcastId`s of `broadcast_sent` rows, ONE `getByIds(ids, { projection: 'stats' })` inside a try/catch (a throw logs ERROR and keeps every stored count - the route's "NEVER 500s" posture, `units.ts:1255-1266`), and for each found share replace the projected `tenantCount` with `reachedCount(share)`; a missing share keeps the stored count. The dashboard's `describeUnitActivity` reads `n === 0 ? 'No tenants reached' : 'Sent to N tenant(s)'`. Landlord timeline: `unitAuditToMilestone` takes an optional `reached?: number`; the gather collects the `broadcast_sent` candidates' ids, and AFTER the merge and slice (:1346-1347) the page's `broadcast_sent` milestones are re-labeled from ONE `getByIds` over at most `limit` ids (`Sent to N tenants` / `No tenants reached`); a missing share keeps `Sent to <stored> tenants`. Both routers gain `broadcastsRepo?: BroadcastsRepo` (defaults like their other repos); `api.ts` forwards it.

- [ ] **Step 1: Write the failing tests**

```ts
// app/test/unitsApiActivity.test.ts - beside :158
  it('broadcast_sent tenantCount is the share''s REACHED count at read time (delivered + sent), not the slots written at finalize; a missing share keeps the stored count', async () => {
    // fixture: audit row broadcast_sent { broadcastId: 'b-1', tenantCount: 3 }; share b-1 with slots: delivered, failed 30007, skipped
    const res = await request(app).get('/api/units/unit-1/activity');
    expect(res.body.events.find((e) => e.type === 'broadcast_sent')).toMatchObject({ broadcastId: 'b-1', tenantCount: 1 });
    // audit row { broadcastId: 'b-gone', tenantCount: 4 } with no share -> tenantCount 4
  });
  it('a share read failure keeps every stored count and answers 200 with one ERROR', async () => {
    world.broadcastsRepo.getByIds = async () => { throw new Error('batch down'); };
    const res = await request(app).get('/api/units/unit-1/activity');
    expect(res.status).toBe(200);
    expect(res.body.events.find((e) => e.type === 'broadcast_sent').tenantCount).toBe(3);
    expect(capture.atLevel(50).length).toBe(1);
  });
// app/test/contactTimeline.test.ts - beside :1048 (share b1 absent from the world -> the label keeps its stored "4")
  it('a landlord''s broadcast_sent milestone reads "Sent to N tenants" from the share''s reached count, "No tenants reached" when none, and keeps the stored count for a missing share', async () => {
    // three audit rows across owned units: share s1 (delivered 2, failed 1) -> "Sent to 2 tenants"; s2 (all failed) -> "No tenants reached"; s3 absent -> the stored "Sent to 4 tenants"
    const res = await request(app).get(`/api/contacts/${landlordId}/timeline`);
    const labels = res.body.items.filter((i) => i.kind === 'milestone' && i.refType === 'broadcast').map((m) => m.label);
    expect(labels).toEqual(['Sent to 2 tenants', 'No tenants reached', 'Sent to 4 tenants']);
  });
  it('a share read failure on the landlord relabel keeps the stored labels, answers 200 and logs one ERROR; a tenant''s listing_sent milestone is never relabeled here', async () => {
    world.broadcastsRepo.getByIds = async () => { throw new Error('batch down'); };
    const res = await request(app).get(`/api/contacts/${landlordId}/timeline`);
    expect(res.status).toBe(200);
    expect(capture.atLevel(50).length).toBe(1);
  });
// dashboard/src/routes/listing/listingFormat.test.ts - :180-192: "Sent to 0 tenants" becomes "No tenants reached"; 1 -> "Sent to 1 tenant"; 2 -> "Sent to 2 tenants"
```

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/unitsApiActivity.test.ts test/contactTimeline.test.ts`; `cd dashboard; npx vitest run src/routes/listing/listingFormat.test.ts`.

- [ ] **Step 3: Implement**

```ts
// units.ts activity route, after the audit read (:1253):
    const shareIds = rows.filter((r) => r.event_type === 'broadcast_sent').map((r) => (r.payload as { broadcastId?: unknown })?.broadcastId).filter((id): id is string => typeof id === 'string');
    let shares = new Map<string, BroadcastItem>();
    if (shareIds.length > 0) {
      try { shares = await broadcasts.getByIds(shareIds, { projection: 'stats' }); }
      catch (err) { log.error({ err, unitId, count: shareIds.length }, 'unit activity: share recount read failed (best-effort) - stored counts kept'); }
    }
    // in toUnitActivityEvent(e, shares): for broadcast_sent, tenantCount = shares.get(broadcastId) ? reachedCount(share) : stored
// contactTimeline.ts, after `const page = candidates.slice(0, limit)` (:1347) - this runs AFTER the merge, outside the gather's try/catch, so it gets its own guard and its own landlord check:
    if (contact.type === 'landlord') {
      const shareIds = page.map((c) => c.item).filter((m): m is TimelineMilestone => m.kind === 'milestone' && m.type === 'listing_sent' && m.refType === 'broadcast' && m.refId !== undefined && m.label.startsWith('Sent to ')).map((m) => m.refId!);
      if (shareIds.length > 0) {
        try {
          const shares = await broadcasts.getByIds(shareIds, { projection: 'stats' });
          for (const c of page) {
            const m = c.item;
            if (m.kind !== 'milestone' || m.refType !== 'broadcast' || m.refId === undefined) continue;
            const share = shares.get(m.refId);
            if (share === undefined) continue;
            m.label = sentToLabel(reachedCount(share));
          }
        } catch (err) {
          log.error({ err, contactId, count: shareIds.length }, 'landlord timeline: share recount read failed (best-effort) - stored labels kept');
        }
      }
    }
function sentToLabel(n: number): string { return n === 0 ? 'No tenants reached' : `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`; }
// listingFormat.ts (:130-136): label: n === 0 ? 'No tenants reached' : `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`
```

The landlord relabel identifies its own milestones by `refType === 'broadcast'` on a `listing_sent` type - the ONLY producer of that pair on a landlord timeline is `unitAuditToMilestone`'s `broadcast_sent` case (:690-698); a tenant's `listing_sent` milestone from `recordPropertySent` has `refType: 'unit'` for a unit share, and a unit-less share's has `refType: 'broadcast'` but appears on a TENANT timeline, where `contact.type !== 'landlord'` - guard the relabel with the landlord branch so a tenant's milestone is never touched (Task 12 owns it).

- [ ] **Step 4: Run, typecheck** - the three files PASS; `npm run typecheck` exit 0. The e2e pins `listing-activity.spec.ts:143` and `landlord-activity.spec.ts:122` ("Sent to 2 tenants", both delivered) hold.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/units.ts app/src/routes/contactTimeline.ts app/src/routes/api.ts dashboard/src/routes/listing/listingFormat.ts app/test/unitsApiActivity.test.ts app/test/contactTimeline.test.ts dashboard/src/routes/listing/listingFormat.test.ts
git commit -m "feat(activity): Sent to N tenants recounts the share's reached recipients at read time on the property card and the landlord timeline; No tenants reached (share-sent-outcome T11)"
```

---

### Task 12: The tenant "Property sent" milestone reads its words from the ledger (D6)

**Files:**
- Modify: `app/src/routes/contactTimeline.ts` (deps :109-140 - add `listingSendsRepo?` and `messagesRepo` if the router lacks it; `toTimelineMilestone` :663-673; the tenant milestone read :1292-1298)
- Test: `app/test/contactTimeline.test.ts` (the milestone block around :1044-1100)

**Interfaces:**
- Consumes: `getByKeys` (Task 3), `getByTsMsgIdConsistent`, `isRetryPromiseLive`, `RETRY_OUTCOME_UNCONFIRMED`, `RETRY_ROW_READ_BOUND_MS` + `attemptKeyTimestampMs` (Tasks 1-2), the milestone's stored `broadcastId` (Task 7).
- Produces: after the tenant's milestones are read (:1292-1298), the `listing_sent` milestones with `refType === 'unit'` are re-worded: ONE `getByKeys` over the distinct `(refId as unitId, contactId)` pairs; for each milestone with a row:
  - with `e.broadcastId` and an entry `row.shares?.[broadcastId]`: `counted` -> `Property sent`; `unconfirmed` -> `Property sent - not confirmed`; `failed` -> `Property text failed`; `pending` -> read the entry's row (`entry.conversationId`, `entry.attempt`) when `attemptKeyTimestampMs(entry.attempt)` is within `RETRY_ROW_READ_BOUND_MS` of now: `retry_outcome` unconfirmed -> `Property sent - not confirmed`; `isRetryPromiseLive(retry_due_at, now)` -> `Property sent`; else `Property text failed`; outside the bound, or the row missing/unreadable -> `Property text failed` (a pending entry that never heard an outcome);
  - with `e.broadcastId` but no entry for it (the entry was never written - a swallowed write): the pair-level rule below;
  - without `e.broadcastId` (a pre-branch milestone): `row.counted === false` -> `Property text failed`; else `Property sent`;
  - no row: the stored label.
  The words are set on the `TimelineMilestone.label`; `type`, `refType`, `refId` unchanged. A `getByKeys` failure logs ERROR and leaves the stored labels (best-effort, the file's idiom).

- [ ] **Step 1: Write the failing tests**

In `app/test/contactTimeline.test.ts` (read the tenant milestone fixtures first):

```ts
  it('a tenant''s Property sent milestone reads its words from the ledger entry of ITS share: counted / unconfirmed / failed / pending-live / pending-refreshed / pending-withdrawn / pending-lapsed / pending-past-the-bound', async () => {
    // eight milestones for eight units, each with broadcastId b1..b8; ledger rows seeded through putShareMemory with the entry states;
    // b4's pending entry names a row whose retry_due_at is now + 5 min; b5's names a row 1b REFRESHED (retry_due_at moved to now + 6 min - still live);
    // b6's names a row whose promise is WITHDRAWN with retry_outcome unconfirmed; b7's names a lapsed one (due + 2 min < now);
    // b8's pending entry's attempt key is 30 minutes old (past RETRY_ROW_READ_BOUND_MS) - no row read
    const labels = body.items.filter((i) => i.kind === 'milestone' && i.type === 'listing_sent').map((m) => m.label);
    expect(labels).toEqual(['Property sent', 'Property sent - not confirmed', 'Property text failed', 'Property sent', 'Property sent', 'Property sent - not confirmed', 'Property text failed', 'Property text failed']);
    expect(rowReads).toBe(4);   // instrument world.messagesRepo.getByTsMsgIdConsistent: b4, b5, b6, b7 read; b8 does not
  });
  it('a pre-branch milestone (no broadcastId) reads the pair: counted false -> Property text failed; absent flag -> Property sent; no row -> the stored label', async () => { /* three milestones */ });
  it('a ledger read failure leaves the stored labels and logs one ERROR', async () => { /* world.listingSendsRepo.getByKeys throws */ });
```

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/contactTimeline.test.ts`.

- [ ] **Step 3: Implement**

```ts
// contactTimeline.ts, after the tenant milestone read (:1292-1298), before the landlord branch:
      const listingMilestones = items.filter((e) => e.type === 'listing_sent' && e.refType === 'unit' && typeof e.refId === 'string');
      if (listingMilestones.length > 0) {
        try {
          const pairs = [...new Set(listingMilestones.map((e) => e.refId as string))].map((unitId) => ({ unitId, contactId }));
          const rows = await listingSends.getByKeys(pairs);
          for (const e of listingMilestones) {
            const row = rows.get(`${e.refId}|${contactId}`);
            if (row === undefined) continue;
            const words = await propertySentWords(row, typeof e['broadcastId'] === 'string' ? e['broadcastId'] : undefined, messages, nowMs);
            const candidate = candidates.find((c) => c.globalKey === e.tsEventId);
            if (candidate !== undefined && candidate.item.kind === 'milestone') candidate.item.label = words;
          }
        } catch (err) {
          log.error({ err, contactId }, 'tenant listing_sent milestone words: ledger read failed (best-effort) - stored labels kept');
        }
      }

async function propertySentWords(row: ListingSendItem, broadcastId: string | undefined, messages: Pick<MessagesRepo, 'getByTsMsgIdConsistent'>, nowMs: number): Promise<string> {
  const entry = broadcastId !== undefined ? row.shares?.[broadcastId] : undefined;
  if (entry === undefined) return row.counted === false ? 'Property text failed' : 'Property sent';
  switch (entry.state) {
    case 'counted': return 'Property sent';
    case 'unconfirmed': return 'Property sent - not confirmed';
    case 'failed': return 'Property text failed';
    case 'pending': {
      const ts = attemptKeyTimestampMs(entry.attempt);
      if (ts === undefined || nowMs - ts > RETRY_ROW_READ_BOUND_MS || entry.conversationId === undefined) return 'Property text failed';
      try {
        const attemptRow = await messages.getByTsMsgIdConsistent(entry.conversationId, entry.attempt);
        if (attemptRow?.retry_outcome === RETRY_OUTCOME_UNCONFIRMED) return 'Property sent - not confirmed';
        return isRetryPromiseLive(attemptRow?.retry_due_at, nowMs) ? 'Property sent' : 'Property text failed';
      } catch { return 'Property text failed'; }
    }
  }
}
```

The words are composed app-side (the dashboard's `MilestonePin` renders `label` verbatim, `Timeline.tsx:467-480`).

- [ ] **Step 4: Run, typecheck** - `cd app; npx vitest run test/contactTimeline.test.ts` PASS; `npm run typecheck` exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/contactTimeline.ts app/src/routes/api.ts app/test/contactTimeline.test.ts
git commit -m "feat(timeline): the tenant's Property sent milestone reads its words from the ledger entry of its share, the pair for a pre-branch milestone, and the attempt row for a pending entry (share-sent-outcome T12)"
```

---

### Task 13: The repair (D8) - a Cameron-run, dry-run-first pass over history; RUNBOOK

**Files:**
- Create: `app/scripts/repair-share-outcomes.ts`
- Modify: `app/src/repos/messagesRepo.ts` (a new `stampRetryAttribution(conversationId, tsMsgId, patch: { broadcastId: string; retryRoot: string })`: one conditional `UpdateCommand`, `SET broadcast_id = :b, retry_root = :r` with `attribute_exists(tsMsgId)`; mirrored in the harness double)
- Modify: `RUNBOOK.md` (a new section beside "One-to-one conversation automation switch (2026-09-25)", :337-366)
- Test: `app/test/repairShareOutcomes.test.ts` (per-file DynamoDB Local database; every case runs the script in ONE-SHARE mode, `broadcastId: <its own share>`, so table-wide counts never leak between cases)

**Interfaces:**
- Consumes: `resolveStageClient`, `parseStageArgs` (`app/scripts/lib/stageClient.ts:112-177`, `:186-212`); the entrypoint shape (`enable-conversation-automation.ts:364-417`); `ScanCommand` (the census precedent, `conversation-automation-census.ts:227`); `tableName`; repos built over the stage's `doc` + `env`: broadcasts (`getByIdConsistent`, `applyAttemptOutcome`), messages (`getByTsMsgIdConsistent`, `listByConversation` paged newest-first with `before`, `stampRetryAttribution`), attempts (`get`), listing sends (`getByKeyConsistent`, `putShareMemory`), conversations (`getById` for `participant_phone`); `applyLaterAttempt`, `wouldApply` (Task 4), `applyShareLedgerEntry`, `ledgerEntryForSlot` (Task 3), `retryRecipientKey` (`retryChain.ts:59-66`), `rowlessAttemptKey` (Task 1), `RECONCILE_CHECK_DELAYS_MS`, `RETRY_PROMISE_GRACE_MS`, `isRetryPromiseLive`.
- Produces: `runRepairShareOutcomes(opts: { doc; env; apply: boolean; now?: () => number; scanLimit?: number; broadcastId?: string }): Promise<RepairReport>` and `reportRepair(report, apply): number` (the exit code). Definitions the builder must not invent:
  - THE CHAIN of a slot: from the original row O (the slot's `conversationId` + `tsMsgId`), the rows R of the same conversation with `tsMsgId > O.tsMsgId` for which following `retry_of` from R reaches O (walk within the collected rows; every hop lands on a collected row or on O). A row that walks to a row outside the collection, or to a non-collected row, belongs to ANOTHER chain (another share's text, another slot's chain in the same thread - two contacts on one number share a conversation, so `broadcast_id === share.broadcastId` says NOTHING about which slot a row belongs to) and is ignored. A BROKEN link is a collected row whose `retry_root === O.tsMsgId` (it CLAIMS this original) but whose `retry_of` walk does not reach O: the slot is `unjudgeable.brokenLineage` and left alone. Rows are collected by paging `listByConversation(conversationId, { before, limit: 100 })` newest-first until a page's oldest `tsMsgId <= O.tsMsgId`.
  - THE DECIDED ATTEMPT of a slot (D2's rule applied to history): if any chain row (or O) is `delivered`, the decided attempt is the LATEST delivered one - `{ attemptKey: D.tsMsgId, outcome: { kind: 'delivered', carrierSentAt: D.<carrier-sent field>? } }` (the delivered-at-any-age exception: a delivery is never erased). Otherwise the newest chain row N (O when the chain is empty): `failed`/`undelivered` -> `{ kind: 'failed', errorCode: N.<error-code field>, retryDueAt: N.retry_due_at }`; `sent` -> `{ kind: 'sent', carrierSentAt: N.<carrier-sent field>? }`; `queued`/`accepted` -> `{ kind: 'sent' }` (read the row's real field names). THEN, only when no delivery decided it, ONE record check for N: `attempts.get({ kind: 'retry_send', conversationId, retriedTsMsgId: N.tsMsgId, attempt: (N.retry_attempt ?? 0) + 1, recipientKey: retryRecipientKey(N, conversation), retryRoot: O.tsMsgId })` (the conversation read once per slot; a recipient key that cannot be derived skips ONLY the record check and counts `unjudgeable.noRecipientKey` - the slot decision stands on the rows); a record `done/unresolved`, or `reconciling` with `attemptedAt` older than `RECONCILE_CHECK_DELAYS_MS[2] + RETRY_PROMISE_GRACE_MS`, or `N.retry_outcome === 'unconfirmed'` -> `{ attemptKey: rowlessAttemptKey(N.tsMsgId), outcome: { kind: 'unresolved' } }`.
  - STAMPS: every chain row whose `broadcast_id !== share.broadcastId` or `retry_root !== O.tsMsgId` (missing OR wrong).
  - A SLOT IS "TO MOVE" when `wouldApply(slot, decided)` (Task 4's exported rule, no reads) is true AND the slot does not already record the decided attempt with the decided status and code (`(slot.latestAttempt ?? slot.tsMsgId) === decided.attemptKey && slot.status === statusOf(decided) && slot.errorCode === codeOf(decided)`); a `delivered` or `skipped` slot is never "to move" (the rule refuses it), so a second run reports 0.
  - THE LEDGER follows the SLOT, never the decision: after the slot step, the slot's state (after apply, or as it stands when nothing moved) yields `ledgerEntryForSlot(slot, conversationId, promiseLive)` (Task 3; `promiseLive` = `isRetryPromiseLive(N.retry_due_at, now)` for a failed-30003 slot) - a delivered slot that refused the move keeps its `delivered` entry (I2). The pair's contact: the slot key when a contact id, else N's `recipient_contact_id`, else `unjudgeable.noContact`. The census COMPARES that entry with the current ledger row (the same `mayReplace` rule as the service - export `ledgerWouldChange(row, broadcastId, entry): 'create' | 'recount' | 'uncount' | 'update' | 'none'` from `shareLedger.ts`, where recount/uncount say whether the row's `counted` flips) and counts `rowsToCreate`, `pairsToRecount`, `pairsToUncount`; on apply it writes through `applyShareLedgerEntry` and counts the same three from the before/after row (`applyLaterAttempt` ALSO writes the ledger when a slot moves - the second write is a refused no-op; the counters read the row, not the service's return).
  - THE REPORT: `{ sharesWalked, slotsWalked, stampsNeeded, stampsWritten, slotsToMove, slotsMoved, rowsToCreate, rowsCreated, pairsToRecount, pairsRecounted, pairsToUncount, pairsUncounted, unjudgeable: { originalMissing, brokenLineage, noContact, noRecipientKey } }`, ids only in the log; the `*To*` counters are the census's, the past-tense ones the apply's (0 on a dry run); exit 0 on a clean run, 1 on any read/write error (the partial report printed first), 2 on usage. `--broadcast <id>` limits the walk to one share; `--env local --lane <L>` for an agent; `--env dev|prod` is Cameron's, and the account guard (`resolveStageClient`) refuses any other account BEFORE a table is read.

- [ ] **Step 1: Write the failing test**

`app/test/repairShareOutcomes.test.ts` (seed through the REAL repos over the per-file database; retry rows are appended with `messagesRepo.append` so the `retrychild#` pointers exist too; `putShare` as in Task 1; every run passes `broadcastId` so counts are per share):

```ts
// spec D8: census then apply - stamps, slot moves, ledger rebuild; idempotent; never a regression; the account guard.
import { describe, expect, it } from 'vitest';
// setup: doc/env for the per-file database; createBroadcastsRepo, createMessagesRepo, createSendAttemptsRepo, createListingSendsRepo, createConversationsRepo; runRepairShareOutcomes, resolveTargetForRepair from '../scripts/repair-share-outcomes.js'

const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const ROOT = '2026-09-28T11:00:00.000Z#SMROOT';
const R1 = '2026-09-28T11:01:00.000Z#SMR1';
const R2 = '2026-09-28T11:02:00.000Z#SMR2';
async function seedShareWithChain(opts: { broadcastId: string; slotStatus: 'failed' | 'sent' | 'delivered' | 'skipped'; slotAttempt?: string; rows: Array<{ tsMsgId: string; retryOf?: string; status: string; errorCode?: string; stamped?: boolean; wrongRoot?: string }> }) {
  // a conversation `conv-<broadcastId>` with participant_phone; a share (unitId u-1, slot c-1 { status, errorCode '30003' for failed, conversationId, tsMsgId: ROOT, latestAttempt: slotAttempt });
  // rows appended in order: the original (broadcast_id set, no retry_of) and the retries (retry_of as given; broadcast_id/retry_root only when stamped; wrongRoot overrides retry_root)
}
const run = (broadcastId: string, apply: boolean) => runRepairShareOutcomes({ doc, env, apply, now: () => NOW, broadcastId });

describe('repair-share-outcomes', () => {
  it('census: a share whose retry delivered (pre-1b rows: no broadcast_id, no retry_root) reports 1 stamp needed, 1 slot to move and 1 row to create; dry run writes nothing', async () => {
    await seedShareWithChain({ broadcastId: 'b-1', slotStatus: 'failed', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: R1, retryOf: ROOT, status: 'delivered' }] });
    const report = await run('b-1', false);
    expect(report).toMatchObject({ sharesWalked: 1, slotsWalked: 1, stampsNeeded: 1, stampsWritten: 0, slotsToMove: 1, slotsMoved: 0, rowsToCreate: 1, rowsCreated: 0, pairsToRecount: 1, pairsRecounted: 0 });
    expect((await broadcasts.getByIdConsistent('b-1'))!.recipients!['c-1']!.status).toBe('failed');
    expect(await listingSends.getByKeyConsistent('u-1', 'c-1')).toBeUndefined();
  });
  it('apply: stamps the chain, moves the slot to delivered as the newer attempt, creates the ledger row counted by delivery at the retry''s instant, and a second run reports zeros', async () => {
    const first = await run('b-1', true);
    expect(first).toMatchObject({ stampsWritten: 1, slotsMoved: 1, rowsCreated: 1, pairsRecounted: 1 });
    expect(await messages.getByTsMsgIdConsistent('conv-b-1', R1)).toMatchObject({ broadcast_id: 'b-1', retry_root: ROOT });
    expect((await broadcasts.getByIdConsistent('b-1'))!.recipients!['c-1']).toMatchObject({ status: 'delivered', latestAttempt: R1 });
    expect((await listingSends.getByKeyConsistent('u-1', 'c-1'))).toMatchObject({ counted: true, sentAt: '2026-09-28T11:01:00.000Z', broadcastId: 'b-1' });
    expect(await run('b-1', true)).toMatchObject({ stampsNeeded: 0, slotsToMove: 0, rowsToCreate: 0, pairsToRecount: 0, pairsToUncount: 0 });
  });
  it('a post-1b row whose retry_root is WRONG (the hop cap) is corrected, and a chain with an unstamped ancestor is stamped end to end', async () => {
    await seedShareWithChain({ broadcastId: 'b-2', slotStatus: 'failed', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: R1, retryOf: ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: R2, retryOf: R1, status: 'delivered', stamped: true, wrongRoot: R1 }] });
    const report = await run('b-2', true);
    expect(report.stampsWritten).toBe(2);
    expect((await messages.getByTsMsgIdConsistent('conv-b-2', R2))?.retry_root).toBe(ROOT);
    expect((await messages.getByTsMsgIdConsistent('conv-b-2', R1))).toMatchObject({ broadcast_id: 'b-2', retry_root: ROOT });
  });
  it('a DELIVERED older attempt decides even when a newer retry failed (the delivered exception); the ledger follows the slot', async () => {
    await seedShareWithChain({ broadcastId: 'b-3', slotStatus: 'failed', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: R1, retryOf: ROOT, status: 'delivered' }, { tsMsgId: R2, retryOf: R1, status: 'failed', errorCode: '30007' }] });
    await run('b-3', true);
    expect((await broadcasts.getByIdConsistent('b-3'))!.recipients!['c-1']).toMatchObject({ status: 'delivered', latestAttempt: R1 });
    expect((await listingSends.getByKeyConsistent('u-1', 'c-1'))?.shares?.['b-3']).toMatchObject({ state: 'counted', by: 'delivery' });
  });
  it('a slot stuck sent whose own row failed moves to failed and un-counts the pair (pairsUncounted 1); a delivered slot whose newest row lies is never to-move and keeps its counted entry; a skipped slot is never walked', async () => {
    await seedShareWithChain({ broadcastId: 'b-4', slotStatus: 'sent', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30007' }] });
    await seedListingSend(listingSends, { unitId: 'u-1', contactId: 'c-1', sentAt: '2026-09-28T11:00:00.000Z', broadcastId: 'b-4' });
    expect(await run('b-4', true)).toMatchObject({ slotsMoved: 1, pairsUncounted: 1 });
    expect((await broadcasts.getByIdConsistent('b-4'))!.recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: '30007' });
    await seedShareWithChain({ broadcastId: 'b-5', slotStatus: 'delivered', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30007' }] });
    expect(await run('b-5', true)).toMatchObject({ slotsToMove: 0, pairsToUncount: 0 });
    expect((await broadcasts.getByIdConsistent('b-5'))!.recipients!['c-1']!.status).toBe('delivered');
    await seedShareWithChain({ broadcastId: 'b-6', slotStatus: 'skipped', rows: [] });
    expect((await run('b-6', true)).slotsWalked).toBe(0);
  });
  it('a chain whose newest attempt''s next-attempt record is done/unresolved marks the slot send_unconfirmed as a row-less attempt and the ledger entry unconfirmed', async () => {
    await seedShareWithChain({ broadcastId: 'b-7', slotStatus: 'failed', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30003' }] });
    // claim then close the retry_send record for ROOT attempt 1 with c-1's recipient key - copy the claim + closeFromReconcile(unresolved) sequence sendReconcile.test.ts uses for its retry_send fixtures
    const report = await run('b-7', true);
    expect(report.slotsMoved).toBe(1);
    expect((await broadcasts.getByIdConsistent('b-7'))!.recipients!['c-1']).toMatchObject({ status: 'failed', errorCode: SEND_UNCONFIRMED_CODE, latestAttempt: rowlessAttemptKey(ROOT) });
    expect((await listingSends.getByKeyConsistent('u-1', 'c-1'))?.shares?.['b-7']?.state).toBe('unconfirmed');
  });
  it('an original row that is missing is unjudgeable and untouched; a row that claims this original (retry_root) but does not walk to it is a broken lineage; another slot''s chain in the same thread (same broadcast_id, another root) is ignored', async () => {
    await seedShareWithChain({ broadcastId: 'b-8', slotStatus: 'failed', rows: [] });
    expect((await run('b-8', true)).unjudgeable.originalMissing).toBe(1);
    await seedShareWithChain({ broadcastId: 'b-9', slotStatus: 'failed', rows: [{ tsMsgId: ROOT, status: 'failed', errorCode: '30003' }, { tsMsgId: R1, retryOf: 'gone', status: 'delivered', stamped: true }] });
    expect((await run('b-9', true)).unjudgeable.brokenLineage).toBe(1);
    expect((await broadcasts.getByIdConsistent('b-9'))!.recipients!['c-1']!.status).toBe('failed');
    // b-10: two slots c-1 and c-2 on ONE conversation (two contacts, one number): c-2's chain rows carry broadcast_id b-10 but walk to c-2's original; c-1's slot is judged from ITS chain only
    await seedTwoSlotShare('b-10');
    const r = await run('b-10', true);
    expect(r.unjudgeable.brokenLineage).toBe(0);
    expect(r.slotsMoved).toBe(1);   // c-2's retry delivered; c-1's chain is empty and its failed slot stands
  });
  it('a share with no unitId is not walked', async () => {
    await putShare({ ...baseShare, broadcastId: 'b-11', unitId: undefined, recipients: { 'c-1': { status: 'failed', errorCode: '30003', conversationId: 'conv-x', tsMsgId: ROOT } } });
    expect((await run('b-11', false)).sharesWalked).toBe(0);
  });
  it('the account guard: a dev/prod target whose identity is not the housingchoice account refuses BEFORE any read', async () => {
    const send = vi.spyOn(doc, 'send');
    await expect(resolveTargetForRepair('dev', { assertAccount: async () => ({ Account: '000000000000' }) })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to see the reds** - `cd app; npx vitest run test/repairShareOutcomes.test.ts`.

- [ ] **Step 3: Write the script**

```ts
export interface RepairReport { sharesWalked: number; slotsWalked: number; stampsNeeded: number; stampsWritten: number; slotsToMove: number; slotsMoved: number; rowsToCreate: number; rowsCreated: number; pairsToRecount: number; pairsRecounted: number; pairsToUncount: number; pairsUncounted: number; unjudgeable: { originalMissing: number; brokenLineage: number; noContact: number; noRecipientKey: number } }

export async function runRepairShareOutcomes(opts: RepairOptions): Promise<RepairReport> {
  const repos = buildRepos(opts.doc, opts.env, log);   // broadcasts, messages, attempts, listingSends, conversations - the createXRepo({ doc, env, logger }) shape stageClient users follow
  const report = emptyReport();
  const nowMs = (opts.now ?? Date.now)();
  for await (const share of unitShares(repos, opts)) {   // one getByIdConsistent for --broadcast (skipped when it has no unitId); else a ScanCommand paged with FilterExpression 'attribute_exists(unitId)'
    report.sharesWalked += 1;
    const conversationCache = new Map<string, ConversationItem | undefined>();
    for (const [contactKey, slot] of Object.entries(share.recipients ?? {})) {
      if (slot.status === 'skipped' || slot.conversationId === undefined || slot.tsMsgId === undefined) continue;
      report.slotsWalked += 1;
      const chain = await rebuildChain(repos.messages, slot.conversationId, slot.tsMsgId);          // { original, rows } | { unjudgeable: 'originalMissing' | 'brokenLineage' }
      if ('unjudgeable' in chain) { report.unjudgeable[chain.unjudgeable] += 1; continue; }
      for (const row of chain.rows) {
        if (row.broadcast_id === share.broadcastId && row.retry_root === chain.original.tsMsgId) continue;
        report.stampsNeeded += 1;
        if (opts.apply) { await repos.messages.stampRetryAttribution(row.conversationId, row.tsMsgId, { broadcastId: share.broadcastId, retryRoot: chain.original.tsMsgId }); report.stampsWritten += 1; }
      }
      const conversation = await cachedConversation(repos.conversations, conversationCache, slot.conversationId);
      const decided = await decideAttempt(repos.attempts, chain, conversation, nowMs, report);        // the delivered exception first, else the newest row + ONE record check
      let current = slot;
      if (wouldApply(slot, decided) && !slotRecords(slot, decided, chain.original.tsMsgId)) {
        report.slotsToMove += 1;
        if (opts.apply) {
          const result = await applyLaterAttempt(shareDeps(repos, log), { broadcastId: share.broadcastId, conversationId: slot.conversationId, retryRoot: chain.original.tsMsgId, ...decided, ...(newestRow(chain).recipient_contact_id !== undefined && { recipientContactId: newestRow(chain).recipient_contact_id }) });
          if (result === 'applied') { report.slotsMoved += 1; current = (await repos.broadcasts.getByIdConsistent(share.broadcastId))!.recipients![contactKey]!; }
        }
      }
      const contactId = contactKey.startsWith('phone#') ? newestRow(chain).recipient_contact_id : contactKey;
      if (contactId === undefined) { report.unjudgeable.noContact += 1; continue; }
      const promiseLive = isRetryPromiseLive(newestRow(chain).retry_due_at, nowMs);
      const entry = ledgerEntryForSlot(opts.apply ? current : projectedSlot(slot, decided), slot.conversationId, promiseLive);   // the census projects the slot the apply would leave
      if (entry === undefined) continue;
      await recountPair(repos.listingSends, log, share, contactId, entry, opts.apply, report);          // ledgerWouldChange -> the *To* counters; on apply, applyShareLedgerEntry and the past-tense counters from the before/after row
    }
  }
  return report;
}
```

`rebuildChain` collects the thread's rows newer than O (paged `listByConversation` with `before`, stopping at O), keeps the rows whose `retry_of` walk reaches O within the collection, returns `{ unjudgeable: 'brokenLineage' }` when a collected row with `retry_root === O.tsMsgId` does not reach O, and `{ unjudgeable: 'originalMissing' }` when O is not readable. `decideAttempt`: the latest `delivered` row in `[O, ...rows]` wins; else the newest row's status, then the ONE next-attempt record check. `slotRecords(slot, decided, originalKey)`: the slot already records the decided attempt with its status and code. `projectedSlot`: the slot as `applyLaterAttempt`'s `nextSlot` would leave it (share the helper: export `projectSlot(slot, input)` from Task 4's service). `applyLaterAttempt` runs the D2 rule, so the repair never regresses a slot.

- [ ] **Step 4: RUNBOOK section**

Add "Share outcomes repair (2026-09-28)" beside :337-366: what it repairs (spec D8), the census first (`npx tsx app/scripts/repair-share-outcomes.ts --env dev`), the report fields and what each means (the `*To*` counters are the census's forecast; the past-tense ones are the apply's), then `--apply`, dev then prod, once after this branch deploys and before the next blast, re-runnable (a second run reports zero `*To*` counters); "No agent runs it against dev or prod; an agent rehearses on a lane: `--env local --lane <L>`". The census reads every share slot's chain (keyed reads) and one Scan of the broadcasts table; on prod expect minutes, not seconds.

- [ ] **Step 5: Run, typecheck** - `cd app; npx vitest run test/repairShareOutcomes.test.ts test/stageClient.test.ts test/messagesRepoRetryLineage.integration.test.ts test/shareLedger.test.ts test/shareAttemptOutcome.test.ts` PASS; `npm run typecheck` exit 0; the script's `--env local --lane 15` census against a booted lane prints a report and exit 0 (the orchestrator's self-QA lane; never bare `--env local`).

- [ ] **Step 6: Commit**

```bash
git status
git add app/scripts/repair-share-outcomes.ts app/src/repos/messagesRepo.ts app/src/services/shareLedger.ts app/src/services/shareAttemptOutcome.ts app/test/helpers/twilioWebhookHarness.ts app/test/repairShareOutcomes.test.ts RUNBOOK.md
git commit -m "feat(ops): repair-share-outcomes - census then apply: stamps and corrects retry chains, re-applies the decided attempt to each slot (the delivered exception honored), rebuilds the ledger from the slot (share-sent-outcome T13, D8)"
```

---

### Task 14: End to end - the four scenarios, the rewritten pins, `selectors.md`

**Files:**
- Create: `e2e/tests/dashboard-next/share-sent-outcome.spec.ts`
- Modify: `e2e/tests/dashboard-next/share-skip-fix.spec.ts` (:16-22 header, :250 failed-stays-flagged), `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts` (:420-490 the 21211 hint pin at :459-464; :491-537 the "Failed" pill :534 and the `last_error` alert :535-537), `e2e/support/selectors.md` (:116)
- Test: the spec itself; run as `npm run e2e -- e2e/tests/dashboard-next/share-sent-outcome.spec.ts`

**Interfaces:**
- Consumes: the helpers of `share-skip-fix.spec.ts` (`createUnitViaApi` :50, `createTenant` :80, `shareViaApi` :104, `slotConversationId` :131, `openReviewRow` :144) and `send-outcome-reconcile.spec.ts` (`createAvailableUnit` :137, `createConsentedTenant` :168, `openResults` :204, `recipientRow` :212), and the timing helpers `pollRow` / `expectCreateLanded` / `expectFailureStamped` (`retry-send-adoption.spec.ts:192`, `:215`, `:233`) - ALL FILE-LOCAL, not exported: COPY them into the new spec (importing a spec file would register its tests); `setDeliveryOutcome` (`e2e/fixtures/fakeTwilio.ts:354-372`) with `{ kind: 'fail', failState: 'undelivered', errorCode: '30003' }`; `statValue` / `statusPill` (`e2e/support/broadcastSelectors.ts:26-33`); the lane's 10 s backoff and 2/4/8 s reconcile delays; `afterAll` reseed (`share-skip-fix.spec.ts:38-40`).
- Produces the four scenarios of spec section 7, each on a fresh available unit and a fresh consented tenant on a per-run number (uid from 90):
  (a) arm 30003 for the tenant's number; share via the API; `expectFailureStamped` on the original row, then IMMEDIATELY poll `GET /api/broadcasts/:id/results` (the API, not the page - the pending state lasts about 10 s) until `stats.retry_pending === 1` and the recipient's `retryDueAt` is set (an ordering guard: the poll starts after the failure is stamped, and the retry cannot land before the 10 s backoff); the "will retry" COPY on the row is pinned by Task 10's `DeliveryBadge` unit test, not here; then the retry lands (the fake's next create to that number is normal); open the results page and expect the row `Delivered`, the pill `Sent`, the Retrying chip 0; open the composer for the same unit: the tenant is flagged "Already sent"; open the tenant's file: "Properties sent" lists the unit.
  (b) OPEN THE SHARE LIST FIRST (so the SSE events reach a mounted list); arm 30003, share, then re-arm 30003 after EACH send lands (`expectCreateLanded` then `setDeliveryOutcome` again) until the fourth failure; expect on the STILL-OPEN list that the row's pill reads `Not sent` (danger) within 15 s of the fourth failure WITHOUT a reload (this exercises the SSE merge + the stats refetch); then open the results page: the row `Failed` with the plain 30003 copy (no "will retry"), the pill `Not sent`, the hint `open conversation to retry` present; the tenant NOT flagged on a new composer; the unit absent from "Properties sent"; the tenant timeline milestone reading `Property text failed`.
  (c) arm `30007`, share; expect the row `Failed` with the hint (a text with a row and no promise), the pill `Not sent`, the tenant NOT flagged, the property Activity entry reading `No tenants reached`.
  (d) SOR's unconfirmed path (copy `send-outcome-reconcile.spec.ts:491`'s arming): expect the pill `Not confirmed`, the tenant flagged on a new composer, the unit absent from "Properties sent", no `last_error` alert.
- The rewritten pins: `share-skip-fix.spec.ts:250` asserts the tenant is NOT flagged after a final (30007) failure and the header :16-22 says so; `send-outcome-reconcile.spec.ts:464` asserts NO hint on a 21211 row; `:534` expects `Not confirmed`; `:535-537` expects the alert absent. `selectors.md:116` documents the `Retrying` chip and "a failed row's link carries open conversation to retry ONLY when the text has a message row and no live retry promise".

- [ ] **Step 1: Write the spec** (the four `test()`s above; accessibility-first selectors; `test.describe.configure({ mode: 'serial' })` is NOT needed - each test owns its unit and tenant; budget each `expect.poll` at 30 s and the list-pill wait in (b) at 15 s; scenario (b) runs about 60 s - set `test.setTimeout(120_000)` on it).

- [ ] **Step 2: Rewrite the three pins and `selectors.md`.**

- [ ] **Step 3: Run the new spec and the three touched specs alone**

Run: `npm run e2e -- e2e/tests/dashboard-next/share-sent-outcome.spec.ts e2e/tests/dashboard-next/share-skip-fix.spec.ts e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts e2e/tests/dashboard-next/broadcasts.spec.ts`
Expected: all green. A red in scenario (b)'s timing: read the backoff (10 s per rung, four rungs) before touching budgets; never a bare `npx playwright`.

- [ ] **Step 4: Commit**

```bash
git status
git add e2e/tests/dashboard-next/share-sent-outcome.spec.ts e2e/tests/dashboard-next/share-skip-fix.spec.ts e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts e2e/support/selectors.md
git commit -m "test(e2e): share-sent-outcome - a retry that delivers, a chain that exhausts, a final failure, a Not-confirmed share; the interim-rule and SOR pins rewritten (share-sent-outcome T14)"
```

---

### Task 15: Issues, self-QA, drift report, the five gates, handback

**Files:**
- Modify: `docs/issues/broadcast-30003-retry-never-updates-slot.md`, `docs/issues/unconfirmed-share-invites-resend.md`, `docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md` (RESOLVED blocks: the closing commit, the rule, the residuals), `docs/issues/send-attempt-sweeper.md` (an addendum: the in-flight recipients D1 keeps flagging in a stranded `sending` share are the sweeper's population; a `done/refused` retry record with cause `already_sent` means the text exists)
- Create: `docs/superpowers/reviews/2026-09-27-share-sent-outcome/self-qa.md`, `.../handback.md` (the shared handback contract)
- Run: `npm run issues` (regenerates the gitignored index; never hand-edit it)

- [ ] **Step 1: Issue notes.** Each closed issue gets a dated RESOLVED block naming the commits and the spec decision; new residuals found during the build are FILED (copy `docs/issues/_TEMPLATE.md`), never fixed in passing. Known residuals the spec names, to be filed if not already: a stale-tab Retry on a pre-1b chain (the fork), the route-failed running pass's unclaimed recipients (the double-text hint class), the lost retry rollup past the bound (healed by a repair re-run), a unit-less share's unattributed pre-1b chain.

- [ ] **Step 2: Live self-QA** on the hermetic lane (`npm run e2e:session`, the built-in Playwright MCP, dev-login): walk the four scenarios by hand once, eyeball the pills, the Retrying chip, the hint and the milestone words; record what was seen in `self-qa.md` (ids, not screenshots of phones); `npm run e2e:stop` and prove the lane's ports are free.

- [ ] **Step 3: Drift report.** `git fetch` is not needed (the repo is local): `git log --oneline HEAD..main` lists what main gained since `cebc7d23`; REPORT it in the handback; do NOT merge main again without the planner's word (one sync per branch; the planner decides the final one).

- [ ] **Step 4: The five gates, bare, on a QUIET tree** (nothing else writing to the worktree; DynamoDB Local restarted if it has served many databases): `npm run typecheck`; `npm test`; `npm run smoke`; `timeout 1800 npm run e2e`; `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` with baseline attribution at the merge base for any error. Quote every exit code in the handback; a red is reported as red with its output, never re-run into green without a diagnosis (the AGENTS.md re-run-and-compare discipline applies ONLY to the environmental DynamoDB contention failure, and any `[dynamoAdmin]` line is a real sighting).

- [ ] **Step 5: Handback** (`handback.md`, committed): the code-final SHA, the gates with exit codes, the e2e count, the live self-QA, every declared deviation (this plan's header list plus any the build added), the rewritten pins, the issues closed and filed, the drift, and the owed operator action: the D8 census then apply on dev and prod (the RUNBOOK section), after deploy and before the next blast. Never merge, deploy or clean up.

- [ ] **Step 6: Commit**

```bash
git status
git add docs/issues/broadcast-30003-retry-never-updates-slot.md docs/issues/unconfirmed-share-invites-resend.md docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md docs/issues/send-attempt-sweeper.md docs/superpowers/reviews/2026-09-27-share-sent-outcome/self-qa.md docs/superpowers/reviews/2026-09-27-share-sent-outcome/handback.md
git commit -m "docs(share-sent-outcome): three issues closed, the sweeper amended, self-QA and handback (T15)"
```

---

## Self-review (planner, revision 3)

- Round-2 findings folded: B-r2 1 (the reconcile sites are bounded, never propagated: WITHDRAW first, retried twice, then ERROR - deviation 11 and the spec's section 8 amended), B-r2 2 (the record fact's two meanings: not asked vs expired - deviation 12; a test pins an old route-failed share unflagged), B-r2 3-6 (T13: the delivered exception decides, the ledger follows the slot, the census forecasts with `ledgerWouldChange` and `wouldApply`, a claim is `retry_root` only, every case runs in one-share mode), B-r2 7 (`listingSendsApi.test.ts` and `contactsBatchReads.test.ts` in T7 with a seed helper), B-r2 8 (the list re-buckets Not confirmed too), B-r2 9 (the landlord relabel guarded and landlord-only), B-r2 10 (the impossible job test dropped; the retry-row copy-read test added), B-r2 11 (the ticker recount only on ticks, from `retryPending` rows - deviation 14), B-r2 12 (the withdrawal emit - deviation 13), B-r2 13 (the shared block's signatures, the work-map wording, the note-to-self).

- Spec coverage: D1 -> T2, T8, T9; D2 -> T1, T4, T5, T6; D3 -> T9, T10; D4 -> T1, T5, T9, T10; D5 -> T1, T2, T11; D6 -> T7, T12; D7 -> T3, T4, T5, T7; D8 -> T13; D9 -> T15; I1-I9 -> the Global Constraints and T1/T4/T6; section 5's surfaces each name a task; section 7's pins are listed in T1 (the identity pin), T7, T8, T9, T10, T14 and the harness parity in T1 and T3; section 0's "first task verifies 1b" is satisfied by the research record cited in the header.
- Placeholders: none; every test body is written out except where a task says which existing fixture to reuse by name.
- Type consistency: `applyAttemptOutcome(broadcastId, contactKey, expect, next, statsDelta)` (T1) is what T4 calls; `applyLaterAttempt(deps, input)` (T4) is what T5, T6 and T13 call with the same `LaterAttempt` shape (outcomes `sent` / `delivered` carry an optional `carrierSentAt`); `applyShareLedgerEntry(deps, { unitId, contactId, broadcastId, entry })` and `ledgerEntryFor(attempt, conversationId, outcome)` (T3) are what T4, T7 and T13 call; `putShareMemory(..., { token })` (T3) is what the doubles and T13 use; `resolveRecipientStates(deps, share, opts?)` / `retryPendingCount` / `unconfirmedByRow` / `reachedCount` / `priorRecipientKeys` (T2) are what T8, T9, T11 call; `deriveBroadcastStats(b, { retryPending, unconfirmedKeys })` (T1) is what T5, T9 use; `getByIds(ids, { projection })` (T1) is what T11 uses; `getByKeys` (T3) is what T12 uses; `stampRetryAttribution` (T13) lives in the messages repo and its double.
- Review Focus: the five lines each have an owning task and a test named in it (RF1's ledger half: T4's phone-keyed test now applies a `sent` outcome first and a `delivered` with `recipientContactId` second, so the entry lands).
- Round-1 findings folded: A1/B1 (the promise from the retry decision, with a test that copies the row image), A2 (the attempt-instant clock), A3/B5 (DeliveryBadge), A4/B4 (harness wiring), A5/B12 (the `shares_op` token), A6/B15 (no record reads outside the flag; bounded parallel reads), A7/B8 (D8's definitions and tests), A8/B9/B18 (tests written out; call-order pins; the crash-before-close re-run), A9/B10/B6/B14 (the pins named), A10/B11 (API facts in the header), A11/B16/B21 (the D2 rule's `queued` refusal, the carrier instant, the outcome mapping), A12 (the tone type and the clamp), A13/B20 (`individual` and `recordSend`), A14 (helpers copied; the ordering guard), A15/B19 (the 1b verification statement), A16/B21 (the guarded, projected batch read), B2 (the reconcile sites propagate), B3 (the same-attempt test), B7 (the results ticker recount), B13 (`registerHandlers` untouched), B17 (the pair contact's precedence), B21 (Slice 1's wording; T7 before T5).
- Known soft spots for round 2: T13 is still the least-specified task (the walk's paging and the record check are defined but the script body is a skeleton); T10's list-hook refetch is the one piece of new client machinery; T6's `Found` widening rides 1b's verdict type.
