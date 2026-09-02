# Slice 5 report: call-card UI

Completed: 2026-08-28T15:11:29-04:00
Commit: `b526819d feat: explain unconnected relay calls`

## Scope

- Updated `dashboard/src/routes/contact/Timeline.tsx`.
- Extended `dashboard/src/routes/contact/Timeline.test.tsx`.
- Did not change `Timeline.module.css`; the existing `cardMeta` and
  `cardRevealed` contract already provides the required collapsed details layout.

## Behavior shipped

- Exact non-member refusals use the external-caller presenter ahead of roster
  inference and display `Not connected`.
- The card face is plain text. Details always exist for an external caller and
  contain the caller phone or Caller ID unavailable, the non-member explanation,
  a qualified View contact link or No linked contact, and a full local timestamp
  with seconds.
- Existing generic and relay-member card behavior remains on the prior detail
  path.

## TDD and verification

- Red: `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`
  exited 1 after adding six external-caller integration tests. The prior renderer
  showed generic Incoming call/Missed cards and no external Details controls.
- Green: the same focused file exited 0: 1 file, 123 tests passed.
- Green: `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/presentRelayExternalCaller.test.ts src/routes/contact/presentCallState.test.ts src/routes/contact/format.test.ts src/routes/conversation/useRelayThread.test.tsx`
  exited 0: 5 files, 249 tests passed.
- Green: `npm run typecheck -w @housingchoice/dashboard` exited 0.

The first unprivileged test attempt could not open Vite's worktree-local temporary
config file (`EPERM`); the authorized rerun produced the reported red and green
test evidence.
