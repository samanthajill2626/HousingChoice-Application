# Spec review B - MMS image viewer

## 1. BLOCKING - The proposed raw history entry can corrupt BrowserRouter state

### What is wrong

Section 6 requires an app-owned state marker and calls `history.back()`, but it
never requires preserving the current `history.state` or using the router's
history API. A straightforward implementation of the specified mechanism,
`history.pushState({ viewerId }, '', location.href)`, replaces the state object
React Router put on the entry. That violates the existing router's navigation
contract before the viewer even closes.

### Evidence

- The dashboard is mounted in `BrowserRouter`, not a bespoke history owner:
  `dashboard/src/main.tsx:1-19`.
- Existing dashboard code explicitly says raw `history.replaceState` must not be
  used because it discards the router-owned entry state, and uses `navigate(...,
  { replace: true })` instead: `dashboard/src/routes/quickReply/QuickReply.tsx:175-186`.
- The spec's open mechanism is only “pushes one same-URL entry with an
  app-owned, instance-specific state marker”:
  `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:207-213`.
  It names neither preservation of router state nor the owner/API that will do
  it. The state-surface inventory has the same omission:
  `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:321-327`.

### What it implies

The design must define a router-compatible marker protocol: preserve all
router-owned entry state while adding/removing only a namespaced viewer marker,
or use a router operation that does so. It also needs an acceptance test that
opens and dismisses the viewer from an entry with router state and proves normal
router Back/Forward/navigation still works. Without that, the core Android-Back
feature can corrupt the navigation stack it is intended to protect.

## 2. HIGH - A closed viewer leaves a dead marker; Forward then reopen creates an extra Back stop

### What is wrong

The spec calls the marker “disposable” and says a dismissal consumes it, but
neither `history.back()` nor platform Back removes an entry. It only moves the
history cursor to the prior entry. The spec then explicitly permits Forward to
land on the old marker without recreating a viewer, but gives no retirement or
normalization rule for that marker.

### Evidence

- The claimed invariant is one disposable entry per open viewer:
  `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:202-205`.
- Both explicit close and platform Back use `history.back()`/Back, rather than a
  mechanism that retires the marker: `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:215-234`.
- The design expressly says Forward to an old marker does not recreate the
  viewer: `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:239-244`.
- Existing raw media triggers open a new browsing context; there is no current
  viewer state that could clean up this proposed marker:
  `dashboard/src/routes/contact/Timeline.tsx:625-670` and
  `dashboard/src/routes/contact/MediaGallery.tsx:35-60`.

### What it implies

This reachable sequence breaks Back semantics: page entry A -> open M1 -> Close
(cursor returns to A) -> Forward (cursor is the inert M1, no viewer) -> open
M2 -> Close (cursor returns to inert M1). The next Back still stays on the same
page, despite no viewer being open. The specification must say how stale markers
are detected and retired/replaced before a later open, and add this exact
Forward/reopen sequence to the history tests. “Do not recreate the viewer” is
not a cleanup policy.

## 3. HIGH - “Exactly one” history entry has no StrictMode-safe lifecycle

### What is wrong

The viewer owns its history lifecycle and must push exactly once, yet the actual
dashboard renders under React `StrictMode`. Development StrictMode deliberately
runs mount effects through setup/cleanup/setup. The normal way for a mounted
viewer to install a `popstate` listener and push its marker is therefore a
double-push/double-cleanup trap unless the spec mandates an idempotence protocol.
The spec does not say whether the push occurs in the trigger event, an effect,
or how it is protected from StrictMode remounts.

### Evidence

- The production dashboard root wraps the application in `StrictMode`:
  `dashboard/src/main.tsx:14-19`.
- `ImageViewer`, rather than the trigger, is assigned the transient-history
  lifecycle: `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:102-108`.
- The required assertion is only the slogan “opening pushes exactly one,” with
  no StrictMode case or marker cleanup/remount protocol:
  `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:207-213` and
  `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:347-365`.
- The existing modal lifecycle already uses a mount effect and is tested under
  StrictMode for its dialog stack behavior:
  `dashboard/src/routes/contact/Modal.tsx:31-68` and
  `dashboard/src/routes/contact/Modal.test.tsx:49-53,130-146`.

### What it implies

The design must choose a StrictMode-safe ownership protocol (including cleanup
and `popstate` registration) and test it under the dashboard's real root
semantics. Otherwise the stated one-entry / one-dismissal invariant can fail in
the development and test environment, producing duplicate same-URL stops or a
cleanup Back that navigates the real route.
