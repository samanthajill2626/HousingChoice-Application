# MMS image viewer design review - round 2A

## 1. [BLOCKING] "Close locally on ownership mismatch" is impossible under the specified location-only state model

### What is wrong

The revision correctly removes gallery-local selected state, but then retains a
fallback whose mechanism contradicts that decision. Section 6.1 says the provider
derives the active viewer from the current location marker and has no independent
selected-image boolean. Section 6.4 says an ownership mismatch closes locally
without navigation. A local close cannot remove the current marker; on the next
render, the provider derives the same marker and remounts the viewer. Deleting the
descriptor merely turns the marker into an unknown token, whose only specified
behavior is the stale-token `navigate(-1)` recovery -- exactly the navigation the
mismatch rule forbids.

The only harmless mismatch is a stale callback after the marker has already been
traversed, in which case no viewer is mounted and there is nothing to close. The
spec never distinguishes that no-op from a visible viewer whose marker cannot be
proven. The required mismatch test therefore asks an implementation to demonstrate
an impossible state transition.

### Evidence

- Spec section 6.1: the provider derives activity from the location marker and
  has no independent selected-image boolean.
- Spec section 6.4: an unproven owner "closes locally" and "MUST NOT navigate
  again."
- Spec section 6.5: an unknown current token is recovered with one router
  `navigate(-1)`.
- Spec section 10A repeats that router state is the selected-image mutator/owner;
  section 10B repeats the unknown-token recovery exception.
- The test list still requires "An ownership mismatch closes locally without
  navigating" (spec section 11.1, item 4).

### What it implies

Define one coherent outcome. Either prove that mismatch can only be a stale
callback and make it a no-op, or give the provider a deliberately specified
local suppression state and define how/when the marker is retired. Do not demand
both a visible location-derived viewer and a non-navigating local close. Until
this is resolved, the dismissal invariant and its test are self-contradictory.

## 2. [HIGH] Reload recovery leaves a permanent stale Forward entry that immediately sends the user Back again

### What is wrong

The new stale-token guard handles a reload on a marker by calling `navigate(-1)`.
That moves the history cursor; it does not retire or normalize the stale marker.
The user can then press Forward to return to exactly the same unknown marker, and
the provider immediately calls `navigate(-1)` again. Every later Forward attempt
is bounced back to the underlying page. This is the same inert same-URL history
stop that the round-1 Forward remedy was intended to remove, now reachable after
any reload.

The stated test only proves one recovery and no StrictMode loop. It never tests
Forward after the recovery, so it will accept this broken browser-history cycle.

### Evidence

- Spec section 6.5 requires an unknown marker after reload to perform one router
  `navigate(-1)`; it does not replace the stale entry or otherwise remove its
  marker.
- The same section says reload clears the descriptor registry, so returning to
  that entry through Forward necessarily makes it unknown again.
- Spec section 11.1 item 5 tests the one-time stale-token Back recovery, but not
  Forward after that recovery.
- The existing application is a `BrowserRouter` app
  (`dashboard/src/main.tsx:5-18`), so these are ordinary browser Back/Forward
  entries, not an app-private stack.

### What it implies

The spec must specify a recovery that makes the stale entry navigable without an
auto-Back loop, or explicitly normalize/retire it while preserving the router
entry contract. Add the exact sequence: open -> reload on marker -> recovery ->
Forward -> ordinary Back/Forward navigation. Without it, reloading an open viewer
silently corrupts Forward for that history position.

## 3. [MEDIUM] The portal is required to be topmost but the design never assigns it a layer above existing body-level UI

### What is wrong

Moving the viewer to a body portal avoids clipping but does not by itself place it
above the current application. The specification requires the image viewer to be
the topmost dialog, to hide the mobile page, and to make Close/Download persist
above the canvas. It never sets a stacking-layer contract. Existing application
content includes fixed and portaled UI at z-index 50, 60, and 100. A routine
viewer backdrop at the existing modal's z-index 50 can render below an open
body-level listbox or collapsed-sidebar flyout; marking `#root` inert disables
interaction but does not hide that content.

### Evidence

- Spec sections 4.1, 4.3, and 7 require a body-level portal, a topmost dialog,
  and no visible mobile background; none specifies a z-index/layer relationship.
- The existing contact modal backdrop is only z-index 50
  (`dashboard/src/routes/contact/Modal.module.css:3-12`).
- The mobile drawer is fixed at z-index 50
  (`dashboard/src/app/AppFrame.module.css:407-420`) and collapsed-sidebar labels
  use z-index 60 (`dashboard/src/app/AppFrame.module.css:247-260`).
- `ContactSearchField` deliberately portals its listbox to `body` at z-index 100
  (`dashboard/src/routes/contact/ContactSearchField.module.css:59-67`).

### What it implies

Set an owned viewer layer above every existing shell/modal/popover layer and
state whether opening the viewer must close existing body portals. Add a visual
regression case with a high-layer portal/drawer state. Otherwise the claimed
full-viewport, topmost viewer can ship with unrelated page chrome painted over
its controls.
