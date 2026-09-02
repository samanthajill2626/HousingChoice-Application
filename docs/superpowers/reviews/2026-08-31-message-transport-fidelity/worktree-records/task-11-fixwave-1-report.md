# Task 11 fix wave 1 report

## Scope

Fixed the accepted Task 11 P2 in `dashboard/src/routes/contact/Timeline.tsx`.
Recipient transport presentation now runs only when the parent message has
`transport_schema_version: 1`. Schema-absent parent rows retain their legacy
recipient delivery text and accessibility names, while version-1 recipient slots
with no requested or actual transport still display `Unknown`.

## TDD evidence

- Red: `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
  exited 1 with 2 expected failures out of 135 tests. The sandbox attempt first
  stopped before test execution because Vite could not write `.vite-temp`; the
  allowed-environment run produced the behavioral red proof.
- Green: the same focused command exited 0: 1 file passed, 135 tests passed.
- `npm run typecheck -w @housingchoice/dashboard` exited 0.
- `git diff --check` exited 0.

## Coverage and behavior

- A revealed schema-absent Relay recipient remains `Keisha Kane - Delivered`.
- A revealed schema-absent Group MMS recipient remains `Keisha Kane - Delivered`.
- A version-1 recipient with neither transport fact remains
  `Keisha Kane - Delivered - Unknown`.
- The fix leaves the centralized version-1 `presentRecipientTransport` policy,
  requested-only opted-out presentation, excluded-without-code hiding, and
  existing delivery identity, status, and tone behavior unchanged.

## Files and commit

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`
- `043f1197 fix: preserve legacy recipient transport copy`

## Divergence

None. The accepted adjudication expressly permits gating recipient presentation
at the Timeline parent-message boundary, so `messageTransport` was not changed.
