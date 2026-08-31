# Viewer lifecycle live-tree research

Snapshot: `feat/mms-image-viewer` at `5b2d3a37` after the prerequisite media-fidelity merge. This is a read-only live-tree audit of the router/provider/history/scroll/portal/test seam. No source, test, package, or git state was changed.

## Verdict

The approved ownership shape fits the live tree without an import cycle or missing production importer:

- `dashboard/src/main.tsx:14-20` is the only production root mount. `BrowserRouter` currently wraps `App`; inserting `ImageViewerProvider` at `main.tsx:16-18` puts it inside the router and above the complete public/authenticated route tree.
- `dashboard/src/App.tsx:93-121` owns the public route split, while `App.tsx:128-268` owns authenticated providers and all routes. Keeping the viewer in `main.tsx` is therefore materially different from mounting it inside `AuthedApp`: it survives auth gates, `AppFrame`, route, pane, and Timeline unmounts as the spec requires.
- `dashboard/src/routes/contact/Modal.tsx` imports only React and its CSS (`:5-6`). A new `ui/imageViewer/ImageViewer.tsx -> routes/contact/Modal.tsx` edge and `Timeline/MediaGallery -> ui/imageViewer/ImageViewerProvider.tsx` edges do not cycle back into either renderer. `main.tsx -> provider -> viewer -> Modal` is acyclic.
- No production code currently writes React Router `location.state`. The only production `useLocation` mutation pattern is QuickReply's router-owned hash replacement; all other `useNavigate` calls are ordinary path navigation. The new viewer marker becomes the first app-owned location-state protocol, so its namespacing/collision tests are load-bearing.
- Hard plan drift found: none. The plan's `main.tsx`, `<main>` scroll-owner, body portal, z-index 200, BrowserRouter state-envelope, and test configuration assumptions match the live tree.

## Stable app/router boundary

Byte-exact live anchors:

- `dashboard/src/main.tsx:3-7` imports `StrictMode`, `createRoot`, `BrowserRouter`, `App`, and global CSS.
- `dashboard/src/main.tsx:14-20` renders exactly `StrictMode -> BrowserRouter -> App`. The provider belongs between `BrowserRouter` and `App`; there is no second production router.
- `dashboard/src/App.tsx:7` imports `Navigate`, `Route`, and `Routes`; routing is component-based rather than a `createBrowserRouter` data-router configuration.
- `dashboard/src/App.tsx:99-119` renders public `/p/:unitId` and `/join` routes as siblings of the `/*` authenticated app. This confirms that `main.tsx` is the only provider location that is both router-aware and stable across the public/auth split.
- `dashboard/src/App.tsx:128-143` mounts `AuthProvider -> AuthGate -> EventStreamProvider -> Routes -> UnreadProvider -> AppFrame` for authenticated pages.
- `dashboard/src/App.tsx:243-260` owns the dynamic contact, conversation, listing, and quick-reply routes. None has a nested router.

Compatible production composition:

```tsx
<StrictMode>
  <BrowserRouter>
    <ImageViewerProvider>
      <App />
    </ImageViewerProvider>
  </BrowserRouter>
</StrictMode>
```

Do not move the provider into `AppFrame` or a route host. `AppFrame` unmounts outside authenticated pages, and every Timeline/file reader is below the route outlet.

## Router state and history contract

### Live app patterns

- `dashboard/src/routes/quickReply/QuickReply.tsx:88-92` is the only production component using both `useLocation` and `useNavigate`.
- `QuickReply.tsx:166-178` explains the invariant: clear the Android action hash through React Router because raw `history.replaceState` would discard the router's own history-entry state.
- `QuickReply.tsx:179-197` parses `location.hash` and calls `navigate({ hash: '' }, { replace: true })`. It deliberately supplies no `state`, so React Router preserves the current location's user state. The new viewer code must follow the same rule: never mutate `window.history` directly.
- `dashboard/src/routes/settings/SettingsPage.tsx:14-20` reads only `location.pathname`; `:34` performs path navigation.
- All other production `useNavigate` users are path-only: `ContactsList.tsx:151,219-226`, `ListingsList.tsx:79,274-277`, `BroadcastsList.tsx:45,94-96`, `RecipientPreview.tsx:91,254-312,470-472`, `EmailTriage.tsx:239,385-397`, `ListingDetail.tsx:183,326-336,1288-1301`, `TourDetail.tsx:158,422-424,496-498`, `ToursPage.tsx:179,364-366`, `PlacementsPage.tsx:52,252-254`, `CreateRelayGroupModal.tsx:233,391-394`, `ThreadUnreadToggle.tsx:100,187-189`, and `ContactDetail.tsx:180,397-400,763-765,852,1082-1084,1148-1177`. None passes a navigation `state` option.
- Repository search found no production `window.history.pushState`, `replaceState`, `back`, `forward`, or `go` use. QuickReply's comment is the only raw-history reference.

### React Router 7.18 live envelope

- `dashboard/package.json:13-17` declares React 19 and `react-router-dom ^7.0.0`; the lockfile resolves both `react-router` and `react-router-dom` to 7.18.0 (`package-lock.json:7369-7401`).
- Installed 7.18.0 code at `node_modules/react-router/dist/development/chunk-4ZMWKKQ3.mjs:222-230` serializes browser state as `{ usr: location.state, key: location.key, idx, masked? }`.
- The same file at `:284-292` initializes/reads `idx`, confirming the plan's BrowserRouter test seed `{ usr, key, idx }` and its `idx` push-count assertion are aligned with the installed implementation.
- Application code must interact only with `useLocation().state` (the `usr` payload) and `useNavigate`; tests may inspect `window.history.state.idx` as version-pinned integration proof.

Marker protocol consequences:

- Open must navigate to the full current `{ pathname, search, hash }`, with `replace: false`, and pass `addImageViewerMarker(location.state, marker)`. This is a same-URL push whose user state is the marker-wrapped payload.
- Explicit Close/Escape/backdrop may call `navigate(-1)` only while the current parsed marker token still equals the visible token. A marker-removal render must never navigate again.
- Back/Forward truth comes from `useLocation`; there should be no separate `isOpen` boolean.
- QuickReply can independently replace a hash entry. If it ever runs while a marker is active, React Router should preserve state because it supplies no state option; retain an explicit provider test that unrelated route/hash navigation preserves non-viewer state.
- Unknown marker cleanup should replace the full current URL and pass `removeImageViewerMarker(location.state)`. It must not call Back.
- BrowserRouter tests are new in this workspace (existing dashboard tests use `MemoryRouter`); reset `window.history` explicitly per provider test so state/index/url do not leak across files or cases.

## Scroll owners, readers, and mutators

The trigger-to-root ancestor walk in the plan matches the real layout and must remain generic.

### AppFrame page owner

- `dashboard/src/app/AppFrame.tsx:174-197` renders the routed column and `<main className={styles.content}><Outlet /></main>`. This actual semantic `<main>` is what Task 8's `element.closest('main')` finds.
- `dashboard/src/app/AppFrame.module.css:328-338` makes the main column a full-height flex column.
- `AppFrame.module.css:383-387` makes `.content` `flex: 1; overflow-y: auto; padding: var(--sp-5)`. This is the page scroll owner, not `window`/`body`.
- `dashboard/src/index.css:12-19` gives `html`, `body`, and `#root` 100% height, reinforcing the internal-scroll layout.

### Timeline owner and all writers/readers

- `dashboard/src/routes/contact/Timeline.tsx:1793-1808` defines `streamRef`, bottom-state refs, `hasNewBelow`, and reads `scrollHeight`, `scrollTop`, and `clientHeight` to classify the reader's position.
- `Timeline.tsx:1810-1824` writes `scrollTop = scrollHeight` for explicit jump-to-bottom and reads it on stream scroll.
- `Timeline.tsx:1831-1840` captures the pre-prepend `scrollHeight` anchor before loading older history.
- `Timeline.tsx:1842-1890` is the automatic scroll mutator: route/conversation changes jump to bottom (`:1860`), older-page prepend corrects by the exact growth delta (`:1870`), and at-bottom growth repins (`:1882`). Viewer restoration therefore must occur in a layout effect after marker traversal and write the exact saved `top/left`; a later Timeline layout effect remains a real competing writer and should be covered by the provider/Playwright restoration tests.
- `Timeline.tsx:2005-2023` renders the actual `.stream` with `ref={streamRef}` and `onScroll={handleStreamScroll}`.
- `dashboard/src/routes/contact/Timeline.module.css:110-147` makes `.stream` the nested owner with `overflow: auto` and disables native overflow anchoring because the component owns prepend correction.
- `Timeline.module.css:630-640` has an additional `.upcoming` scroller and `:796-804` a reply-textarea scroller, but neither is an ancestor of an attachment trigger. The generic ancestor walk correctly excludes them.

Every current Timeline renderer reaches that same owner:

- `dashboard/src/routes/contact/ContactCommsPane.tsx:317-323`
- `dashboard/src/routes/conversation/ConversationDetail.tsx:476-484`
- `dashboard/src/routes/conversation/GroupTextView.tsx:448-452`
- `dashboard/src/routes/tours/TourConversation.tsx:466-471`
- `dashboard/src/routes/placements/PlacementConversation.tsx:319-324`

No host adds a second attachment-specific scroll writer. The common `.stream` and outer AppFrame content are the normal Timeline snapshots.

### File-pane owner

- `dashboard/src/ui/twoPaneShell.module.css:54-69` makes the two-pane body flex and the right/file pane `overflow: auto`.
- `twoPaneShell.module.css:71-85` bleeds that owner into the AppFrame gutter while `.rightInner` holds the file cards.
- `dashboard/src/routes/contact/ContactDetail.tsx:965-986` renders left `ContactCommsPane` and right `.right/.rightInner`.
- `ContactDetail.tsx:993-1064` selects the landlord, partner, unknown, or tenant file reader inside that same right scroll owner. Therefore a MediaGallery trigger normally captures both `.right` and AppFrame `.content`, plus the document scrolling element.

### Other scroll/focus owners

- `dashboard/src/app/AppFrame.tsx:59-108` owns the mobile drawer's body-scroll lock, focus move/trap, Escape, and hamburger restoration. It saves/restores `document.body.style.overflow` at `:72-73,103-107`.
- `AppFrame.module.css:31-40` makes the desktop sidebar independently scrollable; `:407-419` makes the mobile drawer independently scrollable. Neither is an ancestor of an image trigger.
- If the drawer is already open when a viewer opens, the provider's body-sibling inerting and layer 200 cover it, but the drawer remains mounted and its body lock remains active. Viewer cleanup must restore inert values without overwriting the drawer's saved body overflow contract.

Recommended scroll primitive remains the plan's one: walk `trigger.parentElement` upward; capture an element only when computed `overflowX`/`overflowY` is `auto|scroll|overlay` and the corresponding extent exceeds its client extent; add `document.scrollingElement`; dedupe; restore connected owners only. Capture both axes even though the two named owners are primarily vertical.

## Modal, portal, inert, and focus stack

### Existing modal stack

- `dashboard/src/routes/contact/Modal.tsx:8-10` has one module-global `mountedDialogs: HTMLDivElement[]`; this is the only app dialog stack.
- `Modal.tsx:21-29` captures the previously focused element before descendant effects.
- `Modal.tsx:31-49` refreshes `onClose`, pushes the dialog, preserves descendant-established focus, focuses the dialog as fallback, and gives Escape only to the topmost dialog when not already prevented.
- `Modal.tsx:50-67` removes the dialog from the stack and restores focus either within the next topmost dialog or to the pre-mount target.
- `Modal.tsx:70-100` renders labelled `role="dialog"`, `aria-modal="true"`, backdrop dismissal, inside-click suppression, header, close button, scrollable body, and optional footer.
- `dashboard/src/routes/contact/Modal.test.tsx:12-106` pins initial/descendant focus, callback freshness, and descendant-owned Escape; `:109-215` pins topmost Escape/focus behavior; `:218-250` pins trigger restoration.
- `dashboard/src/routes/contact/Modal.module.css:3-12` owns the current z-index 50 backdrop. `:14-35` owns the default 30rem/dvh dialog. `:74-85` makes the default body an `overflow:auto` scroller. The media variant must be additive so the many existing importers keep these defaults.

There are more than twenty production `Modal` consumers across contact, conversation, email, listings, placements, broadcasts, settings, tours, and shared roster components (all import `routes/contact/Modal.tsx`). This validates the plan's requirement to preserve defaults byte-for-byte behaviorally and extend the shared stack instead of forking Escape/focus behavior.

### Existing body portals and layer ceiling

There are exactly three production `createPortal` users before this feature:

- `ContactSearchField.tsx:18-33,237-286` portals its fixed listbox directly to `document.body`; CSS `ContactSearchField.module.css:59-67` uses z-index 100.
- `UnitSearchField.tsx:8-16,209-246` does the same; CSS `UnitSearchField.module.css:59-66` uses z-index 100.
- `StageMenu.tsx:8-27,145-190` portals its fixed menu directly to `document.body`; CSS `StageMenu.module.css:33-45` uses z-index 20.

The live CSS z-index ceiling is 100 for body-portaled listboxes. AppFrame has tooltip/flyout 60, drawer 50, scrim 40, and popover 20 (`AppFrame.module.css:259,312,399,419,518`). Modal is 50. The planned viewer layer 200 is safely above every live layer.

Direct-body sibling inerting is compatible with this structure:

- Production body normally contains `#root`; open listbox/menu portals add sibling elements directly under body.
- The provider-created portal must be a direct body child and must exclude itself while snapshotting every other direct `HTMLElement` child.
- Save each sibling's boolean `inert` before forcing true, including `#root` and any z-index 100 listbox; restore each exact prior value on every active-token transition/unmount. Do not remove or force-close sibling portals.
- Use a layout effect for append/inert and cleanup to avoid a frame in which the layer is visible while siblings remain interactive.
- Keep portal-node ownership provider-local and stable; render one keyed viewer into it. Never append a new portal node on each render/StrictMode effect replay.

## TypeScript and test environment

- `dashboard/tsconfig.json:2-12` is strict through the base config, targets ES2022, includes DOM/DOM.Iterable/WebWorker, uses bundler resolution, React JSX, no emit, and includes `src` plus `vite.config.ts`.
- `tsconfig.base.json:2-12` adds `strict`, `forceConsistentCasingInFileNames`, and `noUncheckedIndexedAccess`. Guard every indexed focusable access and every optional registry lookup.
- `dashboard/vite.config.ts:116-126` runs Vitest in jsdom with globals, `src/test/setup.ts`, dashboard-only `src/**/*.test.{ts,tsx}`, CSS disabled, and a 15s test timeout.
- `dashboard/src/test/setup.ts:7-11` gives Testing Library async helpers 5s.
- `setup.ts:38-48` installs a no-op global `ResizeObserver`. ImageViewer geometry tests must override it locally and restore the prior constructor; otherwise the transform never receives positive canvas dimensions.
- `setup.ts:50-55` stubs `scrollIntoView`; exact scroll restoration tests should define `scrollTop`, `scrollLeft`, `scrollHeight`, and client sizes directly and spy on `focus({ preventScroll: true })` rather than expecting jsdom layout.
- `setup.ts:57-59` already cleans RTL DOM after each test. Tests that manually append body siblings/portal nodes must remove them and restore `window.history` themselves.
- Existing component tests use `MemoryRouter`; it is compatible for renderer/host integration once `ImageViewerProvider` is nested inside it. Provider history semantics require the plan's real `BrowserRouter` + `StrictMode` harness.
- BrowserRouter test setup should seed `window.history.replaceState({ usr, key, idx }, '', path)` before render, then wait/`act` around `history.back()` and `history.forward()` POP events. Assert both `useLocation().state` and `window.history.state.idx`; do not assert against raw `usr` from component code.
- Node 24/browser environments provide `crypto.randomUUID`; if a test environment lacks it, stub only the test global rather than weakening production token opacity.

## Dependency and utility expectations

- `dashboard/package.json:13-17` currently has only React, ReactDOM, and React Router runtime dependencies. `react-zoom-pan-pinch@4.0.4` therefore belongs in this exact dependency object and root `package-lock.json`, not root devDependencies or `app/package.json`.
- Testing dependencies already include jest-dom, RTL, user-event, jsdom, and Vitest (`dashboard/package.json:18-27`); no new test dependency is required.
- The planned `ImageViewer.testUtils.ts` is the right seam because CSS is disabled and jsdom has no layout. It should replace/restore the no-op global `ResizeObserver`, define positive canvas `clientWidth/clientHeight`, fire the observer callback synchronously, set probe `naturalWidth/naturalHeight`, fire `load`, and return the visible image scoped with `within(dialog)`.
- Keep tests importing `.js` specifiers for local TypeScript modules, matching the existing ESM/bundler convention (`main.tsx:6`, `Modal.tsx:6`, and current tests).

## Watch items for implementation/review

1. `Modal` uses a module-global stack and document Escape listener. Extend this stack; do not add a second document Escape listener in the viewer. Viewer keyboard zoom should enter through `onDialogKeyDown`, while Escape continues through the existing topmost handler.
2. `restoreFocus={false}` must suppress Modal's automatic trigger write because the provider alone can verify `returnLocationKey` before restoring nested scroll and focus. The provider should restore scroll first, then `trigger.focus({ preventScroll: true })`.
3. Timeline has real layout-effect scroll writers (`Timeline.tsx:1847-1890`). Restoration tests must prove exact values after dismissal, not merely that the trigger regained focus.
4. Body inert cleanup must tolerate a sibling listbox portal already having `inert=true` and preserve that true value. Do not infer prior state from attribute presence alone; use the boolean property snapshot.
5. Unknown-marker replacement needs a StrictMode idempotency key based on both location key and token. Registry eviction and reload both reach this path.
6. QuickReply proves why raw History API writes are forbidden. Preserve arbitrary record and non-record `location.state`, including collisions with both reserved viewer keys.
7. Provider tests are the workspace's first BrowserRouter/history-envelope tests. Isolate global URL/history per case to prevent seemingly random idx/key failures.
8. No missing importer or cycle was found. The prerequisite renderer helper is live after merge; implementation must continue using `isInlineRenderable` and must not recreate an `image/*` predicate.
