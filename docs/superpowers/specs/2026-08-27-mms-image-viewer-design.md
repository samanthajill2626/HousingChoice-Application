# In-app MMS image viewer

- Date: 2026-08-27
- Status: ready for human review (adversarial spec review converged at round 4)
- Branch: `feat/mms-image-viewer`
- Worktree: `W:\tmp\mms-image-viewer`
- Base: `main` at `bd17b7d497c26eb3ec80d2c32032befc6545e0ce`
- Review: round 1 accepted 7 unique findings; round 2 accepted 3; round 3
  accepted 1; round 4 found no issues; no findings were rejected or deferred

## 1. Problem

HousingChoice currently treats a rendered image attachment as a link to the raw,
authenticated media endpoint.

- `AttachmentGallery` in `dashboard/src/routes/contact/Timeline.tsx` wraps each
  image in an anchor with `target="_blank"`. This renderer is shared by MMS message
  bubbles and email cards. `Timeline` itself is consumed by contact, relay
  conversation, native group-text, tour-conversation, and placement-conversation
  screens.
- `MediaGallery` in `dashboard/src/routes/contact/MediaGallery.tsx` does the same
  for the contact file pane's "Media from comms" grid. That gallery is consumed by
  the tenant, landlord, partner, and unknown-contact file panes.

On desktop, the browser presents that raw response in a new tab or window against
an unstyled black background. On mobile or in an installed browser shell, opening
the raw response leaves no in-app close affordance; the platform Back action can
leave or exit the app instead of returning predictably to the conversation.

The product needs one coherent image-inspection experience on both form factors,
without turning the first version into a carousel or a shareable image route.

## 2. Decisions locked with the human

1. Renderable communication images open in an in-app viewer. They no longer open
   as raw media in a new window.
2. The viewer displays one image at a time. The user closes it before selecting a
   different thumbnail. There is no previous/next navigation or filmstrip.
3. Desktop uses a large centered modal over the dimmed current page. Mobile uses a
   full-viewport viewer.
4. The image opens fitted within the available canvas. Closing and reopening it
   starts at the fitted view again.
5. Zoom is direct manipulation only: mouse wheel or trackpad on desktop and pinch
   on touch devices. An enlarged image can be dragged to pan.
6. There are no visible plus, minus, zoom-percentage, or reset controls.
7. Keyboard `+`/`=`, `-`, and `0` provide zoom in, zoom out, and reset-to-fit for
   users who cannot use wheel or pinch. The current scale may be announced to
   assistive technology, but it is not visible chrome.
8. Persistent visible actions are Close and Download. Close is text-labelled, not
   an unlabeled icon.
9. Opening the viewer creates one transient same-URL React Router history entry.
   Browser or Android Back closes the viewer without leaving the current page.
   Close, Escape, and a desktop backdrop press traverse that same entry exactly
   once.
10. An open image has no route, query parameter, or restorable/shareable URL.
    Reloading the page does not reconstruct the viewer. Browser Forward may reopen
    it only while the current app-level provider still holds that transient image
    descriptor in memory.
11. Closing restores the underlying conversation/file-pane scroll position and
    focus to the thumbnail that opened the viewer.
12. The first version uses `react-zoom-pan-pinch` for the gesture engine and a
    HousingChoice-owned shell for layout, history, accessibility, loading, error,
    and download behavior.

## 3. Alternatives considered

### 3.1 Raw media navigation or a styled standalone page

Rejected. It still makes the image a separate browsing destination, complicates
return navigation, and loses the visual and focus context of the conversation.

### 3.2 A full lightbox package

Rejected for v1. Carousel, slide navigation, captions, and plugin chrome are not
requirements. Adapting a larger lightbox would introduce more behavior than this
single-image viewer needs.

### 3.3 A fully custom wheel, pinch, pan, and transform engine

Rejected. Pointer capture, two-finger distance math, bounds, scale anchoring, and
browser gesture conflicts are a large correctness surface. HousingChoice should
own the product shell, not reimplement the gesture engine.

### 3.4 Visible zoom toolbar

Rejected by the human after visual review. Plus, minus, percentage, and Reset add
unnecessary chrome. Wheel, pinch, pan, and hidden keyboard commands are the
approved interaction model.

## 4. Viewer architecture

### 4.1 App-level provider, shared component, and descriptor

Add one shared dashboard component under the contact route, conceptually:

```ts
interface ViewerImage {
  src: string;
  alt: string;
  title?: string;
}

interface ImageViewerContextValue {
  openImage: (image: ViewerImage, trigger: HTMLElement) => void;
}
```

The exact API may be refined in the plan, but these ownership boundaries are
fixed:

- One `ImageViewerProvider` is mounted inside `BrowserRouter` and above the route
  tree. It is the stable owner even when a Timeline message, gallery, pane, or
  route renderer unmounts.
- The provider owns a bounded in-memory descriptor registry keyed by an opaque
  viewer token, the trigger reference and scroll snapshots for the active token,
  the router marker lifecycle, and the single body-level portal.
- Gallery triggers call the provider context. They do not own selected-image or
  history state.
- `ImageViewer` owns the dialog shell, gesture wrapper, load/error state, keyboard
  zoom commands, download action, and scroll containment for the active provider
  token.
- The gesture package never owns navigation, routing, user-facing copy, or the
  dialog layout.
- The full-screen overlay renders through a body-level portal so message-bubble,
  pane, stacking-context, and overflow styles cannot clip it.
- The viewer portal owns z-index 200. The repository's current highest body-level
  UI is z-index 100, so drawer, form modal, menu, tooltip, and search-listbox layers
  remain below it. Existing sibling portals are not force-closed; they are covered
  and made inert for the viewer lifetime.
- Reuse or extract the existing `Modal` focus/Escape/topmost-dialog lifecycle
  rather than creating a second incompatible modal stack. Existing form-modal
  visuals and default behavior must remain unchanged. A media-specific variant or
  shell is allowed where the form modal's 30rem layout is inappropriate.

Only one viewer can be active application-wide. Selecting a different image while
the viewer is open is not an interaction path in v1 because the overlay hides and
inerts the thumbnails beneath it.

### 4.2 Renderer integration

`AttachmentGallery`:

- Replace the image anchor with a real button that opens `ImageViewer`.
- Keep `stopPropagation` behavior so opening an image does not toggle message
  metadata.
- Use the existing attachment label as the image alternative text and viewer
  title when a filename is available.
- This applies identically to MMS bubbles and email-card attachments because they
  already share `AttachmentGallery`.
- Because `Timeline` is shared, the same behavior is explicitly in scope on the
  contact page, relay conversation page, native group-text view, tour conversation
  tabs, and placement conversation tabs. The host route does not get a separate
  viewer implementation.

`MediaGallery`:

- Replace each renderable-image anchor with a real button that opens the same
  viewer.
- Preserve stable media identity and newest-first paging.
- A gallery item currently has no filename and today uses the generic image alt
  `Attachment`. The button conversion deliberately changes the exact trigger name
  to `View image attachment` and the viewer image alternative text to `Image
  attachment`. Its timestamp need not be promoted into visible viewer chrome in
  v1.
- This automatically covers tenant, landlord, partner, and unknown-contact file
  panes, all of which consume `MediaGallery`.

Non-image attachment links keep their current behavior. Composer previews,
listing photos, public flyer media, and any other image surface are outside this
feature.

### 4.3 Desktop and mobile layout

Desktop, at the repository's wide QA viewport:

- Dim the current page without unmounting it.
- Center a large media dialog with bounded margins and a dark neutral image
  canvas.
- Keep Close and Download visible in a top action bar while the image is panned or
  zoomed.
- A press on the dimmed backdrop dismisses the viewer.
- The whole viewer backdrop/action/canvas surface remains on the owned layer 200;
  internal transform elements do not create a layer above Close or Download.

Mobile, at 360px width and representative phone heights:

- The viewer fills the visual viewport using dynamic viewport units and safe-area
  padding.
- No underlying page content or horizontal overflow is visible.
- Close and Download remain reachable above the image canvas.
- A backdrop dismissal does not apply because there is no exposed backdrop.
- There is no swipe-to-dismiss gesture; it would conflict with pinch and pan.

Both layouts may show one concise instruction such as "Wheel or pinch to zoom;
drag to pan." This is guidance, not a control.

## 5. Zoom and pan contract

Add `react-zoom-pan-pinch` to `dashboard/package.json` as a dashboard runtime
dependency and update the root lockfile.

The viewer configures it with these product constraints:

- Base/minimum scale: 1, representing the fitted view.
- Maximum scale: 8.
- Multiple intermediate wheel and pinch scale levels; zoom is not binary.
- Zoom remains anchored near the pointer or pinch center.
- Panning is enabled only above the fitted scale and remains bounded so the image
  cannot be lost completely off canvas.
- The transform canvas, not the whole document, owns wheel and touch gestures.
- Browser page scroll and native page pinch do not move the underlying app while
  the pointer/touches are on the canvas.
- Double-click zoom is not added in v1.
- Unmounting the viewer discards its transform. Reopening always starts at scale
  1 and centered.

Keyboard handling is active only while this viewer is the topmost dialog:

- `+` and `=` zoom in one package step.
- `-` zooms out one package step.
- `0` resets to scale 1 and centers the image.
- Modified shortcuts such as Ctrl/Cmd `+` remain browser shortcuts and are not
  captured.
- A visually hidden polite live region announces the resulting percentage after
  a keyboard zoom command. No visible percentage is rendered.

## 6. Transient router history and dismissal invariant

The protected invariant is: one open viewer corresponds to exactly one
HousingChoice marker on the current React Router entry, and one user dismissal
traverses no more than that entry.

Raw `window.history.pushState` / `replaceState` are forbidden here. `BrowserRouter`
owns the browser entry's key/index/user-state envelope, and existing code in
`QuickReply.tsx` already warns that raw replacement can discard that state.

### 6.1 Router-state protocol

- The provider reads `useLocation()` and writes through `useNavigate()`.
- The marker lives under one namespaced key in router user state, for example
  `__hcImageViewer: { token: string, returnLocationKey: string }`. The return key
  is the exact underlying `location.key` from which the viewer opened.
- Opening navigates to the current `{ pathname, search, hash }` with `replace:
  false`. It does not alter any URL component.
- If existing `location.state` is a record, every existing field is preserved when
  the marker is added. A non-record value is retained under a namespaced prior-state
  field. The underlying pre-viewer entry is never mutated and therefore regains
  its exact original state on Back.
- The provider derives which viewer is active from the current location marker.
  There is no independent selected-image boolean that can disagree with router
  history.

Tests must begin on an entry with pre-existing router user state and prove that
open, Back, Forward, explicit close, and later route navigation preserve it.

### 6.2 Open

1. The thumbnail click callback generates an opaque token, records the descriptor,
   trigger, scroll snapshots, and current underlying `location.key` in the provider
   registry, then performs the one router navigation described above.
2. The history push occurs in that user event, never in a viewer mount effect.
   React StrictMode effect replay therefore cannot double-push it.
3. Renders, image load, zoom, pan, and source-message removal push nothing.
4. The provider sees the current token, mounts the portal, and moves focus to
   Close.

### 6.3 Browser or platform Back

1. Back returns to the underlying router entry, whose user state has no marker.
2. `useLocation()` updates; the provider unmounts the viewer without issuing any
   navigation.
3. If the resulting `location.key` equals the marker's `returnLocationKey`, this is
   a verified viewer dismissal: restore recorded scroll and trigger focus.
4. Any other resulting key is independent navigation. That destination is
   authoritative: remove the portal/inert state and discard snapshots without
   writing scroll or focus into the new route.

This is the behavior that prevents Android Back from exiting the app while the
viewer is open.

### 6.4 Close, Escape, and backdrop

All explicit dismissal surfaces call one `requestDismiss` path.

- If the current router entry still carries the visible viewer's active token,
  requestDismiss calls router `navigate(-1)` and lets the location change unmount
  the viewer.
- If a late callback runs after that token has already been traversed, it is a
  no-op. It does not navigate and there is no independent local-open state to
  close.
- A location change that removes the marker never calls `navigate(-1)`.

This guard prevents double-Back behavior, route loss, and two callers racing to
traverse the same entry.

### 6.5 Renderer removal, Forward, reload, and stale markers

- Descriptor/history ownership is above the route renderers. Removing the source
  message through Timeline retry collapse, switching a pane programmatically, or
  unmounting a gallery does not orphan the marker. The viewer remains open; if the
  saved trigger is no longer connected, dismissal skips focus restoration.
- Independent route navigation while open closes the viewer when the new location
  lacks its marker, but it is not treated as a return dismissal even when a shared
  AppFrame scroll element remains connected.
- After a normal close, Forward to that live token during the same app lifetime
  reopens the same image from the provider registry. The Forward entry is therefore
  not a dead same-URL Back stop.
- Opening a new viewer from an underlying entry follows normal browser semantics
  and truncates that entry's forward branch.
- A page reload clears the in-memory descriptor registry and never reconstructs an
  image from router state. If the current entry carries a marker unknown to the
  registry, an idempotent guard uses router navigation with `replace: true` on the
  current `{ pathname, search, hash }`. It removes only the namespaced marker and
  restores the preserved prior user state. It does not call Back and does not loop
  under StrictMode.
- Honest reload limitation: because the History API cannot delete the entry, an
  open -> reload sequence leaves two clean same-URL entries after normalization.
  Back may traverse once with no visible route change; Forward returns to another
  clean entry and never bounces the user Back or reopens the image. This rare extra
  stop is accepted in exchange for unchanged URLs and non-restoration after reload.
- No source URL, filename, or media identity is serialized into the path, search,
  hash, or persisted storage.

## 7. Accessibility and focus

- Thumbnail triggers are semantic buttons with `aria-haspopup="dialog"` and a
  useful accessible name.
- The viewer is a labelled `role="dialog"` with `aria-modal="true"`.
- Focus moves to Close on open, remains contained in the viewer while open, and
  returns to the exact trigger on dismissal when that trigger still exists.
- Escape dismisses only the topmost dialog and follows the same history path as
  Close.
- Close and Download are reachable and visibly labelled at every supported
  viewport.
- The fitted image retains meaningful alternative text. The transformed visual
  itself is not a separate keyboard stop.
- The canvas instruction identifies wheel, pinch, drag, and the keyboard
  alternatives for screen-reader users.
- Zoom does not rely on visible plus/minus buttons, but keyboard commands and the
  hidden live scale announcement provide a non-pointer alternative.
- The portal container is a direct child of `body`. The provider marks every other
  existing body child inert while open, including the app root and any sibling
  portaled listbox, while saving each child's prior inert value. Close restores
  those exact values. The provider does not force-close a background portal.

### 7.1 Real scroll owners

HousingChoice does not rely only on document scroll. `AppFrame .content` owns page
scroll and each `Timeline .stream` owns conversation scroll. A body-only modal lock
does not satisfy this feature.

On open, the provider walks from the trigger through its connected ancestors and
records `scrollTop` and `scrollLeft` for every element whose computed overflow can
scroll, plus the document scrolling element. This captures the Timeline stream,
AppFrame content, and any file-pane scroll owner without coupling the provider to
CSS-module class names.

While open:

- the inert body siblings block background focus and pointer interaction;
- the fixed overlay catches pointer input outside the canvas;
- the transform canvas consumes its wheel/touch gesture stream; and
- contained focus prevents Page Up/Down, arrows, or Space from targeting a
  background scroller.

On a verified dismissal to the recorded underlying `location.key`, restore every
still-connected recorded owner to its exact x/y position, then restore focus with
`preventScroll: true`. A disconnected trigger or scroll owner is skipped. On any
other location key, restore neither scroll nor focus; only inert values are always
cleaned up. Tests set both the page container and a Timeline stream away from zero
and cover Back, Close, Escape, backdrop, and independent-route behavior.

## 8. Media eligibility, loading, download, and failure

The viewer never broadens what the dashboard considers safe to render inline.
Image eligibility remains owned by the media-content classification work.

- The pending `feat/media-content-type-fidelity` branch changes both renderer
  branches from `contentType.startsWith('image/')` to its reviewed
  `isInlineRenderable` helper for JPEG, PNG, GIF, and WebP only.
- That branch is a build-time prerequisite for this viewer. Before implementation,
  it must be merged into `main`, this worktree must sync that `main`, and the
  viewer triggers must use `isInlineRenderable` rather than reintroducing a broad
  `image/*` check.
- This spec does not alter MIME normalization, the serving route, S3 metadata,
  backfill behavior, or Content-Disposition rules from that separate feature.

Viewer behavior for an eligible image:

- Show a quiet loading state until the full image resolves.
- On image failure, keep the shell open and show a concise error. Close and
  Download remain available; v1 adds no separate Retry control.
- Download uses the existing same-origin authenticated media URL and downloads in
  the current browsing context. It does not open a new tab or window.
- The server remains authoritative for Content-Type, filename, disposition, auth,
  and `nosniff` behavior.

## 9. Dependency spike evidence

`react-zoom-pan-pinch` version 4.0.4 was spiked outside the repository before this
spec was written.

- npm metadata reports MIT licensing, React/ReactDOM peer support, Node >=8, and
  no package runtime dependencies beyond peers.
- A strict TypeScript probe against React 19 compiled successfully.
- Server-side static rendering completed successfully, proving the import itself
  does not require an eager browser global.
- A real Chromium probe verified button-driven package controls, wheel zoom,
  two-touch CDP pinch zoom, and reset after the wheel gesture settled. Observed
  scales included 1.003, 8.000, 2.232, and reset 1.000.
- A clean `linux/arm64` Node 24 container installed the package and imported
  `TransformWrapper`, `TransformComponent`, and `useControls` successfully.

The implementation still pins the dependency through the repository lockfile and
must not add it to the server `app` workspace.

## 10. State surfaces and readers

Protected state A: selected viewer image.

- Mutators: Timeline thumbnail click, MediaGallery thumbnail click, router Back,
  Forward, Close, Escape, desktop backdrop, app reload. Renderer unmount is NOT an
  owner or mutator after round 1.
- Readers/renderers: the app-level provider, ImageViewer title/alt/src, transform
  canvas, Download action, load/error state, focus restoration.
- Invariant: zero or one active image application-wide; there is no next/previous
  mutation surface. Descriptors may remain in the in-memory token registry only to
  make same-session Forward meaningful.

Protected state B: viewer-owned history marker.

- Mutators: open router navigation; UI dismissal router `navigate(-1)`; platform
  Back/Forward; independent route navigation; stale-marker router replacement
  after reload or registry eviction.
- Readers: `useLocation()`, marker `returnLocationKey`, and the requestDismiss
  ownership guard.
- Invariant: opening pushes once through React Router; existing router user state is
  preserved; a marker/location change never recursively navigates; unknown markers
  are stripped in place with one idempotent router replacement.

Protected state C: transform scale and position.

- Mutators: wheel, pinch, drag, keyboard `+`/`=`/`-`/`0`, viewer unmount.
- Readers/renderers: transformed image, pan bounds, hidden scale announcement.
- Invariant: scale stays within 1..8; a newly opened viewer starts at fitted scale
  1 and centered.

Protected state D: renderable-media classification.

- Mutators: the separate media-fidelity feature's classification helper and
  persisted Content-Type pipelines. This feature adds none.
- Readers/renderers: AttachmentGallery and MediaGallery trigger-vs-file-link
  branches, then ImageViewer only after the classification passes.
- Invariant: this feature does not turn declarable or opaque media into inline
  browser content.

Protected state E: background focus and scroll position.

- Mutators: user wheel/touch/keyboard input, Timeline auto-scroll/update behavior,
  AppFrame or file-pane scrolling, focus restoration.
- Readers: provider trigger-to-root scroll snapshot, marker return-location key,
  body-sibling inert lifecycle, and connected-owner restoration.
- Invariant: background owners cannot be user-scrolled while open; every surviving
  recorded owner returns to its exact x/y position before focus is restored with
  `preventScroll` only on the verified underlying entry. Independent destinations
  receive no old-route scroll or focus writes.

## 11. Testing

### 11.1 Component and hook tests

Add focused tests for the shared viewer/history behavior:

1. Under real `BrowserRouter` and React `StrictMode`, one trigger event pushes
   exactly one same-URL router entry. Rerender, effect replay, load, and zoom add no
   entry.
2. Start with non-empty router user state. Open, platform Back, same-session
   Forward, explicit close, and later route navigation preserve that state and the
   router's normal Back/Forward behavior.
3. Platform Back dismisses without leaving the current route or issuing a second
   Back.
4. Close, Escape, and desktop backdrop traverse the owned entry exactly once. A
   late dismissal callback after the marker changed is a navigation-free no-op.
5. Forward during the same provider lifetime reopens the descriptor. The sequence
   open -> reload on marker -> normalize -> Back -> Forward yields ordinary clean
   same-URL entries, never reopens, never auto-bounces Back, preserves prior router
   user state, and does not loop under StrictMode.
6. Remove the source Timeline message through the retry-collapse path while its
   viewer is open. The portal/history remain valid, dismissal does not focus a
   disconnected trigger, and the following Back operation is normal.
7. Initial focus, contained Tab order, topmost Escape behavior, connected-trigger
   focus restoration, and exact inert-state cleanup for the app root and a sibling
   body portal.
8. Set both an AppFrame-like page scroller and Timeline-like nested scroller away
   from zero. Prove neither moves under background input and both are restored for
   Back, Close, Escape, and backdrop paths.
9. From that scrolled open viewer, perform independent navigation to another route
   key. Prove the destination controls its own scroll/focus while portal and inert
   state still clean up.
10. Visible actions are Close and Download; no plus, minus, percentage, Reset,
   previous, or next control is present.
11. `+`/`=`, `-`, and `0` call the gesture controls and announce the new scale only
    through the hidden live region. Ctrl/Cmd variants are not captured.
12. Loading, successful image load, and failed-image fallback keep Close and
    Download usable.
13. Closing a zoomed/panned viewer and reopening mounts a fresh transform at scale
    1.
14. With a z-index 100 portaled listbox or z-index 50 mobile drawer already visible,
    the viewer's layer 200 covers it and keeps Close/Download interactive. Closing
    restores the background layer's prior state.

Extend renderer tests:

- `Timeline`: eligible image attachment is a dialog trigger, not a `_blank` link;
  it opens the viewer with the existing filename/fallback label. Non-image links
  remain links. Both MMS bubble and email-card paths retain coverage.
- `MediaGallery`: eligible image tile opens the same viewer; non-image tile and
  paging behavior remain unchanged. Its deliberate trigger name is `View image
  attachment` and its viewer alt is `Image attachment`.
- Multi-image fixture: clicking one thumbnail opens only that image; there are no
  sibling navigation controls; closing is required before the second can be
  selected.
- Host routes: keep or extend focused render tests for ContactDetail,
  ConversationDetail, GroupTextView, TourConversation, and PlacementConversation
  so each current Timeline consumer is named and proves its image trigger can reach
  the provider without changing its surrounding layout/dialog state.

Keep the media-fidelity classification tests as the authority for which MIME types
reach the viewer.

### 11.2 Playwright

Extend the hermetic dashboard MMS coverage, preferably
`e2e/tests/dashboard-next/outbound-mms.spec.ts`, so one real authenticated media
URL exercises both renderers where practical.

Desktop at 1280x900:

1. Open a timeline image and prove no new page/window is created.
2. Assert the labelled dialog, fitted canvas, Close, and Download are visible and
   no zoom toolbar exists.
3. Use real wheel input at multiple steps and inspect the transform to prove scale
   increases and remains bounded.
4. Set the Timeline stream and AppFrame content away from their initial scroll
   positions. Close with Escape, verify the URL and both positions did not change,
   and verify focus returned to the thumbnail with no focus-induced scroll.
5. Open the same indexed image from "Media from comms" and prove the same viewer
   is used.
6. Exercise one group/relay Timeline host in addition to the contact page so the
   shared renderer is proven outside the 1:1 layout.

Mobile at 360x800:

1. Open the image and prove the dialog fills the visual viewport without
   horizontal or bottom overflow.
2. Use Chromium multi-touch dispatch to prove a two-finger pinch increases scale;
   drag the enlarged image and prove the transform position changes.
3. Invoke browser Back and prove the viewer closes while the contact/conversation
   route, selected pane, and thumbnail remain.
4. Reopen and prove scale is reset to 1, then close with the visible Close action.

The browser test must use the e2e workspace harness. It must not target the human's
live dashboard ports.

### 11.3 Live self-QA

Use `npm run e2e:session`, authenticate through the hermetic dev-login seam, and
inspect the feature at 1280x900 and 360x800.

- Desktop: wheel through several levels, pan at high zoom, backdrop close, Escape,
  Download, focus restoration, and file-pane parity.
- Mobile/touch emulation: pinch, two-finger repositioning, pan bounds, system Back,
  safe-area/top-bar reachability, and underlying-scroll preservation.
- Capture screenshots under `.playwright-mcp/` showing the desktop modal and
  mobile full-screen viewer.
- Confirm there are no page errors or failed media requests.

## 12. Required completion gates

This is a full HousingChoice feature mission. After implementation, final `main`
sync, and a quiet worktree, run the repository's bare gates from this worktree:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Gate 5 applies the repository's touched-lines ratchet and baseline comparison rules.
The dependency changes also require the repository's normal install/lockfile
integrity checks and the already-proven Linux ARM64 compatibility to remain true.

## 13. Out of scope

- Carousel, previous/next buttons, filmstrip, or swipe between images.
- Visible zoom controls, visible percentage, or visible reset action.
- Double-click zoom or swipe-to-dismiss.
- Shareable/restorable image routes, query parameters, or hashes.
- Editing, rotating, cropping, annotating, or deleting media.
- Video, audio, PDF, document, HEIC/HEIF, SVG, or other non-approved inline
  formats.
- Composer attachment previews, listing photos, public flyer media, or other image
  galleries.
- Changes to media storage, MIME repair/backfill, server auth, or response headers.

## 14. Post-merge obligations

None expected beyond the normal dashboard dependency install from the committed
lockfile. There is no schema, infrastructure, secret, feature-flag, backfill, or
deployment mutation in this feature. Merge and deployment remain human-owned.
