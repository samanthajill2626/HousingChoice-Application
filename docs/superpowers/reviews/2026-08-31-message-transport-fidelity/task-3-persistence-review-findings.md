# Task 3 persistence review findings

Reviewed commit: `52a924d7 feat: persist versioned message transport facts`

## Required fixes

### P1: duplicate terminal callbacks can erase the retained provider diagnostic

`app/src/repos/messagesRepo.ts:3215` treats every same-status result as eligible
for error cleanup. A duplicate `{ status: 'failed' }` result removes an existing
terminal `errorCode`, although only a successful result may clear a transient
error. The webhook harness mirrors the behavior. Add a failing repository test,
preserve terminal diagnostic data, and keep the fake behavior aligned.

### P2: the final conditional failure is not consistently reclassified

`app/src/repos/messagesRepo.ts:3155` retries conditional failures, but returns
`conflict` after the last failure without the required final consistent read. A
concurrent identical winner can therefore be reported as a conflict. Re-read and
classify the final state through the approved transition rules; add a deterministic
test seam or contract test for that race.

### P2: expected stale RCS callbacks are silent

`app/src/repos/messagesRepo.ts:2956` and `:3125` return stale when a requested
RCS observation arrives after durable SMS/MMS fallback but do not emit the required
safe info/debug log. Add a non-warning structured log using only safe IDs/enums and
mirror the observable contract if the shared webhook fake is expected to represent
it. Test the repository behavior.

## Review proof

The independent reviewer attempted the focused repository command, but Vite failed
before test execution on a sandbox `.vite-temp` EPERM. The implementation report
already records a green allowed-environment focused run (19/19) and app typecheck
exit 0. The findings above are source-derived and include concrete reproduction
shapes in `.superpowers/sdd/task-3-review.md`.
