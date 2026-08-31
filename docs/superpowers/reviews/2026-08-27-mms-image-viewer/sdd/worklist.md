# In-app MMS image viewer live-tree worklist

Live base for research: `5b2d3a3741e2260dd9420190c8b0db66eb49d697` (human-authorized prerequisite merge).

## Contract and preflight

- `dashboard/src/main.tsx:14-20` is the only stable router-aware mount: provider must be inside `BrowserRouter` and above `App`.
- `dashboard/src/routes/contact/Timeline.tsx:52,633-664,965,1392` and `MediaGallery.tsx:9,20-59` already consume the prerequisite allowlist `isInlineRenderable`; preserve it. The two eligible branches are still `_blank` anchors.
- `main` remains `bd17b7d497c26eb3ec80d2c32032befc6545e0ce`; direct prerequisite merge is the explicit human-authorized replacement for only the prebuild ancestor gate. Final current-main freshness is still a separate human gate.

## Modal / dialog lifecycle (Task 1)

- Mutation/read surfaces: `Modal.tsx:10,35-67` module-global `mountedDialogs`, focus capture/write, and topmost Escape; all 34 current production `<Modal>` consumers catalogued in `.superpowers/sdd/research-modal.md` must retain default behavior.
- `Modal.tsx:12-21,70-100` and `Modal.module.css:3-95`: add only optional media props/classes; default `z-index:50`, 30rem max, glyph close, backdrop behavior, body scroll, and footer remain behaviorally identical.
- Exact media layout chain: `Modal.module.css` must provide `mediaDialog -> mediaBody -> mediaBodyInner` flex sizing, desktop layer 200 and mobile full `100dvh` full-bleed geometry; media title must ellipsize visually without changing its accessible name; only media Close renders visible `Close` text.
- Required discovered enforcement detail: `AppFrame.tsx:59-108` drawer and document-level Escape listeners in `StatusMenu.tsx:148-167`, `CallMenu.tsx:60-74`, `ContactActionsMenu.tsx:76-90`, `ListingActionsMenu.tsx:42-56`, `TourActionsMenu.tsx:63-77`, `PlacementDetail.tsx:800-814`, `ReplyTargetPicker.tsx:28-42`, and `StageMenu.tsx:61-97` remain alive despite body inerting. Media topmost Escape must suppress propagation before they can mutate background UI, while retaining descendant-default-prevention semantics and existing Modal stack behavior. Add a focused regression test using a background document Escape listener; no production menu changes are necessary.
- Reader/layer inventory: body portals at `ContactSearchField.tsx:237-285`, `UnitSearchField.tsx:209-245`, and `StageMenu.tsx:145-190`; ceiling is z-index 100, so media layer 200 stays valid.

## History, provider, focus, portal, and scroll (Tasks 2-3)

- `QuickReply.tsx:166-197` establishes router-owned replace semantics: use `useLocation`/`useNavigate`, never raw History API.
- Router protected-state writers: thumbnail opens, Close/Escape/backdrop `navigate(-1)`, Back/Forward, independent navigation, unknown-marker replacement. Readers: parsed marker, location key, registry, dismissal token guard. Implement plain-record collision-safe state wrapping exactly as plan lines `244-329`; preserve Date/Map/Set/arrays/class state by non-record wrapper.
- Provider state writers/readers: descriptor registry (max 20, non-active eviction), trigger ref, marker-derived active view, body portal/inert lifecycle, and pending dismissal set. No local selected-image boolean.
- Portal/inert invariant: direct body portal excludes itself; snapshot and restore the boolean `inert` property of `#root` and all direct portal siblings exactly. Do not close body portals.
- Real scroll writers/readers: AppFrame `<main>` / `.content` at `AppFrame.tsx:174-197`, `AppFrame.module.css:383-387`; Timeline stream at `Timeline.tsx:1793-1890,2005-2023`, `Timeline.module.css:110-147`; file-pane right side at `twoPaneShell.module.css:54-85`, `ContactDetail.tsx:965-1064`. Capture every connected ancestor whose axis can scroll plus `document.scrollingElement`; restore all exact x/y values in layout effect before connected trigger focus with `preventScroll:true` only at the exact return location key. Timeline layout effects are a competing scroll mutator, so test exact restoration rather than focus alone.
- Provider must normalize structurally valid unknown marker once per `${location.key}:${token}` using router replacement and `removeImageViewerMarker`; no Back, no URL/media data serialization, and no StrictMode loop.

## Viewer, dependency, and transform (Task 4)

- Add `react-zoom-pan-pinch@4.0.4` only to `dashboard/package.json` plus lockfile. Its plan-spiked package contract is `smooth={false}`, `disablePadding`, scale 1..8, wheel step 0.2, pinch step 5, bounded pan, double-click disabled.
- New `ui/imageViewer` file graph: `history.ts`, `scroll.ts`, `ImageViewerProvider.tsx`, `ImageViewer.tsx`, `ImageViewer.module.css`, `fitImage.ts`, and focused `*.test.*` utilities. Imports are acyclic: `main -> provider -> viewer -> Modal`, renderers -> provider hook.
- Viewer geometry writers/readers: hidden image probe natural dimensions, canvas `ResizeObserver`, `fitImageToCanvas`, wrapper key token/fitted size, transform callback, keyboard command sequence, polite hidden output diagnostics. Canvas must be definite flex-fill beneath actions and probe/loading/error overlays must be absolute so they cannot create its dimensions.
- Keep only Close and Download visible. Keyboard `+`/`=`/`-`/`0` acts through Modal's dialog key prop only without Ctrl/Meta/Alt interception; live-region text is updated only for keyboard commands and replaces its keyed child on a no-op reset.
- Test helper must install a positive synchronous ResizeObserver, explicitly fire the hidden probe load, and query the real visible image scoped inside the dialog.

## Renderer/host and browser coverage (Tasks 5-8)

- Timeline mutator/readers: `AttachmentGallery` at `Timeline.tsx:633-664` shared by MMS `:965` and email `:1392`; preserve parent click `stopPropagation` and non-image links. Make image trigger a child hook owner named `View ${attachmentLabel}`.
- File gallery mutator/readers: `MediaGallery.tsx:20-59` is shared by TenantFile, LandlordFile, PartnerFile, and UnknownFile. Make only allowed images semantic triggers named `View image attachment`; preserve new-first mapping, paging, PDFs/HEIC/non-image anchors, and no host-local viewer state.
- Timeline host reader map: ContactCommsPane `:317-323` (fed by ContactDetail), ConversationDetail `:476-484`, GroupTextView `:448-452`, TourConversation `:466-471`, PlacementConversation `:319-324`. Tests must wrap each production-like route/harness with the provider, assert trigger/dialog/focus, and retain surrounding route/tab state.
- E2E owner: `e2e/tests/dashboard-next/outbound-mms.spec.ts:17-164` for 1:1 plus `:167+` relay. Use the e2e workspace focused command only. Add transform recorder, desktop canvas geometry, hard-bound wheel/Ctrl-wheel/pinch, mobile Back, MediaGallery parity, and relay proof as plan specifies.

## Research decisions

- No import cycle, missing importer, or incompatible Router envelope was found.
- The direct Escape interception is a plan-unlisted enforcement detail required by the approved topmost-dialog/inert contract. It is contained to the media Modal variant plus its regression test and will be reviewed as a watch item.
- `npm run bootstrap:check` currently exits 1 because this host lacks resolvable `housingchoice` AWS credentials. This is an environment guard, not a source failure; retry only when credentials are supplied and report it truthfully.
