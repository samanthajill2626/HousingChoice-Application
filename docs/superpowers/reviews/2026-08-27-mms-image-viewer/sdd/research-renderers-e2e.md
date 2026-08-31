# Renderer and E2E live-tree research

- `dashboard/src/routes/contact/Timeline.tsx:633-664` owns the shared AttachmentGallery used by MMS at `:965` and email at `:1392`. It already imports `isInlineRenderable` at `:52`, stops parent propagation at `:645`, and sends each eligible attachment to `messageMediaSrc(sid, i)` at `:647`. The eligible branch remains an `_blank` anchor, `styles.mediaLink`, at `:648-664`.
- `dashboard/src/routes/contact/Timeline.module.css:257-260` owns the current inline media link shell.
- `dashboard/src/routes/contact/MediaGallery.tsx:20-59` is the only shared file-pane gallery. It maps `isInlineRenderable(m.contentType)` at `:36`, but its image tile still uses `_blank` (`:37-45`); its non-image link branch begins `:46`. `MediaGallery.module.css:7-25` owns the shared tile geometry/focus style.
- Host imports of the shared Timeline are live at ContactCommsPane `:26,319`, ConversationDetail `:32,480`, GroupTextView `:21,448`, TourConversation `:44,467`, and PlacementConversation `:55,320`. ContactDetail feeds ContactCommsPane (`dashboard/src/routes/contact/ContactDetail.tsx:75,285`), so the plan's six host tests cover the current reader graph.
- `MediaGallery` is the shared reader for TenantFile, LandlordFile, PartnerFile, and UnknownFile; preserve that one component boundary rather than adding host state.
- `e2e/tests/dashboard-next/outbound-mms.spec.ts:17-164` contains the 1:1 create/send/current Timeline assertions and imports `expectNoHorizontalOverflow` at `:10`; the PNG fixture is `:32`. Relay proof is in the same file at `:167+`, with the live group route constants at `:36-50` and existing authenticated send helper at `:69-83`. This is the correct sole Playwright file.

## Contract risks

1. Do not reintroduce broad `image/*`: the prerequisite's `isInlineRenderable` imports are already present in both renderers.
2. New image buttons need their own hook-owning child component; `AttachmentGallery` is a plain helper and must not call a hook conditionally in the attachment map.
3. Browser renderer tests must scope loaded visible-image queries to the dialog because thumbnails remain mounted with the same accessible name.
4. Every test harness rendering a trigger must include `ImageViewerProvider`; production ownership stays at the app root.
