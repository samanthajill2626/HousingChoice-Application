# Task 3 fix-wave 1 cold re-review

Reviewed `5296694a` as new pressured code against the live repository, the prior
Task 3 findings/adjudications, and the approved persistence contract.

## Required finding

### P1 - The new `sent`-only cleanup rule leaves a retried successful `queued` result carrying its old transient error

`app/src/repos/messagesRepo.ts:3271-3280` now removes an existing
`errorCode` only when `patch.status === 'sent'`; the webhook fake applies the
same restriction at `app/test/helpers/twilioWebhookHarness.ts:1465-1468`.
That closes the prior terminal-duplicate case, but it changes the broader
success cleanup contract into a `sent`-only rule.

The normal provider-result mapping makes this reachable: `mapTwilioStatus()`
maps Twilio `accepted`, `scheduled`, `queued`, and `sending` to internal
`queued` (`app/src/adapters/messaging.ts:557-573`), while the source slots are
seeded `queued` and the design explicitly identifies accepted as the common
provider result (`docs/superpowers/specs/2026-08-31-message-transport-fidelity-design.md:603-614`).
A continuation can therefore have
`{ status: 'queued', errorCode: '30003' }`, receive a successful accepted
result `{ status: 'queued', sid, sentAt }`, and retain `30003` forever. The
approved plan requires that a successful result clear a stale transient error
while permitting status to remain `queued`
(`docs/superpowers/plans/2026-09-01-message-transport-fidelity.md:91-93,
:527-533`).

Add the DynamoDB Local contract case for the queued same-status accepted result
and adjust real/fake cleanup to distinguish successful non-terminal results
from protected terminal duplicate/failure outcomes. Preserve the P1 protection:
`{ status: 'failed' }` must not erase an existing terminal diagnostic.

## Prior findings rechecked

- **P1 terminal duplicate diagnostics:** the specific prior loss is closed.
  A duplicate terminal `{ status: 'failed' }` no longer emits a `REMOVE`, and
  the new test at `app/test/messagesRepo.transport.test.ts:417-434` covers it.
  The P1 above is a newly exposed, broader success-cleanup regression.
- **P2 final conditional reclassification:** closed. After four conditional
  refusals, the repository now consistently re-reads and classifies the final
  slot (`app/src/repos/messagesRepo.ts:3337-3342`). The deterministic seam
  installs the fourth durable winner before raising the conditional failure and
  proves `idempotent` (`app/test/messagesRepo.transport.test.ts:437-474`). The
  classification preserves absent-only SID/time, actual-transport fallback,
  stale status, and protected terminal-error semantics.
- **P2 stale RCS observability:** closed. Both message and recipient stale RCS
  fallback paths now log at info with IDs/enums only; recipient member keys are
  redacted via `safeMemberKey()` (`app/src/repos/messagesRepo.ts:3008-3018,
  :3190-3202`). The repository test asserts non-warning safe logging
  (`app/test/messagesRepo.transport.test.ts:478-530`). No raw phone/channel
  address is added to the payload.

## Other fix-diff checks

- The final-state helper is consistent with the live per-attempt classification:
  it reports `idempotent` only when no requested independent child write remains,
  `stale` for stale status/RCS-after-fallback, and `conflict` for incompatible
  actual transport or remaining writes. It does not turn a possible write into
  a false idempotent result.
- The added DynamoDB expressions retain aliasing for every nested path and do
  not combine overlapping `SET`/`REMOVE` targets. The error removal condition
  guards the observed status, so a concurrent terminal transition cannot be
  erased by a stale send result.
- `git diff --check 52a924d7..HEAD` produced no whitespace errors.

## Focused proof

`npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts`
could not load Vitest in this sandbox (exit 1): Vite received `EPERM` opening
`app/node_modules/.vite-temp/vitest.config.ts.timestamp-...mjs` before any test
executed. No working-tree files were changed by this review.

PARTIAL/NEEDS_FIX
