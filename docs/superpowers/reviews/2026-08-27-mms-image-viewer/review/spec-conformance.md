# MMS image viewer spec-conformance review

Review target: `48d21f60d0a8b4b997d3299371534fc708943142` on `feat/mms-image-viewer`.

Scope note: S1-S8 are interpreted as implementation-plan Tasks 1-8. I reviewed the approved spec, plan, live-tree worklist, profile, supplied diff package, the current feature-only delta `5b2d3a37..HEAD`, and the current source/tests. Per the dispatch constraint, I did not launch a test suite or an interactive browser lane. Read-only probes included `git diff --check 5b2d3a37..HEAD` (exit 0), feature-only path inventory, raw-History-API search, renderer `_blank` search, broad `image/*` search, and import-graph search.

## Verdict

Seven work-map items CONFORM. S3 is PARTIAL because one explicit, approved regression case is absent: backdrop is never the sole initiating dismissal in a nested-scroll/focus restoration test. I found no confirmed runtime defect in the current production implementation.

## Work-map assessment

### S1 - shared Modal media lifecycle: CONFORMS

- The API is additive and defaults remain the existing form-modal behavior: `variant`, `headerActions`, `trapFocus`, `initialFocus`, `restoreFocus`, and `onDialogKeyDown` are optional at `dashboard/src/routes/contact/Modal.tsx:19-24` and default at `:47-52`.
- The existing global topmost stack remains authoritative. Media Escape is contained before unrelated document listeners, descendant `defaultPrevented` is respected, and Tab wrapping runs only for the topmost trapped dialog at `Modal.tsx:73-155`.
- The media variant provides labelled dialog semantics, full accessible title, Download-before-Close actions, visible `Close`, and the required sizing chain at `Modal.tsx:158-207` and `dashboard/src/routes/contact/Modal.module.css:97-150`.
- Focus, long-title, trap, default-modal, and document-Escape behavior are directly asserted at `dashboard/src/routes/contact/Modal.test.tsx:264`, `:290`, `:348`, and `:396`.

### S2 - router-state and nested-scroll primitives: CONFORMS

- Marker parsing is structurally guarded; plain records preserve namespace collisions, while arrays, Date, Map, Set, and class instances take the non-record wrapper path at `dashboard/src/ui/imageViewer/history.ts:22-83` and `:85-128`.
- Exact collision and non-record round trips are covered at `dashboard/src/ui/imageViewer/history.test.ts:15-69`; malformed lookalikes are rejected without removal at `:71-135`.
- Scroll discovery walks connected ancestors, checks the independently scrollable axis, always includes and deduplicates the document scroller, and restores only connected owners at `dashboard/src/ui/imageViewer/scroll.ts:7-47`. The tests exercise independent axes, document deduplication, exact x/y restoration, and disconnects at `dashboard/src/ui/imageViewer/scroll.test.ts:57-204`.

### S3 - provider, portal, history, inert, focus, and scroll lifecycle: PARTIAL

Production behavior conforms:

- The provider is mounted at the stable router-aware boundary at `dashboard/src/main.tsx:15-22`.
- A trigger registers an opaque descriptor and snapshots scroll before one same-URL React Router navigation; active state comes only from the marker plus registry at `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:78-116`.
- Dismissal is token-guarded and one-shot at `ImageViewerProvider.tsx:118-137`; unknown retained markers normalize with router `replace` at `:139-155`.
- Verified return-key dismissal releases inertness first, restores exact scroll, then focuses the connected trigger with `preventScroll` at `:157-176`. The body portal is direct, snapshots every existing sibling's boolean `inert`, and restores exact values at `:178-204`.
- Forward refresh, state preservation, single traversal, stale-marker normalization, independent navigation, disconnected sources, and branch truncation are asserted at `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx:204-423`.

However, approved test coverage is incomplete:

- The plan requires Back, Close, Escape, and backdrop to be exercised as separate initiating dismissals against two mutated scroll owners (`docs/superpowers/plans/2026-08-27-mms-image-viewer.md:439-450`); the spec repeats all four paths at `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md:494-499`.
- The exact nested-scroll test covers Back and Close at `ImageViewerProvider.test.tsx:245-280`. The browser test covers Escape at `e2e/tests/dashboard-next/outbound-mms.spec.ts:454-483`.
- The only backdrop event is `fireEvent.mouseDown(backdrop)` at `ImageViewerProvider.test.tsx:296-298`, immediately after Escape has already inserted the token into `dismissRequestedRef` and requested `navigate(-1)`. It therefore exercises the duplicate no-op guard, not backdrop as a positive dismissal path, and it does not assert backdrop scroll/focus restoration.
- Read-only reproduction: `rg -n -i "backdrop|scrollTop|scrollLeft|Escape|history.back"` across the provider, Modal, and outbound-MMS tests found no other backdrop invocation. This is a concrete spec/test deliverable gap, not evidence that the live backdrop wiring at `Modal.tsx:166` or shared dismissal path is broken.

Required resolution: add a backdrop-only provider case using the same two nonzero x/y scroll owners and exact trigger-focus assertion. A parameterized Back/Close/Escape/backdrop test would satisfy the approved contract and reduce duplication.

### S4 - gesture engine and viewer shell: CONFORMS

- `react-zoom-pan-pinch` is pinned only in the dashboard at `dashboard/package.json:17` and the root lockfile at `package-lock.json:91`, `:7415-7421`; there is no `app/package.json` entry.
- The hidden probe, ResizeObserver canvas measurement, bitmap-fit box, keyed transform reset, 1..8 hard bounds, no smooth padding, discrete wheel/pinch config, bounded pan, and disabled double click are implemented at `dashboard/src/ui/imageViewer/ImageViewer.tsx:60-110` and `:174-267`.
- Only Download and Close are visible; keyboard `+`/`=`/`-`/`0` calls package controls while Ctrl/Meta/Alt remain browser-owned, and only keyboard-owned commands publish the keyed polite announcement at `ImageViewer.tsx:112-172` and `:268-280`.
- The definite flex-fill canvas, absolute loading/error overlays, fitted image box, gesture containment, and mobile safe-area handling are at `dashboard/src/ui/imageViewer/ImageViewer.module.css:1-73`.
- Geometry/config, chrome, keyboard/live-region, error, and reset behavior are asserted at `dashboard/src/ui/imageViewer/ImageViewer.test.tsx:149-335` and `dashboard/src/ui/imageViewer/fitImage.test.ts:3-39`.

### S5 - Timeline MMS/email renderer integration: CONFORMS

- The hook-owning image button uses the existing attachment label, semantic button, `aria-haspopup="dialog"`, and the provider descriptor at `dashboard/src/routes/contact/Timeline.tsx:628-640`.
- `AttachmentGallery` retains parent `stopPropagation`, consumes `isInlineRenderable`, and leaves PDF/HEIC/other file branches as `_blank` links at `Timeline.tsx:643-679`. The same component remains used by MMS at `:967` and email at `:1394`.
- MMS and email eligible-image versus PDF/HEIC behavior is asserted at `dashboard/src/routes/contact/Timeline.mms.test.tsx:427-472` and `dashboard/src/routes/contact/Timeline.email.test.tsx:107-143`.
- Close-first multi-image behavior and viewer survival through retry collapse are asserted at `dashboard/src/routes/contact/Timeline.test.tsx:564-667`.

### S6 - MediaGallery integration and file-pane readers: CONFORMS

- Eligible items become exact-name `View image attachment` buttons and pass exact viewer alt/title `Image attachment` at `dashboard/src/routes/contact/MediaGallery.tsx:21-38` and `:53-73`; key/order and the non-image/paging branches are retained at `:55-86`.
- HEIC remains a link, JPEG becomes a trigger, newest-first order is retained, only one image is active, and paging remains actionable at `dashboard/src/routes/contact/MediaGallery.test.tsx:62-143`.
- Representative UnknownFile and TenantFile host integrations are present at `dashboard/src/routes/contact/UnknownFile.test.tsx:114` and `dashboard/src/routes/contact/files.test.tsx:331`; the live worklist inventory confirms all four production file panes still read the shared component.

### S7 - all current Timeline hosts: CONFORMS

The required production-like reader coverage is present without host-local viewer state:

- Contact route: `dashboard/src/routes/contact/ContactDetail.test.tsx:335`.
- Extracted contact pane: `dashboard/src/routes/contact/ContactCommsPane.test.tsx:206`.
- Relay conversation: `dashboard/src/routes/conversation/ConversationDetail.test.tsx:246`.
- Native group text: `dashboard/src/routes/conversation/GroupTextView.test.tsx:205`.
- Tour conversation: `dashboard/src/routes/tours/TourConversation.test.tsx:287`.
- Placement conversation: `dashboard/src/routes/placements/PlacementConversation.test.tsx:187`.

Each named case opens the shared dialog and checks the surrounding route/tab/filter state after close.

### S8 - hermetic desktop/mobile/shared-host Playwright coverage: CONFORMS

- The desktop 1:1 path proves no new page, same URL, labelled shell, layer 200, large measured canvas, fitted centered image, multiple discrete wheel levels, transient 1..8 bounds, pointer anchoring, bounded pan, exact nested scroll, Escape focus restoration, Ctrl-wheel bounds, reset, and MediaGallery parity at `e2e/tests/dashboard-next/outbound-mms.spec.ts:247-553`.
- The mobile 360x800 path measures full visual-viewport geometry and hostile title containment, proves below-minimum and above-maximum pinch bounds, intermediate pinch levels, touch drag/pan bounds, browser Back, retained Comms state, exact trigger focus, reset, and visible Close at `outbound-mms.spec.ts:555-728`.
- The relay-group host opens the same Timeline viewer and preserves its selected Conversation tab at `outbound-mms.spec.ts:774-808`.

## Independent findings

1. `SC-1` - approved backdrop regression is missing. Severity: must-fix spec-conformance gap, low runtime risk. Resolution described under S3.

No other concrete defect was confirmed from the current tree.

## Attacked but not broken

- Raw History API ownership: production viewer code contains no `window.history.pushState` or `replaceState`; only tests seed/traverse browser entries. Production writes use `useNavigate` at `ImageViewerProvider.tsx:100-113` and `:144-154`.
- Unsafe eligibility widening: neither renderer contains `contentType.startsWith('image/')`; both use `isInlineRenderable` at `Timeline.tsx:664` and `MediaGallery.tsx:57`. The only `_blank` sites are the respective non-image branches at `Timeline.tsx:670-677` and `MediaGallery.tsx:60-71`.
- Router data leakage: provider tests explicitly reject source and alt text in history state at `ImageViewerProvider.test.tsx:210-213`; production serializes only token and return key at `ImageViewerProvider.tsx:108-111`.
- Duplicate dismissal/background Escape: the synchronous Escape-plus-backdrop sequence stays at one history traversal and background document listeners do not fire at `ImageViewerProvider.test.tsx:284-307`; Modal also covers inside/outside descendant prevention at `Modal.test.tsx:348-421`.
- Focus versus inert cleanup: production explicitly releases the portal/inert snapshot before focus at `ImageViewerProvider.tsx:170-175`, and the inert-aware regression rejects focus into an inert tree at `ImageViewerProvider.test.tsx:121-141` and `:185-202`.
- Import cycle: the live import graph remains `main -> provider -> viewer -> Modal`; the viewer's back-reference to `ViewerImage` is type-only at `ImageViewer.tsx:16`, while Timeline and MediaGallery consume only the provider hook.
- Out-of-scope mutation: the feature-only delta `5b2d3a37..HEAD` touches dashboard source/tests, one E2E spec, dashboard dependency metadata, and the root lockfile; it changes no app/media route, MIME, S3, backfill, auth, header, or infrastructure file. `git diff --check 5b2d3a37..HEAD` exits 0.
