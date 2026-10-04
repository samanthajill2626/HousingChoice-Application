# Code review r3 - adversarial, plan-blind - feat/properties-available-view

Reviewer: adversarial plan-blind reviewer (Claude Opus 5.5).
Scope: 2eae6330..HEAD at e9b9e421 (the r3 fix package) plus the round-2
adjudications. No specs or plans were read.
Method: code reading plus one throwaway vitest probe file (2 tests, run once
with a single worker while the e2e gate was running; now deleted). The source is
in `.superpowers/sdd/adversarial-reference.md` (round 3 section).
Versions: react / react-dom 19.2.7, react-router(-dom) 7.18.0.

Severity = consequence if it ships unfixed. **3 findings: 0 BLOCKING, 0 HIGH,
0 MEDIUM, 3 LOW.** Round-2 ruling A2-4 is conceded at the end.

---

## R3-1. LOW - The pending-navigation guard reads a PASSIVE-effect snapshot, so a filter change landing just after a PUSH/POP commit is wrongly skipped

**What is wrong.**
- **How the guard works.** `persist` skips its write when
  `historyIdx() !== committedIdx.current` (`dashboard/src/routes/listings/ListingsList.tsx:251-252`).
  `committedIdx` is refreshed in a `useEffect` keyed on `location.key`
  (`ListingsList.tsx:241-244`).
- **The stale window.** After a transition commit, React runs passive effects in a
  later scheduler task. It does not flush them before running a discrete event's
  handler (`dispatchDiscreteEvent` at
  `node_modules/react-dom/cjs/react-dom-client.development.js:23542-23557`). So for
  every PUSH and POP that keeps the list mounted, there is a window between the
  commit and the effect where `committedIdx` still holds the previous entry's idx
  while the browser's idx has moved.
- **The effect of a click in that window.** A chip, dropdown, Clear or "Show all
  statuses" click there is treated as "navigation pending":
  - `setChosen` applies it, so the chip lights;
  - the URL write is silently dropped.

  Nothing re-persists it, so reload, Back from a property page, or a copied link
  loses that choice.
- **Which navigations open the window.** Those that keep the list mounted and ready:
  a summary count (PUSH) and Back/Forward between list entries (POP).
- **The ruling text does not match the code.** The A2-5 ruling describes a
  `window.history.state.key` versus `location.key` check. The code compares `idx`,
  which is the better choice: the key also changes on the page's own REPLACE, so a
  key check would skip a second chip tap made while the first write is in flight.

**Evidence (probe, real BrowserRouter).** A sibling placed before `<Routes>` has its
passive effect run before ListingsList's. From that effect it clicks 2-BR right
after a count's PUSH commits.
- **Result:** the 2-BR chip is pressed, but `window.location.search` stays
  `?status=setup&ha=dca`.
- **Control:** the same click from a sibling placed after `<Routes>` (so after the
  idx effect) is written as `?status=setup&voucher=2&ha=dca`.

**Failure scenario.**
1. On a slow phone with a long list, a tap queued while the count's or Back's commit
   task runs is processed before React's passive-effect task.
2. The tapped chip shows as on, but the URL never records it.
3. Opening a property and coming Back, or reloading, drops it with no sign anything
   was lost.

**Suggested fix.**
- Minimal: capture the committed idx in `useLayoutEffect`, which runs inside the
  commit, so there is no window.
- Exact: keep a ref of the history keys the page's own writes created and skip only
  when `window.history.state.key` is neither the committed `location.key` nor one of
  those.
- Either way, record the mechanism actually used in the adjudication.

---

## R3-2. LOW - Three new tests or comments claim more than they pin

**(a) The perf terminal-copy test cannot detect a rename of the rows list.**
- The test (`e2e/performance/routes.test.ts:827-846`) only requires each terminal
  name to appear somewhere in `ListingsList.tsx`.
- The populated alternative's name, `Properties`, also appears in the header comment
  (`ListingsList.tsx:1`), the h1 (`ListingsList.tsx:298`) and the nav label
  (`ListingsList.tsx:311`), as well as on the rows list (`ListingsList.tsx:413`).
- So renaming the list's `aria-label` would still pass, while every warm `/listings`
  sample turned `unknown`. The other three names happen to be unique strings, so
  their checks hold.

**(b) The e2e spec does not prove the row-open save in a real browser.**
- Step 5's comment says it proves the row-open save there
  (`e2e/tests/dashboard-next/properties-available-view.spec.ts:156-159`).
- But Chromium moves focus to the link on mousedown, so the BLUR save writes `q`
  first; the row's `onOpen` then finds nothing to change.
- The path that exists for iOS (no blur) is pinned only in jsdom, by "opening a row
  saves the search even when the box never blurred" (`ListingsList.test.tsx:796`).
- Fix: in the spec, dispatch the click without moving focus (e.g.
  `link.dispatchEvent('click')`), or reword the comment.

**(c) "so that navigation wins" is not verified.**
- The test (`ListingsList.test.tsx:815-834`) fakes the pending navigation with a raw
  `pushState` that the router never commits.
- It proves only that the write is skipped. It does not show that the pending
  navigation is then adopted. The name should say "skips"; adoption would need a
  real popstate or Link navigation.

---

## R3-3. LOW - "Show all statuses" now focuses the status select with default scrolling, jumping a phone user away from the rows it revealed

**What is wrong.**
- `statusRef.current?.focus()` (`ListingsList.tsx:426-431`) scrolls the select into
  view.
- On a 360 px phone, the summary table, both chip groups and the search box sit
  between the select and the rows. A user who scrolled down to "No available
  properties right now." and tapped the button is moved back up to the controls,
  with the newly listed rows pushed toward or past the bottom edge.
- UNVERIFIED: jsdom has no layout, so this comes from the page order, not a
  screenshot.

**Suggested fix.** `statusRef.current?.focus({ preventScroll: true })` keeps keyboard
focus on the control that changed without moving the viewport.

---

## Round-2 rulings

- **A2-4 (the idle-timer write): conceded.** The design note now documents the
  Back/Forward limitation, and the row-open save covers the no-blur iOS path.
- The other round-2 rulings were accepted or deferred as filed. There is nothing
  further to contest.
