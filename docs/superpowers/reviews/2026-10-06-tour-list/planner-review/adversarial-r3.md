# Planner review round 3 (final) - plan-blind adversarial pass - feat/tour-list @ 2243d9ef

Scope: fix wave 2, `git diff fcdcf9a5..2243d9ef -- . ":(exclude)docs/superpowers"`
(code-final 8e101714), read cold, plus a last sweep of the state it touches.
Plan-blind, read-only, nothing run; every claim checked at the cited lines.

Verdict: one LOW, introduced by f6b1bc88 (R3-1: after a user-pressed load,
the focus move also scrolls the viewport - a no-op when the user stayed put,
a jump when they did not or when focus falls back to the count line). No
other defect; the rest of the wave is correct. Notes are not ranked.

## f6b1bc88, read cold - the checks asked for

- Effect ordering vs the restore anchor. The anchor is a layout effect gated
  by `userActed` (`AllToursView.tsx:492-501`); every press arrives through
  pointerdown or keydown, so after a press the anchor can no longer focus,
  and the focus effect (a passive effect, `:538-563`) is the only mover. They
  cannot both move focus after the same press. Sound.
- The hook's transitions. The `started` gate is what makes this safe: a
  passive effect left pending from the previous commit is flushed before the
  press's render, sees the OLD `loader`, and waits rather than settling. Every
  way out of 'more' re-runs the effect, because the deps carry `data.loader`,
  `data.status`, `data.rows` and `listKey`: success, failure (Retry, same
  key), a second cursor 400 (Start over), and a first cursor 400 (epoch
  restart, same `listKey`). The last of these focuses the count line, which
  then reads "... The list was refreshed." That is right for a list restarted
  at page 1. Sound.
- StrictMode. Effects double-run only on mount, where `pendingFocus` is null.
  The `started` write is idempotent, no cleanup is needed, and refs survive
  the simulated remount. Sound.
- A filter change, a navigation or an unmount mid-request.
  - Filter change: `loader` becomes 'first', the effect settles, and the
    `listKey` check hands off. A->B->A is also safe: the chip the user
    clicked holds focus (Chrome); in Safari the guard sees body and focuses
    nothing new, because the restarted list's `rows.slice(rowsBefore)` is
    empty while it loads.
  - Unmount: the ref dies with the view, and the hook aborts its request.
  Sound.
- aria-disabled without `disabled`.
  - There is no form, and the buttons are `type="button"`.
  - A second activation is refused twice over: by `requestMore`'s
    `loader === 'more'` guard (`:399-410`) and by the hook's
    `state.moreInFlight`. React flushes a discrete event's update before the
    next event, so the second click sees the busy render.
  - Pointer clicks never reach the busy button
    (`ui/Button.module.css:17`: `[aria-busy='true']` sets
    `pointer-events: none` and dims it), so sighted users get feedback too.
  Nothing gets through.
- The empty-page follow after a Load more. The effect settles on the render
  where the automatic follow starts: the pressed control is hidden, so focus
  goes to the count line, as the Keep checking test pins. With rows above,
  that is R3-1.
- Screen readers. A focused `role="status"` element is read on focus, and its
  later updates are read as live-region changes. Some readers read it twice;
  this is a note, not a defect.

## The rest of the wave

- 21af7f10 `mergeRows` (`useAllTours.ts:97-118`): correct.
  - Every tour writer stamps `updatedAt` with `toISOString()`, and every seed
    tour carries one (cast `CQ`; matrix `updatedAt: createdAt`; live `iso`).
    So string order is time order, and a tie goes to the later read.
  - Edge notes only. A copy missing `updatedAt` never replaces and is never
    replaced; no writer produces one. Clock skew between the API and the
    worker can invert two writes less than a second apart.
- 5c769c1e: the byScheduledAt readers are now named correctly
  (`toursRepo.ts:13`, `tables.ts:521-522`, `:533-536`). These are comments
  only; `gen:tables` output is unchanged.
- b8fb412d, 634bb77a, 75e7f0f4, 8e101714: the TODO slug matches its new issue
  file, the issue texts match the code, and the R2-3 issue carries a probe to
  run first. ASCII-only.

## Contesting the rulings

Nothing left to contest. The deferrals of R2-3 and F5 are reasonable, and the
F1 record now carries both corrections.

## Findings

### R3-1 - LOW - After a user-pressed load, the focus move also scrolls the viewport, and its count-line fallback jumps to the top of the list

What: once a pressed Load more, Keep checking or Retry settles, the effect
calls `target.focus({ preventScroll: true })` and then
`target.scrollIntoView({ block: 'nearest' })` (`AllToursView.tsx:557-562`).
For the usual target, the first new row, that scroll is a no-op exactly when
it is harmless: the new row takes the place of the control the user just
pressed, so it is already in view. It only scrolls in two cases, and both are
jumps.

1. The fallback to the count line. When the load adds no visible row and
   leaves no action control, the target is the count line. That line sits
   ABOVE the list (`:710`), so `nearest` scrolls up to it. This happens when:
   - the page is empty and the list is complete. Under Any time this follows
     from the engine: when phase D ends exactly on a page boundary, the page
     carries a k-less cursor into the U phases (`tourListPage.ts:118-120`).
     If those phases are empty, the next Load more returns zero rows and
     completes;
   - the page is empty and hands over to the automatic follow - the
     behavior the Keep checking test pins, but over an EMPTY list, where the
     jump cannot show.
   This applies to mouse users too. `pendingFocus` is set on every click, and
   once the pressed control unmounts, `document.activeElement` is the body,
   so the guard lets the move through.
2. A user who scrolls away while a slow request runs. The guard looks only
   at focus. A wheel, touch or arrow-key scroll leaves focus on the busy
   control, so when the page lands, the scroll to the first new row pulls the
   viewport back. The anchor explicitly avoids this: it cancels on any of
   pointerdown, keydown, wheel and touchstart (`:492-501`). The new effect
   does not reuse that rule.

Scenario: Any time, 100 dated tours and no undated ones. Page 1 shows 50.
Load more brings 50 more and a k-less cursor. The user clicks Load more again
at row 100: the page is empty and the list is complete, the button unmounts,
and focus and viewport jump to the count line above row 1. In the
automatic-follow case there is a second cost: keyboard focus now sits at the
top of the list, while the follow appends its rows at the bottom.

Smallest fix:
- In the 'more' path, focus with `preventScroll: true` only and drop the
  `scrollIntoView` (the 'rebuild' path keeps it: a new list belongs at the
  top).
- When the list has rows, prefer the LAST visible row over the count line as
  the fallback. It sits where the pressed control was.
- Optionally cancel a pending 'more' focus on the anchor's four intent events
  after the press.
- Add a view test: a page of rows, then an empty complete page; assert focus
  on the last row and no `scrollIntoView` call on the count line.

## Notes (not defects)

- `pressed` is never cleared by design. It is read only while `loader` is
  'more', and only `requestMore` starts a 'more' load, so a stale value cannot
  show a wrong busy control.
- The count line's `tabIndex={-1}` makes it mouse-focusable as well. With
  `:focus-visible` styling, no ring shows after a pointer click.
