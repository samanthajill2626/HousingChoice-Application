# Post-main-sync adversarial review

Status: FAIL

Scope: staged merge result against HEAD (feature parent) and MERGE_HEAD (main
parent). I inspected the ten recorded conflict files, their direct persistence
and caller seams, and the affected test doubles. No test suite or E2E command
was run.

## Findings

### P1 - A capped duplicate can close an in-flight relay pass and persist a false failure

`relay.fanOut` suppresses only a duplicate envelope jobId, not two distinct
envelopes for the same source (`app/src/jobs/relayFanOut.ts:728-743`). Each
execution then takes its own source snapshot (`app/src/jobs/relayFanOut.ts:770-795`,
`app/src/jobs/relayFanOut.ts:1026-1056`) and derives pending recipients from
that stale snapshot (`app/src/jobs/relayFanOut.ts:1093-1096`).

The durable counter makes one worker's third claim succeed while a concurrent
worker receives `capped` (`app/src/repos/messagesRepo.ts:3373-3418`). The
capped worker immediately calls `closeRelay` (`app/src/jobs/relayFanOut.ts:1097-1113`),
which decides terminality from its stale snapshot and writes `failed` for each
slot (`app/src/jobs/relayFanOut.ts:1060-1074`). It does not distinguish a
spent counter from a previously claimed pass that is still sending.

If the winning worker has already called Twilio but has not yet persisted its
result, the capped worker stores `failed/transient_cap` first. The winning
versioned result is then stale because `sent` is allowed only from `queued`
(`app/src/repos/messagesRepo.ts:132-141`) and `applyRecipientSendResult`
returns stale without replacing that terminal failure
(`app/src/repos/messagesRepo.ts:3238-3257`,
`app/src/repos/messagesRepo.ts:3328-3371`). The recipient receives a text but
the application records it as failed. On the legacy path the later/staler
whole-slot write is worse: `persistRelayRecipientResult` still calls
`setRecipientDelivery` (`app/src/jobs/relayFanOut.ts:1428-1462`), which uses
an unconditional replacement of `delivery_recipients.<memberKey>`
(`app/src/repos/messagesRepo.ts:3420-3440`) and can erase a completed slot.

Make a source-level pass claim represent in-flight ownership, and do not cap-
close recipients until the last claimed pass is known complete. Alternatively,
make close atomically re-read and condition on an open slot plus no active
claim. Add a barrier-based test with two different job IDs for the same source:
one wins the last pass and pauses after provider acceptance, while the other
gets capped. Cover both legacy and versioned rows; neither may persist
`transient_cap` over the winning send.

The current close tests are sequential and therefore cannot expose this race
(`app/test/relayFanOut.test.ts:931-1079`); the fake claim also completes without
an await point (`app/test/helpers/twilioWebhookHarness.ts:1487-1501`).

## Surfaces attacked without additional actionable findings

- Merge-parent behavior preservation in relay fan-out, tour reminders,
  messages persistence, Timeline, selectors, and the five conflicted test files.
- Durable counter missing/capped paths, enqueue-failure close, callback status
  ordering, legacy versus versioned slot writes, and transport intent versus
  observed transport persistence.
- Superseded reminder pointer rotation, conditional sweep ownership, force-send
  refusal, poll suppression, and preview callers.
- Timeline stream anchor, upcoming block placement, scroll/pill state, and
  region naming.
- Log error serialization, personally identifying fields in the new close log,
  test fixture fidelity, and selector documentation.

## Follow-up: production reachability and remedy

### Producer inventory

There are four production producers of `relay.fanOut`:

1. The inbound Twilio relay path, only after a non-deduped append
   (`app/src/routes/webhooks/twilio.ts:738-751`). The message append is the
   producer-side dedupe here, so ordinary duplicate webhooks do not enqueue a
   second source job.
2. The open relay team-send path, after it appends a new source row
   (`app/src/routes/api.ts:1804-1839`). Its generated source SID is new per
   accepted send; it is not a same-source dedupe mechanism.
3. The queued-pending release path
   (`app/src/services/relayQueuedMessages.ts:45-99`). This is a real
   same-source duplicate producer: two flushes can both list one
   `queued_pending` row; one wins the status transition, but the other ignores
   the false return from `updateDeliveryStatus` and still enqueues a fresh job.
4. The fan-out continuation itself
   (`app/src/jobs/relayFanOut.ts:1283-1310`). It creates a fresh envelope for
   each accepted continuation.

Every `enqueue` generates a fresh UUID jobId
(`app/src/jobs/jobs.ts:107-160`, `app/src/jobs/jobs.ts:164-195`), so the
handler's jobId marker cannot suppress the two jobs emitted by an overlapping
flush. This overlap is production-reachable: `relay.numberReady` deliberately
re-enters the flush for an already-open group during redelivery/recovery
(`app/src/jobs/relayNumberReady.ts:97-118`) and also invokes it on the original
open path (`app/src/jobs/relayNumberReady.ts:174-183`). The existing
queued-pending-to-queued update is not a durable enqueue handoff; a producer
only change that simply honors its false return would also leave a crash between
that update and enqueue unrecoverable. That does not make the relay race safe.

### Evaluation of the candidate remedies

#### A. Return on capped

Reject. It avoids the false close only by leaving a source whose durable count
is already capped and has no active worker with queued recipients forever. That
removes the D8 close-B recovery behavior currently exercised at
`app/test/relayFanOut.test.ts:998-1036`.

#### B. Conditional slot writes and permit transient_cap to become success

Reject. A conditional close can still win after the other worker has submitted
to the provider but before that worker has written a SID or status. Permitting
`failed/transient_cap` to advance to `sent` or `delivered` then makes terminal
delivery state non-monotonic and treats a cap decision as if it were provider
evidence. That contradicts the current forward-only state machine
(`app/src/repos/messagesRepo.ts:132-145`,
`app/src/repos/messagesRepo.ts:3232-3371`) and cannot preserve the deliberate
legacy-versus-v1 split: legacy uses `setRecipientDelivery`, while v1 uses the
transport-aware `applyRecipientSendResult`
(`app/src/jobs/relayFanOut.ts:1428-1462`).

#### C. Source-level in-flight owner or lease

Recommend. This is the smallest solution that supplies the missing fact: when
the counter is capped, whether an authorized pass is still in progress. Extend
the durable source claim with an owner token and active state. A different
envelope for the same source must return `in_flight` without sending or closing
while that owner is active. The owner retains or transfers its token to a
successful continuation, and conditionally releases it only after the final
pass has persisted its terminal outcomes or performed the enqueue-failure
close. A `capped` outcome is allowed to close only when there is no active
owner. Thus a pre-existing capped source with no owner still gets close-B
recovery, while a competing job cannot erase an in-flight provider result.

Keep this owner protocol outside `delivery_recipients` and apply it identically
to schema-absent and v1 source rows. That serializes the risky fan-out writers
without routing legacy rows through v1 transport mutations or weakening the v1
transport evidence rules. If an expiry/recovery policy is needed, it must be a
separate, explicitly fenced handoff or reconciliation path; blindly declaring
an expired owner failed reintroduces the same unknown-provider-outcome problem.

#### D. Producer dedupe only

Reject. It can reduce one ingress, but it cannot protect continuations or any
future/manual producer, and it cannot safely repair the queued-pending crash
window described above. The durable source, not a producer-local job ID, is the
only common arbitration point.

Recommendation: implement C, with a barrier-based regression test that starts
two different job IDs for one source, pauses the owner after provider acceptance,
and proves that the second job neither sends nor closes. Run it for a legacy
source and a v1 source, and retain the no-active-owner capped close-B test.
No human product decision is required; this is a correctness constraint.

## Follow-up: deterministic logical-pass execution marker

Verdict: reject a key derived from source identity plus normalized
`payload.attempt` as a replacement for the source-level in-flight owner. It
would suppress the narrow nominal duplicate: the two queued-pending flush jobs
omit `attempt`, so parsing normalizes both to 1 before the marker is written
(`app/src/jobs/relayFanOut.ts:154-184`), and the conditional marker put would
admit only one (`app/src/repos/messagesRepo.ts:2850-2868`). It likewise
suppresses an exact SQS delivery retry. That is not enough to establish that a
job is the sole owner of the durable pass.

The attempt in an envelope is advisory, not a durable-pass identity. The parser
accepts any positive integer and defaults absent or malformed values to 1
(`app/src/jobs/relayFanOut.ts:154-184`), while `claimFanoutPass` advances the
source counter without comparing that input (`app/src/jobs/relayFanOut.ts:1093-1113`,
`app/src/repos/messagesRepo.ts:3373-3418`). A fresh or malformed envelope can
therefore use marker 2 while the actual first pass is in flight, pass the marker,
and advance/close the same source. Conversely, an old envelope normalized to 1
can collide with an unrelated recovery of a later durable pass. The marker only
dedupes a claimed label; it cannot establish that the label corresponds to the
currently authorized counter value.

It also widens the existing pre-send suppression boundary in a material way.
The current marker is keyed by the UUID envelope jobId, which is new for each
enqueue (`app/src/jobs/jobs.ts:107-160`, `app/src/jobs/jobs.ts:164-195`). A
crashed job suppresses its exact redelivery, but a deliberately fresh recovery
job can still enter the claim. Replacing that key with source-plus-attempt makes
every fresh recovery for that pass return before the claim because the marker
row is retained by the conditional put (`app/src/repos/messagesRepo.ts:2850-2875`).
Thus a normal source which once ran pass 1 can no longer use an attempt-omitted
recovery envelope to reach the capped no-owner close-B branch; it is not enough
that legacy/in-flight rows created before the change lack a logical marker. This
is an additional recovery hole, even though both markers suppress a crash of
their own original envelope.

The conclusion is the same for legacy and v1. The proposed marker sits before
the source is read and before the handler selects the legacy whole-slot or v1
transport-aware writer (`app/src/jobs/relayFanOut.ts:717-795`), so it neither
repairs the legacy stale-slot overwrite nor provides v1 evidence ordering. A
mislabelled duplicate can still reach the shared claim/cap branch and then use
the respective path's close writer. Keeping the legacy-v1 split is necessary,
but it is not an ownership protocol.

Retain the exact jobId marker and implement the source-level owner/lease from
remedy C. If an additional deterministic marker is desired, mint its pass token
from the authoritative source claim and bind it to that owner; do not derive it
from `payload.attempt`. That is effectively the same source-owner protocol and
must include an explicit recovery handoff. A payload-derived logical marker is
not a sound alternative and does not preserve both active-final-pass safety and
capped-at-start recovery.

Counts: P1=1, P2=0, P3=0.
