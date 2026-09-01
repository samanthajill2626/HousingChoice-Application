# Slice 2 - voice refusal caller identity

## Scope

- `app/src/routes/webhooks/voice.ts`
- `app/test/voiceWebhook.test.ts`

## Implementation

- After the existing refusal branch has derived `reason === 'non_member'`, normalize
  `From`, look up the contact once, and retain only a non-deleted contact ID.
- Preserve the normalized phone when present even if the lookup fails; log only the
  CallSid and a fixed operational message on that new best-effort failure path.
- Supply the three S1 fields only to the existing non-member append. All routing,
  refusal, TwiML, author, relaySenderKey, status, outcome, event, and append-catch
  behavior is unchanged.

## TDD evidence

- RED: `npm run test -w @housingchoice/app -- test/voiceWebhook.test.ts` exited 1
  after the new tests were added and before the implementation. Six new identity
  assertions failed because `relay_refusal_reason` and identity fields were absent;
  34 existing tests passed.
- GREEN: `npm run test -w @housingchoice/app -- test/voiceWebhook.test.ts test/repos.test.ts`
  exited 0: 2 files, 60 tests passed.
- GREEN: `npm run typecheck -w @housingchoice/app` exited 0.

The first red attempt could not load Vitest because the sandbox denied Vite's
temporary config write in the isolated worktree; the same focused command was then
rerun with approved worktree write access and produced the red result above.

## Commit

`ec5409fc feat: retain non-member relay caller identity`

## Residual risk

The no-pool-number refusal is unreachable through the ordinary pool-number lookup
because a selected relay normally needs a pool number. Its preservation test injects
that existing anomaly into the signed-webhook harness. The normal non-member,
closed-thread, and no-callee paths use ordinary routing.
