# Task 11 fix wave 5 report

## Scope

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`

No divergence from the assigned scope.

## TDD evidence

1. Added a post-reveal lifecycle assertion to the existing inbound Relay collapsed-accessibility test before changing production code.
2. Initial focused test command hit the separately reported Vite temporary-config `EPERM` sandbox write denial (exit 1), without executing tests.
3. Re-ran the exact focused command with isolated-worktree write access before the production change: exit 1, 1 file, 136 passed and 1 failed. The new assertion found the still-mounted named `group` summary after reveal.
4. Changed only the hidden summary render guard to require `!revealed`.
5. Re-ran the exact focused command: exit 0, 1 file, 137 passed.

## Verification

- `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx`: exit 0, 1 file, 137 tests passed.
- `npm run typecheck -w @housingchoice/dashboard`: exit 0.
- `git diff --check`: exit 0.

## Lifecycle guarantee

While an inbound Relay bubble is collapsed, the visually hidden named summary retains the complete recipient recital. After the bubble reveals, that summary is unmounted and the named visible recipient list is the sole accessible recital. The source transport and recipient filtering remain unchanged.

## Commit

`db825e08 fix: avoid duplicate Relay recipient announcements`
