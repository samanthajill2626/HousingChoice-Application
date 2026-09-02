# Task 11 fix wave 4 report

## Scope and semantic decision

Implemented the accepted collapsed inbound Relay accessibility correction only.
An inbound Relay source with included recipient rows now renders a visually hidden
`role="group"` named by the existing `recipientSummaryName` result. The group is a
semantic owner for the always-available recipient recital; it is not a visible chip
and does not alter layout.

The recital reuses the already filtered and roster-ordered `RecipientRow` values,
the existing per-leg delivery presenter, the parent `transport_schema_version`
transport gate, recipient identity, and each non-empty formatted `row.when`.

## State constraints

- The owner is limited to `showRecipients`, inbound direction, and
  `rosterKind === 'relay'`.
- The inbound message's visible main transport remains actual-only. Recipient legs
  do not replace or aggregate that chip.
- Outbound rollups and all existing outbound accessible chip names are unchanged.
- Direct messages cannot enter the owner gate, and a focused native Group MMS guard
  proves `rosterKind="group_text"` does not receive it.
- The regression fixture proves one timed and one untimed leg before interaction:
  both identities, statuses, and normalized transports are in the accessible name;
  the recorded `9:25a` occurs exactly once; the untimed leg does not borrow the
  message's `9:14a`; and the visible source metadata remains `SMS` despite a
  malformed source-level requested `RCS` value.

## TDD and verification

- Separate sandbox pre-test: the requested focused command exited 1 before test
  discovery because Vite could not create its `.vite-temp` config (`EPERM`). This
  was environmental and not behavioral evidence.
- First red: the same focused command with the worktree writable exited 1 with
  1 failing and 157 passing tests. The new inbound Relay test could not find an
  accessible recipient group before interaction.
- Constraint red: after the minimal owner existed, the native-group guard exited 1
  with 1 failing and 158 passing tests because the owner was not yet Relay-only.
- Final focused command:
  `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.delivery.test.tsx`
  exited 0: 2 files passed, 159 tests passed.
- `npm run typecheck -w @housingchoice/dashboard` exited 0.
- `git diff --check` exited 0.
- Added-line ASCII check found 0 non-ASCII added lines.
- No e2e or aggregate suite was run, as required.

## Files and commit

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`
- `2470b871 fix: expose inbound Relay recipient accessibility`

## Divergence

None. `Timeline.delivery.test.tsx` did not need modification, and no new provider,
delivery, or visual behavior was added.
