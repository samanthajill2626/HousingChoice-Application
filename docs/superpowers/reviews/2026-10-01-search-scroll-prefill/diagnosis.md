# Two intermittent e2e failures - diagnosis (2026-10-01)

Branch: fix/search-scroll-prefill. Both failures reproduced on main @8c7921ea
in a scratch worktree (W:\tmp\e2e-rerun-diag, detached) with throwaway
instrumented specs that are NOT committed. Run counts are in
`measurements.md` beside this file.

## 1. contact-create.spec.ts:157 - the relationship search never offers Marcus Bell

Symptom: after typing "Marcus" into the edit dialog's relationship search, the
suggestion listbox never appears; the test times out after 60s. The page
snapshot shows the combobox holding "Marcus" with aria-expanded false.

### Hypotheses ruled out

- Lane state accumulation (the issue's original theory). Every `npm run e2e`
  wipes every lane table and reseeds at startup (`scripts/e2e-session.mjs`
  "clean-slate reseed" -> `POST /__dev/reseed` -> `resetLocalData`, which runs
  `clearTable` on each table). Nothing a previous run created survives into
  the next one, so the "Edie EditLink" tenants never pile up across runs.
- Roster truncation. `useContacts('all')` walks every page of every type
  (`fetchAllPages`), and in a 15-repeat session with no reseed between repeats
  the instrumented spec saw Marcus Bell in the `landlord` page every time. The
  search's 8-result cap is irrelevant: "Marcus" matches one contact.
- "First run passes, later runs fail." Standalone runs here went P P P F P P;
  the earlier P F F F sequence was chance at a ~1-in-10 rate.

### Root cause

`ContactSearchField` closes its list on ANY scroll (capture-phase window
listener), because the list is a position:fixed popover whose coordinates go
stale when the input moves. Browsers dispatch a scroll event at the next
rendering frame, not when the scroll happens. The test's
`fill('Caseworker')` scrolls the edit dialog's body so the relationship row is
in view; `fill('Marcus')` follows a few milliseconds later.

Instrumented event order (performance.now ms, one passing and the failing
repeat of the same session):

    pass:  176 INPUT role="Caseworker"   180 SCROLL modal body top=583
           183 INPUT search="Marcus"     188 LISTBOX+ (1 option)
    fail:  172 INPUT role="Caseworker"   179 INPUT search="Marcus"
           184 LISTBOX+ (1 option)       184 SCROLL modal body top=583
           186 LISTBOX- (dismissed)

Same scroll, same final position (583) in both. When the frame lands after the
second fill, the scroll event reaches the listener the list attached on open,
and the list closes - although it was measured AFTER the scroll and is
correctly placed. The test types once and waits, so it never recovers. Proof
the roster was intact: re-typing one character in the failing repeat reopened
the list with Marcus Bell.

### Product impact

Small. A person types several characters and every keystroke clears the
dismissed flag, so the worst case is a flicker if typing starts while a scroll
is still being reported. `UnitSearchField` carries the identical listener.

### Fix (component)

Both fields record the input's viewport position when the list is measured and
ignore a scroll that left the input there; a scroll that moved the input still
dismisses. No spec change is needed on top (see measurements).

## 2. a2p-compliance.spec.ts:323 - the re-include draft is prefill + typed text

Symptom (2 of 7 full runs on 2026-09-30): the Message field held the
property's default share text immediately followed by "Re-include <stamp>".

### Root cause

Playwright's `fill()` on a textarea is two steps in separate round trips
(playwright-core 1.61.0 coreBundle: `selectText` sets selectionStart/End over
the current value and focuses; then `keyboard.insertText`). The composer
renders the Message textarea before the property loads, and its prefill effect
writes the default text when `getUnit` resolves. If that commit lands between
the two steps, React's value write collapses the selection to the end and the
insert appends. From then on the body is "edited", so the 2026-09-08
edit-ownership guard (docs/issues/broadcast-composer-prefill-overwrites-edit.md)
correctly keeps it.

The failing value's link is the dashboard origin (`flyerLinkFor`, the
pre-draft fallback), so in the observed failures it was the FIRST prefill - on
property load - that straddled the fill.

The prefill is written TWICE, and the second write is a hazard too. The body
change creates a draft (`useComposerDraft`, debounced POST /api/broadcasts),
whose response carries the server's flyerUrl
(`<publicBase>/p/<unitId>?cta=text`, `app/src/lib/mergeFields.ts`) - a
different string from the fallback - and the prefill effect re-seeds the body
with it. Forced interleave (hold the draft POST, select the first prefill,
release, insertText): 3 of 3 end `...?cta=text` + typed text. So the
issue's suggested wait (`toHaveValue(/Details:/)`) would have closed only the
first window; the fix waits for the `?cta=text` ending, as the share specs do.

Deterministic reproduction: hold `GET /api/units/<id>` with `page.route`, run
fill's step 1 verbatim on the empty textarea, release the route, wait for the
prefill, run `keyboard.insertText` - the exact failing shape, 3 of 3. Control
(wait for the prefill, then `fill()`): the typed text replaces it, 3 of 3.

### Product impact

None that matters: a person either types before the prefill (the guard keeps
their text) or sees the prefill appear first and types into it knowingly.
Nothing is concatenated out of sight.

### Fix (test only)

Wait for the SETTLED prefill (the value ends `/p/<unitId>?cta=text`) before
filling, at both a2p-compliance fill sites: :365
(first compose - the "Send a property" heading it waits for renders before the
property loads) and :420 (re-include - no wait at all). Both are followed by an
exact-value check, which is what turns a straddle into a failure.

Left alone: broadcasts.spec.ts :245 and :396 fill the same way, but neither
asserts the exact body (one checks the send flow, the other finds the draft by
a substring), so a straddle cannot fail them. The share specs already wait for
the prefill before acting.
