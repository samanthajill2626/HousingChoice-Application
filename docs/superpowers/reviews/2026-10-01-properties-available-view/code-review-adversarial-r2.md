# Code review r2 - adversarial, plan-blind - feat/properties-available-view

Reviewer: adversarial plan-blind reviewer (Claude Opus 5.5).
Scope: 91204da2..HEAD at 0dc265d5 (the r2 fix package) plus the round-1
adjudications. No specs or plans were read.
Method: code reading plus throwaway vitest probes and two mutants (now deleted).
Sources and the mutation recipe are in `.superpowers/sdd/adversarial-reference.md`
(round 2 section).
Versions: react / react-dom 19.2.7, react-router(-dom) 7.18.0.

Severity = consequence if it ships unfixed. **7 findings: 0 BLOCKING, 0 HIGH,
0 MEDIUM, 7 LOW.** R2-3 and R2-7 contest adjudications A6 and A11. A2 and A13
are conceded at the end.

---

## R2-1. LOW - While a view is loading, the PRUNED selection leaks into URLs: the current tab's href and any blur write drop every authority key

**What is wrong.**
- **The selection is pruned against loaded units.**
  `selection = pruneSelection(chosen, authority)` (`dashboard/src/routes/listings/ListingsList.tsx:194`),
  and `authority` comes from the loaded units (`ListingsList.tsx:191`). While a view
  loads, `units` is `[]` (`useListings.ts:48`), so the prune has no options and drops
  EVERY `ha` key.
- **Two URL builders serialize that pruned selection.**
  - The current tab's link: `currentSearch` (`ListingsList.tsx:235, 262`). Round 1
    used the raw `searchParams` here, so this is new.
  - `persistSearch` on blur (`ListingsList.tsx:221-223`).
- **The write is never read back.** It is a REPLACE (or the link click is a PUSH of
  the stripped URL). So once the units arrive, the chips (built from the unpruned
  `chosen`) can show an authority as selected while the URL no longer carries it.

**Evidence (probes).**
- **Current tab while loading.** On `/listings?status=all&ha=dca`, the Active tab's
  href is `/listings?status=all`. Clicking it navigates there, and after load no
  authority chip is pressed and both properties show.
- **Blur while loading.** Focus the search box on the Deleted tab, then Back (POP) to
  `/listings?ha=dca` while Active is still loading, then deliver a blur. The URL
  becomes `/listings`. After load, the DCA chip is pressed and the rows are DCA-only,
  but the URL has no `ha`.

**Failure scenario.**
- **Tab click.** Staff return to Properties with an authority filter in the URL (Back
  from Deleted, or a bookmarked link). While the full unit walk loads they click (or
  middle-click / copy) the highlighted Active tab, and the filter is gone.
- **Blur.** The real-browser trigger needs the box to keep focus into the loading
  state (keyboard or mouse-button Back between tabs) and then receive a blur, such as
  a window blur. UNVERIFIED in browsers.

**Suggested fix.** Prune only once the view's units are ready:
`selection = status === 'ready' ? pruneSelection(chosen, authority) : chosen`. The
controls and rows are hidden while loading, so an unpruned selection cannot filter
invisibly then. Alternatively, skip URL writes while `status !== 'ready'`.

---

## R2-2. LOW - The REPLACE guard skips EVERY replace navigation, not only the page's own writes

**What is wrong.** Adoption is gated on `navigationType !== 'REPLACE'`
(`ListingsList.tsx:184-187`). Three places describe this as skipping only the page's
own writes:
- the header: "every navigation that is not one of this page's own REPLACE writes"
  (`ListingsList.tsx:18-21`);
- `AuthoritySummary.tsx:23-25`;
- the resolution note in `docs/issues/properties-authority-filter-invisible-lock.md:15`.

But react-router also issues a REPLACE for any Link whose target equals the
committed location (`node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:10796`).
One example is the sidebar Properties NavLink to `/listings`
(`dashboard/src/app/nav.ts:71`) while the committed URL is bare. That navigation is
skipped like the page's own writes, so local-only state stays applied while the URL
has none of it.

**Evidence (probe).**
- **Bare URL.** On bare `/listings`, type `Two` without a blur, then click a Link to
  `/listings`. The URL stays `/listings`, the box keeps `Two`, and the rows stay
  filtered.
- **URL with params.** The same click on `/listings?status=all` resets everything
  (PUSH, then adoption).
- **Mutant.** With the guard removed, the bare-URL case resets too.

**Failure scenario.**
1. A staff member taps the Properties nav item with search text in the box.
2. On touch, the compatibility mousedown and click are dispatched back to back, so
   the blur's own write has not committed when the NavLink reads its location. A
   quick mouse click can hit the same window.
3. The tap becomes a REPLACE to the bare URL. It looks like nothing happened: the
   search stays applied, and reload or Back no longer has it.

Latent: any future replace-navigation into `/listings` or `/listings/deleted` (a
redirect, a saved view, a `replace: true` view switch) would also be ignored.

**Suggested fix.**
- Mark the page's own writes, e.g. `setSearchParams(params, { replace: true, state: { unitListWrite: true } })`,
  or keep a ref of pending written searches.
- Skip adoption only for those writes and adopt every other navigation.
- Then correct the three comments.

---

## R2-3. LOW - Contest A6: the guard's job can be tested in jsdom, and the claimed same-URL count pin does not exist

The ruling says the guard's remaining job "needs a transition that lags past a newer
event, which act() cannot produce in jsdom", and lists as pinned "a same-URL count
click clears the search". Neither holds.

**(a) The guard is testable in jsdom.**
- **The sequence.** One `act()` containing a 2-BR chip click and then a keystroke
  produces it. The keystroke's functional `setChosen` (`ListingsList.tsx:330-333`)
  commits urgently, and the chip's REPLACE transition commits after it.
- **Shipped code** keeps the keystroke.
- **The mutant.** With `ListingsList.tsx:186` made unconditional, the keystroke is
  dropped. The mutant still passes all 43 shipped ListingsList tests
  (ListingsList.test.tsx and ListingsList.urgentState.test.tsx).
- **Real-world sequence:** tap a chip, then type before the list re-renders.

**(b) The same-URL count case is not pinned.**
- **The mutant.** With `onCount` as a no-op (`ListingsList.tsx:276`), all 43 shipped
  tests still pass.
- **Why the existing tests miss it.** Every count test clicks a count whose target
  differs from the committed URL (`ListingsList.test.tsx:294-310, 312-323`). That
  makes the click a PUSH, and the PUSH's adoption clears the box on its own.
  user-event also moves focus, so the blur writes `q` first.
- **A probe that does pin it.** Bare `/listings`, `fireEvent.change` to `Two` (no
  blur), then "Show 2 available properties for all authorities" (same URL, so a
  REPLACE). It passes on HEAD and fails on the mutant (the box keeps `Two`).

**Suggested fix.** Add both probes as tests.

---

## R2-4. LOW - The search reaches the URL only through a blur; leaving without one loses the text

**What is wrong.** Typed text is written only by `persistSearch` on blur
(`ListingsList.tsx:15-17, 221-223, 334`).
- **History navigation fires no blur.** This covers keyboard Back/Forward, the mouse
  back button and the trackpad swipe.
- **The unmount blur is ignored.** React drops events during commit: `_enabled` is
  set false at `node_modules/react-dom/cjs/react-dom-client.development.js:13790, 13861`,
  and `dispatchEvent` checks it at 23582. So the blur when the list unmounts does
  not write either.
- **Result:** the text is never written, and Forward or Back returns without it.
- **The Back-from-property test may only pass in jsdom.** "Back from a property page
  returns to the same filtered view" (`ListingsList.test.tsx:570-586`) passes because
  user-event moves focus to the row link, which blurs the box. Whether iOS Safari
  blurs a focused input before a tapped link's click handler navigates is
  UNVERIFIED. If it does not, that promise fails for the search on iPhone.

**Evidence (probe).** On bare `/listings`, type `Two` with no blur, then Back, then
Forward: the box is empty.

**Suggested fix.** Add a trailing idle write to the blur write, for example 500 ms
after the last keystroke. That is still one write per pause and far under WebKit's
100-per-10-s cap.

---

## R2-5. LOW - A5 residual: a filter write that lands before a pending PUSH/POP commits cancels it and overwrites its history entry

**What is wrong.**
- **Every write still REPLACEs the current entry.** Local urgent state closed the
  chip-to-chip window. But every URL write goes through
  `persist` -> `setSearchParams` -> `navigate('?...', { replace: true })`, resolved
  against the committed route (`ListingsList.tsx:204-206`). That REPLACEs whatever
  entry is current (`chunk-4ZMWKKQ3.mjs:322-333`).
- **Timing.** A tab click's pushState, or a Back's popstate, moves the current entry
  before its transition commits.
- **What goes wrong.** A chip, dropdown or blur write that lands in that window
  overwrites the NEW entry with the old view. The tab switch or Back is cancelled,
  and the entry it created or returned to is overwritten.
- **The adjudication overclaims.** A5's "local urgent state removes the window" holds
  for chip-to-chip and chip-to-keystroke only.

**Evidence (probes; two events in one act()).**
- **Deleted tab, then the 2-BR chip.** The URL is `/listings?voucher=2` (still the
  Active view), and Back then lands on a stale `/listings`.
- **Back, then the 2-BR chip.** The URL is `/listings?voucher=2` and the `/elsewhere`
  entry is gone; Forward stays on `/listings`.

**Failure scenario.** Narrow: the event must land inside the transition window, so
it is worst on slow devices with long lists. Back appears to do nothing, and an
earlier page drops out of history.

**Suggested fix.** At write time, skip (or defer) the write when the browser's
current history key differs from the committed `location.key`. react-router keeps the
key in `window.history.state.key`.

---

## R2-6. LOW - "Show all statuses" removes itself when activated and drops keyboard focus; its color is under AA on the page background

**What is wrong.**
- **Focus drop.** The new button (`ListingsList.tsx:368-374`) unmounts as soon as
  rows exist. This is the same defect A9 fixed for Clear (`ListingsList.tsx:141-146`).
- **Contrast.** Its `.clear` styling (`ListingsList.module.css:156-164`) is
  `--c-brand` #1f6feb at 13 px weight 500. The content area has no background of its
  own (`dashboard/src/app/AppFrame.module.css:383-387`), so it sits on `--c-bg`
  #f7f8fa (`dashboard/src/index.css:24`). That is about 4.4:1, under 4.5:1. The chip
  Clear buttons share this style and this contrast.

**Evidence (probe).** Focus the button and press Enter: the rows render and
`document.activeElement` is `body`.

**Suggested fix.**
- After the change, move focus to the status select or the first row.
- Use an AA color for `.clear`. `--c-brand-hover` #1a5fd0 measures about 5.5:1 on
  #f7f8fa.

---

## R2-7. LOW - Contest A11: the duplicated chip UI has already lost a fix

**What is wrong.** A11 was rejected as "rewrites the shipped Tenants filters for no
user-visible gain in #1". But the A9 Clear focus hand-off landed only in the
Properties copy (`ListingsList.tsx:141-146`). The Tenants copy
(`dashboard/src/routes/contacts/TenantFilters.tsx:72-81`) still unmounts its focused
Clear and drops focus to body. So the duplication cost a user-visible accessibility
fix in this very fix wave.

**Suggested fix.** Extract the shared ChipGroup (counts optional), or at minimum port
the hand-off to TenantFilters and note in both files that they are paired.

---

## Conceded

- **A2:** the summary now states the unrecorded exclusions, and chip counts are a
  recorded product decision.
- **A13:** no code path writes those strings, and the Tenants facet behaves the same.
