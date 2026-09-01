# Slice 4 report - dashboard presenters

Commit: `06065e04aa7fd1cea4cf8f033777086a85bc1039` (`feat: present relay external caller facts`)

## Shipped

- Added the three persisted non-member caller fields and response-only hydrated
  display name to dashboard `Message` and `TimelineCall` types.
- Preserved the relay call mapper's metadata-only policy while forwarding the
  refusal reason only when exactly `non_member` and every other new value only
  when it is a string.
- Added the pure `presentRelayExternalCaller` presenter. It never reads a roster
  or matches a phone, requires a non-empty stored contact ID before using a
  hydrated name, and otherwise uses the formatted stored phone or the approved
  unknown-caller copy.
- Made the existing call-state presenter show `Not connected` before every old
  lifecycle clause for the explicit non-member reason; calls without that reason
  retain the existing matrix.
- Added `formatDateTimeWithSeconds`, preserving the compact seconds formatter's
  existing invalid-input empty-string contract.

## TDD and verification

- RED: focused dashboard Vitest run exited 1 with the expected missing presenter,
  missing formatter, missing mapper fields, and old `Voicemail` state failures.
- GREEN: `npm run test -w @housingchoice/dashboard -- src/routes/conversation/useRelayThread.test.tsx src/routes/contact/presentRelayExternalCaller.test.ts src/routes/contact/presentCallState.test.ts src/routes/contact/format.test.ts` exited 0: 4 files, 126 tests passed.
- `npm run typecheck -w @housingchoice/dashboard` exited 0.
- `git diff --cached --check` passed before commit.

## Scope

Only the assigned nine dashboard type, mapper, presenter, formatter, and test
paths were committed. `Timeline.tsx` remains untouched for the next slice.
