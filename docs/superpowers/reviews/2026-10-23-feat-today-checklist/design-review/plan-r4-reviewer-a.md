# Plan review r4 - reviewer A (PR107 / Task S2.2a only)

Scope: commit 3eda94ef (PR107, Task S2.2a, the work-map row for R3-2).
Read-only; no tests run.

## 1. [LOW] Rows written before the deploy carry no marker, so a post-deploy staff Retry of an old failed Send-now row still stamps

What is wrong. PR107 closes R3-1 for every chain started after the deploy.
The Send-now writers (S2.2 3c2), the manual Retry (S2.2 3c), the automatic
retry (S2.2a 3a) and the reconcile adoption (3b) now all carry the marker.
W2 judges only the pressed row's own `broadcast_id` / `automated` /
`system_copy` (S2.2 3c). Rows written before the deploy have no
`system_copy`:
- a failed tour-reminder or nudge Send-now row (stored `automated: false`,
  `jobs/tourReminders.ts:2004`, `jobs/placementNudges.ts:860`);
- a failed manual Retry of an automated text (the route always stores
  `automated: false`, `api.ts:1877`);
- an automatic retry row of either (`retrySend.ts:556` copies
  `automated: false`).
A staff Retry pressed on one of these after the deploy passes the W2 gate
and stamps. The backfill catches the same history through its body and
chain-root rules (PR105), but a live stamp is forward-only and the backfill
cannot remove it.

Evidence. UNVERIFIED how long a failed row stays retryable: the Retry route
applies no age bound that I could find (`api.ts:1700-1760`), so any failed
pre-deploy row is eligible.

Implication. This is a transient, rare residue (a failed Send-now row from
before the deploy that staff retry afterwards), and it ages out as such rows
stop being pressed. Either record it as accepted residue in the S2 report
beside the closed PR100 line, or have W2 also apply the backfill's judgment
to the chain root. The route already resolves the root (`api.ts:1771`) and
has its consistent reads; this would mean one extra consistent read plus the
body rules. Not proposed as scope.

---

## Checked and found sound

Completeness (charge 1). Every path that appends a row of an existing
one-to-one chain:
- the automatic 30003 retry (`retrySend.ts:551-566`): fixed by 3a. Its
  re-drive comes back through the same job.
- the reconcile: every `retry_send` adoption, the listed orphan and the
  known SID alike, goes through `adopt` -> `adoptRetry`
  (`sendReconcile.ts:840-861`) and its single append (`:923-943`), so 3b
  covers both. The `broadcast` adoption writes share rows, which carry
  `broadcastId` and are W2-excluded. The `relay_leg` / `relay_rung`
  adoptions write relay slots, which W2 cannot reach (sendMessage refuses
  relay threads).
- the manual Retry route: it writes no attempt record of its own (it only
  READS the automatic retry's record, `api.ts:1760-1783`), so no reconcile
  ever re-creates a manual retry row; it marks its own row (S2.2 3c).
- the status webhook only enqueues the same retry job. No dev seam re-sends
  an existing row.
- `messagesRepo.append` is the only row builder (one item literal,
  `messagesRepo.ts:2583-2650`). The other PutCommands in that file write
  pointers, markers and media.

Task S2.2a, cold (charge 2):
- Code anchors exist and are unique. In `retrySend.ts`, the
  `retryRoot,` / broadcast spread / `beforeProviderSend: async () => {`
  block is at :563-566, and `beforeProviderSend` occurs once. In
  `sendReconcile.ts`, `retryRoot: o.retryRoot,` followed by the broadcast
  spread and `});` occurs only at :942-943; the other `retryRoot: o.retryRoot`
  hits, :1514, :1541 and the log lines, sit in different blocks.
- The 1a anchor is S2.2 1h's inserted text (plan S2.2 1h ends with that
  `contact.updated` line and then the `7b` title). The 1b anchor (the
  A-6 title) is at `retrySendAttempt.test.ts:1535`, after `pressRetry`
  (:1528), so the new case can use it. The 1c anchors are the case 10
  title at `sendReconcile.test.ts:3105` and the absent-field list at :3135,
  both inside `describe('retry_send owner ...')` (:3025).
- The helpers exist with these signatures. In retrySendAttempt.test.ts:
  `wire()` (:99), `seedRetried(sid, Partial<NewMessage>)` (:178, returns
  the live stored row), `run(row)` (:251) and `pressRetry(row)` (:1528,
  the REAL route with a world-backed injected service). In
  sendReconcile.test.ts: `register()` (:109), `seedOneToOne()` (:3033),
  `seedRow(sid, Partial<NewMessage>)` (:3046), `rOwner` (:3065),
  `reconciling` (:214), `factsFor(phone)` (:201), `plant` (:232),
  `runCheck` / `payloadOf` (:247, :227) and `retryRow(retried, attempt)`
  (:3072). `systemCopy` is a `NewMessage` field after S2.1a, and the
  harness fake maps it (PR106).
- Each stated RED is real:
  - 1a and 1b fail on the new row's missing `system_copy`, the first
    assertion in each;
  - 1c fails because `adoptRetry` writes none;
  - case 10's added absence passes already.
- 1b's 201 path is new for `routeApp` (every existing A-6 case stops at 409).
  It passes every route guard for the auto-retry row:
  - not failed: the test sets the row undelivered;
  - no live promise: the job writes it on the retried row;
  - no children;
  - the R6 record: it is keyed at `(retry_attempt ?? 0) + 1 = 2`
    (`api.ts:1771-1782`), and none exists.
  W2 then reads the inherited marker.
- No later task quotes text from `retrySend.ts`, from `sendReconcile.ts` or
  from the edited regions of the two test files. S3.1's sendReconcile.test.ts
  edit sits in the relay owners describe.

Correctness (charge 3): carrying the marker where `automated` is carried
matches the inheritance design of PR104. Neither writer gains a stamp. The
end-to-end case is the R3-1 scenario exactly.
