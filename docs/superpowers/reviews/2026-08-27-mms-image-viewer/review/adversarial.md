# Adversarial review: in-app MMS image viewer

## Verdict

CHANGES REQUIRED. I found two high-severity authorization-lifecycle defects and one medium-severity keyboard-focus defect. I reviewed from the diff package and live repository code/tests only; I did not read the spec, plan, worklist, or earlier review reports. Per the dispatch, I made no source changes and ran no test suite or live e2e lane. The only executed probes were isolated Node/browser micro-probes described below.

## Findings

### AD-1 - HIGH - Authenticated MMS PII is reusable from the browser cache after the session cookie changes

Evidence:

- `app/src/routes/api.ts:2244-2252` explicitly classifies `/api/messages/:providerSid/media/:idx` as auth-only PII.
- `app/src/routes/api.ts:2308-2309` nevertheless returns `Cache-Control: private, max-age=3600`. `private` prevents shared-proxy caching; it does not make the browser cache key include the session cookie.
- No app-wide `no-store` header overrides this route. The only other app cache headers found are unrelated identity/public-media routes (`app/src/app.ts:197`, `app/src/routes/appIdentity.ts:31,36,62`, and `app/src/routes/unitMediaServe.ts:69`).

Empirical proof (isolated Chromium, no HousingChoice server or e2e lane): I served the same image URL with `private, max-age=3600`, loaded it with cookie `session=A`, replaced that cookie with `session=B`, and loaded a second document containing the same image URL. The server observed only the first request:

```text
imageHits=1
imageCookies=session=A
```

Impact: a logout, role change, or different login in the same browser does not revoke a fresh cached MMS response. Anyone who can cause the same URL to be rendered during the next hour can receive the previous principal's cached bytes without the API rechecking authorization. AD-2 supplies exactly such a built-in route after logout.

Required repair: authenticated message media should not be reusable across auth epochs. The simplest safe contract is `Cache-Control: private, no-store` (or an equally strong session-bound cache-key design). Add a real-browser regression that loads media as principal A, logs out or changes to principal B, requests the identical URL, and proves a network authorization check occurs and A's bytes are not rendered.

Safe feature probe after repair: in a hermetic browser lane, open an MMS image, close it, sign out, then request the identical media URL and use Forward. Assert the server receives the post-logout request, it is rejected, and no prior image pixels appear.

### AD-2 - HIGH - The viewer registry outlives authentication and can reactivate a signed-out user's descriptor

Evidence:

- `dashboard/src/main.tsx:15-21` mounts `ImageViewerProvider` around the whole `App`, while the authentication lifetime is lower in the tree at `dashboard/src/App.tsx:117,128-135`.
- The provider retains the full `ViewerImage` descriptor, including `src`, `alt`, and optional `title`, in an in-memory registry (`dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:25-39,67,89-99`). Normal dismissal does not delete it; the registry is only trimmed above 20 entries (`:51-61`).
- Sign-out is an in-document state change, not a reload: `dashboard/src/app/AppFrame.tsx:43-55` posts logout and calls `refresh()`, and `dashboard/src/app/AuthGate.tsx:10-19` swaps the authenticated tree for Login. The provider therefore remains mounted with its registry intact.
- A retained history marker plus retained registry entry is sufficient to render the portal again (`dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:78-83,208-220`); no auth state participates in that decision.

Concrete interleaving:

1. Principal A opens an MMS image. The provider saves its URL/title and pushes a same-URL marker entry.
2. A closes the viewer. Back returns to the unmarked entry, but the registry and Forward entry remain.
3. A signs out. Login renders inside `App`; the provider and registry survive.
4. Pressing Forward returns to the marked entry and the provider renders A's viewer over Login. The filename/title leaks immediately from memory, and AD-1 allows the image bytes themselves to render from A's fresh browser cache without a request.

Required repair: tie the provider/registry lifetime to the authenticated principal. Mount it inside the authenticated side of `AuthGate`, or explicitly clear and disable it on every auth loss/principal change. A stale marker encountered while anonymous must be normalized without rendering any retained title or source. Fixing only AD-1 still leaks the retained filename/title; fixing only AD-2 leaves direct same-URL cache reuse possible.

Safe empirical probe: extend an auth-level BrowserRouter test or hermetic e2e case with the four steps above. After sign-out and Forward, assert Login remains the only modal-free surface, the old filename is absent, `[data-image-viewer-portal]` is absent, and the old media URL is not fulfilled from cache.

### AD-3 - MEDIUM - Closing after a live rerender removes the trigger leaves keyboard focus on `body`

Evidence:

- The viewer deliberately disables `Modal` focus restoration (`dashboard/src/ui/imageViewer/ImageViewer.tsx:197-209`) and delegates all restoration to the provider.
- The provider restores focus only when the original trigger remains connected (`dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:168-175`). There is no fallback target when it is disconnected.
- Trigger removal is a live, expected state, not a hypothetical unmount. `dashboard/src/routes/contact/Timeline.test.tsx:599-664` exercises a retry collapse while the viewer stays open and proves `sourceTrigger.isConnected === false`. `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx:378-400` likewise verifies that disconnected trigger focus is skipped, but never asserts a meaningful replacement focus target.

Empirical proof: an isolated DOM probe focused a button and removed it, matching what happens when the focused Close button unmounts without a replacement target:

```text
before=BUTTON
after=BODY
```

Impact: a keyboard or screen-reader user who closes after retry collapse, contact-media refresh, or another live removal loses their place and lands on the document body. The visible scroll position may be restored, but keyboard traversal restarts from an unrelated point.

Required repair: capture a stable, connected fallback in addition to the exact trigger, such as the nearest timeline/media region or an explicit host-provided fallback ref. On verified dismissal, focus the trigger when connected, otherwise focus that fallback with `preventScroll`. Do not restore old-route focus after independent navigation.

Safe empirical probe: open a failed-MMS image by keyboard, rerender the delivered retry so the source trigger disconnects, close with Escape, and assert `document.activeElement` is a named connected fallback in the current timeline, never `body`. Keep the existing independent-navigation case to prove no cross-route focus steal.

## Plausible watch item, not promoted without a feature-level reproduction

- `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx:85-115` guards duplicate opens only by reading the render-captured `location.state`. There is no synchronous `openRequested` latch before `setRegistry()` plus `navigate()`. Two `openImage()` calls before the router commits can therefore attempt two pushes, leaving a viewer behind the viewer so one Close does not dismiss it. The existing duplicate guard covers dismissals (`:118-130` and `ImageViewerProvider.test.tsx:284-308`), not opens. A safe regression probe is to invoke the exposed context callback twice in one `act`, then assert history advances once and one Close returns to the unmarked entry. I attempted an isolated TSX micro-probe, but the local `tsx` launcher failed before executing application code with `uv_os_get_passwd returned ENOMEM`; I am not claiming this as confirmed from that failed probe.

## Attacked but not broken

- Stored-content XSS/type confusion: the dashboard opens only the four exact raster types in `dashboard/src/routes/contact/media.ts:61-74,101-104`; HEIC/TIFF and files stay links. The server independently re-resolves the S3 object's type and applies attachment/opaque downgrade, `nosniff`, and restrictive CSP at `app/src/routes/api.ts:2284-2304`. A forged message-row image type therefore degrades to an image load failure rather than same-origin script execution.
- History-state PII: `dashboard/src/ui/imageViewer/history.ts:85-109` stores only the marker token/location key plus prior opaque router state; image URL/title remain out of `history.state`. The provider tests explicitly assert the serialized state omits `IMAGE.src` and `IMAGE.alt` (`ImageViewerProvider.test.tsx:204-214`). The failure is registry lifetime, not history serialization.
- Modal/background isolation: the provider portals directly under `body`, snapshots/restores existing direct-body inert values, and excludes its own portal (`ImageViewerProvider.tsx:178-204`). `Modal.tsx:73-123,125-155` contains Escape at the topmost media dialog and traps Tab. I found no other production writer of `.inert` in `dashboard/src`, so the snapshot restoration does not currently clobber a competing app-owned inert state.
- Route and scroll integrity: opening preserves pathname/search/hash and opaque state (`ImageViewerProvider.tsx:100-113`); verified dismissal returns with Back and restores connected scroll owners before trigger focus (`:157-176`, `scroll.ts:18-46`). Independent navigation intentionally skips old-route restoration, and existing tests cover Back/Forward, disconnected owners, and forward-entry truncation.
- Zoom bounds and initial fit: `fitImage.ts:8-22` preserves aspect ratio and fills one canvas dimension; `ImageViewer.tsx:236-266` pins scale to 1..8 with bounds limiting and disables double-click zoom. The checked unit/e2e code covers landscape, portrait, very small images, wheel, Ctrl-wheel, pinch, pan bounds, and reset-on-reopen.
- Consumer sweep: Timeline image buttons are shared by contact, relay conversation, native group text, placement, and tour surfaces; MediaGallery is shared by tenant, landlord, partner, and unknown contact files. Both consumers use the root provider at runtime, and the branch adds host-level tests for each Timeline surface plus gallery integration. I found no production consumer that renders these components outside the provider.
- Dependency shape: `react-zoom-pan-pinch` is pinned exactly at 4.0.4 in `dashboard/package.json` and the lockfile records MIT licensing and no native runtime dependency. The remaining architectural cost is that the static root import eagerly includes viewer code even for Login and public `/join`/`/p` routes; I did not classify that as a defect without a measured bundle/page-budget regression.

