# Task 5 adversarial review - Relay fan-out

Reviewed commit: `dc6f1410 feat: track transport across relay fanout`

## Verification

`npm run test -w @housingchoice/app -- test/relayApi.test.ts test/relayFanOut.test.ts`

- Sandboxed attempt: `EXIT 1` before test discovery because Vite could not create
  `app/node_modules/.vite-temp/...` (`EPERM`).
- Allowed-environment re-run: `EXIT 0`; 2 files, 94 tests passed.

The source read branches at `app/src/jobs/relayFanOut.ts:415-419`; the legacy
variant reaches none of classify, prepare, recipient initialization, aggregation,
or transport-result writes. The focused suite also explicitly proves the
schema-absent continuation and `queued_pending` release boundaries at
`app/test/relayFanOut.test.ts:166-191` and `338-356`.

## Findings

### M1 - Continuation filtering is incorrectly used as stale-roster filtering

`app/src/jobs/relayFanOut.ts:597-601` first applies `recipientKeys` to build the
continuation's send set. `preflightVersionedRecipients` then makes that filtered
set the `eligibleKeys` set (`:846`) and marks *every* slot outside it as
`excluded` (`:887-904`). This treats a current member omitted from one
continuation as if they had left the roster.

Deterministic reproduction: take a version-1 source with Alice as sender and
current roster Alice/Bob/Carol; give Bob and Carol queued, requested-SMS,
`planned` slots; dispatch a continuation with `recipientKeys: ['c-bob']`. Carol
is still in the current roster, but `eligibleKeys` is only Bob, so lines 887-904
write Carol `excluded`. No removal or suppression happened. The approved contract
requires stale reconciliation only for never-attempted members absent from the
current roster; continuation filtering limits who is sent in that job, not
membership.

Fix: retain a second set for the sender-excluded current roster and use that set
for stale reconciliation; use the continuation-filtered set only for preflight
initialization and that execution's send loop. Add the reproduction as a focused
worker test.

### M2 - A terminal suppressed slot is reopened from `excluded` to `planned`

For every selected current recipient, `preflightVersionedRecipients` changes an
`excluded` slot to `planned` (`app/src/jobs/relayFanOut.ts:872-883`) whenever it
has no actual transport. It does not distinguish a removed-and-rejoined member
from a slot previously excluded by suppression. The later loop sees the terminal
`failed` status and skips it (`:636-640`), so it never re-applies the suppression
exclusion.

Deterministic reproduction: persist a current recipient slot as
`{ status: 'failed', errorCode: 'contact_opted_out', requestedTransport: 'sms',
transportAggregationState: 'excluded' }`, then deliver an all-recipient job for
the same version-1 source. Preflight writes `planned`; the terminal-status guard
prevents the suppression branch. The final durable state is `failed` plus
`contact_opted_out` plus `planned`, contrary to the required excluded/not-sent
suppression representation. A later transport aggregator would count this leg as
pending rather than excluded.

Fix: only reopen an excluded slot when it is a never-attempted, non-suppressed
roster rejoin (at minimum exclude terminal slots and `contact_opted_out`), and add
a redelivery/rejoin distinction test.

## Other boundary results

- Version-1 source creation in both open and connecting team-send branches
  classifies from durable attachment presence plus media-store availability and
  persists schema/versioned requested intent on source and source-time slots:
  `app/src/routes/api.ts:1693-1727`, `1780-1822`.
- Version-1 results use `applyRecipientSendResult`, while legacy results retain
  `setRecipientDelivery`: `app/src/jobs/relayFanOut.ts:945-979`.
- Preparation occurs after request selection and per-leg presigning; attempted
  is set immediately before the prepared provider call: `:677-706`.
- The drift warning and new recipient-specific logs avoid raw member keys;
  member-bearing logs pass through `logSafeMemberKey`: `:622-630`, `657-672`,
  `716-722`, `735-741`, `754-761`.

PARTIAL/NEEDS_FIX
