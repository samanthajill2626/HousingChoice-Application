<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-27).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `documentation/GLOSSARY.md`). The mission's review record is preserved at
> `docs/superpowers/reviews/2026-08-27-mms-image-viewer/`.

# In-app MMS Image Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace raw-window navigation for renderable communication images with one accessible, single-image, in-app viewer whose browser Back behavior, direct-manipulation zoom, focus, and scroll restoration work consistently on desktop and mobile.

**Architecture:** Mount one `ImageViewerProvider` inside `BrowserRouter` and above the route tree. Thumbnail buttons register an in-memory image descriptor plus return context, then add one same-URL React Router state marker; the provider renders a body portal and derives open state exclusively from that marker. A HousingChoice-owned modal shell contains `react-zoom-pan-pinch`, while shared history, scroll, inert, focus, and stale-marker behavior remain outside the gesture package.

**Tech Stack:** React 19, TypeScript, React Router 7, `react-zoom-pan-pinch` 4.0.4, CSS Modules, Vitest/Testing Library, Playwright Chromium, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-27-mms-image-viewer-design.md`

## Global Constraints

- Renderable communication images open in an in-app viewer and never open a raw media page or a new browser page/window.
- The viewer owns exactly one image at a time; close it before choosing another thumbnail. Do not add a carousel, previous/next controls, a filmstrip, or swipe-between-images behavior.
- Desktop is a large centered modal over the dimmed current page; mobile is a full visual-viewport viewer at 360px width and representative phone heights.
- The image opens fitted and centered at scale 1, has minimum scale 1 and maximum scale 8, and resets to fitted scale 1 after close/reopen.
- Mouse wheel/trackpad and touch pinch provide multiple zoom levels; drag pans only an enlarged image and remains bounded.
- Do not add visible plus, minus, zoom-percentage, or Reset controls. Keyboard `+`/`=`, `-`, and `0` are the non-pointer zoom commands; modified Ctrl/Cmd shortcuts remain browser-owned.
- Persistent visible actions are text-labelled Close and Download. Desktop backdrop, Escape, and Close share the same guarded dismissal path; mobile has no exposed backdrop dismissal and no swipe-to-dismiss.
- Opening pushes one transient same-URL entry through React Router. Browser or Android Back closes the viewer, and no image identity appears in path, search, hash, persisted storage, or a restorable/shareable URL.
- Preserve existing router user state. Forward may reopen a retained same-session descriptor; reload never reconstructs it and strips an unknown marker in place.
- Restore every surviving recorded scroll owner and the exact connected trigger only after returning to the marker's exact `returnLocationKey`; independent navigation receives no old-route scroll or focus writes.
- The portal is a direct child of `body`, owns z-index 200, makes every other existing body child inert while open, and restores each sibling's exact previous inert value.
- Keep existing form-modal visuals and default behavior unchanged; extend or extract the existing `Modal` focus/Escape/topmost-dialog lifecycle instead of creating a competing modal stack.
- `react-zoom-pan-pinch` 4.0.4 is a dashboard runtime dependency only. Do not add it to the server `app` workspace.
- Use the prerequisite media classification's `isInlineRenderable` allowlist for JPEG, PNG, GIF, and WebP. Do not reintroduce `contentType.startsWith('image/')` or change MIME serving, S3 metadata, backfill, auth, headers, or Content-Disposition behavior.
- Timeline applies to contact, relay conversation, native group text, tour conversation, and placement conversation hosts. MediaGallery applies to tenant, landlord, partner, and unknown-contact file panes.
- Timeline trigger names reuse the existing attachment label. MediaGallery uses exact trigger name `View image attachment` and exact viewer alt `Image attachment`.
- Non-image links retain their current behavior. Composer previews, listing photos, public flyer media, and all unrelated galleries remain outside scope.
- New and touched lines are ASCII-only. New automated user-facing copy must use the message catalog if it is automated copy; the static viewer labels in this plan remain component UI copy.
- Never deploy, mutate infrastructure, push secrets, run a media backfill, merge into `main`, or clean up the worktree. Merge and deployment remain human-owned.

---

## Build preflight and prerequisite sync

No source task begins until the already-reviewed media classification branch is present on `main`. This is the approved exception to the repository's usual final-sync timing: the viewer cannot be implemented safely against the broad `image/*` renderer currently on this branch.

- [ ] **Step 1: Verify the worktree, branch, and prerequisite commit**

Run from `W:\tmp\mms-image-viewer`:

```powershell
git status --short
git branch --show-current
git merge-base --is-ancestor e3a97e7741d24d400f01b2a434aae9cd842a3031 main
```

Expected: the tree is clean, the branch is `feat/mms-image-viewer`, and `git merge-base` exits 0. If the final command exits nonzero, write `STATUS: QUESTION` to the mission ledger and stop; the human must merge `feat/media-content-type-fidelity` first.

- [ ] **Step 2: Sync the prerequisite from `main` before implementation**

```powershell
git merge main --no-edit
git status --short
rg -n "isInlineRenderable" dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/MediaGallery.tsx
```

Expected: merge exit 0, clean tree, and both renderers call `isInlineRenderable`. Record the synced `main` SHA in the ledger. At final verification, this also satisfies the final-sync gate only if `main` is still at this exact SHA; Task 9 stops for a human decision if `main` advances.

- [ ] **Step 3: Install the synced workspace without changing dependency intent**

```powershell
npm install
npm run bootstrap:check
```

Expected: both commands exit 0. If `npm install` changes the lockfile before Task 4 adds the planned package, inspect why and do not commit unrelated lockfile churn.

## File and responsibility map

- `dashboard/src/routes/contact/Modal.tsx`: additive media variant, focus containment, explicit initial-focus and restore-focus controls, and the repository's single topmost-dialog stack.
- `dashboard/src/routes/contact/Modal.module.css`: preserve default modal styling while adding the media shell's layer and responsive geometry.
- `dashboard/src/ui/imageViewer/history.ts`: namespaced marker parsing/add/remove with exact router user-state preservation.
- `dashboard/src/ui/imageViewer/scroll.ts`: discover, snapshot, and restore real nested scroll owners without CSS-module knowledge.
- `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx`: descriptor registry, React Router transitions, stale-marker normalization, portal/inert lifecycle, and verified focus/scroll restoration.
- `dashboard/src/ui/imageViewer/ImageViewer.tsx`: visible shell, Download, loading/failure UI, transform engine, keyboard commands, hidden announcements, and E2E-readable transform state.
- `dashboard/src/ui/imageViewer/ImageViewer.module.css`: dark canvas, action bar, spinner/failure state, safe-area full-screen mobile layout, gesture containment, and visually hidden output.
- `dashboard/src/main.tsx`: mount the provider inside `BrowserRouter` and above `App`.
- `dashboard/src/routes/contact/Timeline.tsx` and `.module.css`: convert eligible Timeline image anchors to viewer buttons without changing non-image links or message-card click behavior.
- `dashboard/src/routes/contact/MediaGallery.tsx` and `.module.css`: convert eligible file-pane image tiles to viewer buttons while keeping paging and file links intact.
- Focused `*.test.tsx` files beside each unit: component contracts and every current host/read surface.
- `dashboard/package.json` and root `package-lock.json`: pin `react-zoom-pan-pinch` 4.0.4 in the dashboard workspace.
- `e2e/tests/dashboard-next/outbound-mms.spec.ts`: real authenticated desktop and mobile viewer proof through Timeline and MediaGallery.

### Task 1: Extend the shared Modal lifecycle for media dialogs

**Files:**
- Modify: `dashboard/src/routes/contact/Modal.tsx`
- Modify: `dashboard/src/routes/contact/Modal.module.css`
- Modify: `dashboard/src/routes/contact/Modal.test.tsx`

**Interfaces:**
- Consumes: the existing `mountedDialogs` topmost stack and default `ModalProps` behavior.
- Produces: `ModalProps.variant?: 'default' | 'media'`, `headerActions?: React.ReactNode`, `trapFocus?: boolean`, `initialFocus?: 'dialog' | 'close'`, `restoreFocus?: boolean`, and `onDialogKeyDown?: React.KeyboardEventHandler<HTMLDivElement>`; all defaults preserve current consumers.

- [ ] **Step 1: Add failing tests for the additive media contract**

Add tests that render a default modal and a media modal. Use this concrete media fixture:

```tsx
render(
  <Modal
    title="Image attachment"
    variant="media"
    headerActions={<a href="/api/messages/MM1/media/0" download>Download</a>}
    trapFocus
    initialFocus="close"
    restoreFocus={false}
    onDialogKeyDown={onDialogKeyDown}
    onClose={onClose}
  >
    <img src="/api/messages/MM1/media/0" alt="Image attachment" />
  </Modal>,
);
```

Assert that Close has visible text `Close`, receives initial focus, Tab and Shift+Tab remain inside the media dialog, `onDialogKeyDown` receives `0`, Escape still closes only the topmost modal, and unmount with `restoreFocus={false}` does not move focus. Retain the existing default-modal assertions so its 30rem shell, icon presentation, Escape behavior, and automatic focus restoration remain unchanged.

Render a second media modal with `title={`${'a'.repeat(2048)}.png`}`. Assert the dialog retains that full accessible name while Download and Close remain separate labelled actions; this fixture feeds the responsive containment proof in Task 8.

- [ ] **Step 2: Run the focused test and verify the new assertions fail**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/Modal.test.tsx
```

Expected: exit 1 because the new props and media behavior do not exist.

- [ ] **Step 3: Implement the additive API and focus trap**

Extend the props exactly as follows:

```tsx
export interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  variant?: 'default' | 'media';
  headerActions?: React.ReactNode;
  trapFocus?: boolean;
  initialFocus?: 'dialog' | 'close';
  restoreFocus?: boolean;
  onDialogKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
}
```

Use a `closeRef`, select enabled anchors/buttons/inputs/selects/textareas and nonnegative `tabindex` descendants, and wrap Tab only when this dialog is topmost and `trapFocus` is true. Focus Close when `initialFocus === 'close'`; otherwise preserve the current descendant-or-dialog behavior. Skip the existing cleanup focus write when `restoreFocus` is false. Render `headerActions` inside a dedicated `styles.headerActions` wrapper before the Close button, use visible `Close` text only for `variant === 'media'`, call `onDialogKeyDown` from the dialog's `onKeyDown`, and add `styles.mediaBackdrop`/`styles.mediaDialog` only for the media variant.

Set `data-modal-variant={variant}` on the backdrop so integration tests can identify the owned layer without a CSS-module class name. Apply media-only classes to every link in the sizing chain: `mediaDialog`, `mediaBody`, and `mediaBodyInner`. The media CSS must use these exact responsibilities:

```css
.mediaDialog {
  width: min(72rem, calc(100vw - (2 * var(--sp-6))));
  height: min(52rem, calc(100dvh - (2 * var(--sp-6))));
  max-width: none;
  max-height: none;
}

.mediaBody {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.mediaBodyInner {
  display: flex;
  min-height: 0;
  height: 100%;
  padding: 0;
}
```

The owned overlay remains `z-index: 200` with bounded desktop margins. Under 600px, the media backdrop has no padding and `mediaDialog` becomes square-cornered `width: 100vw; height: 100dvh`. Inside the media header, set the title to `min-width: 0`, `flex: 1 1 auto`, `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap`; set the header-actions wrapper and media Close button to `flex: 0 0 auto`. The full title remains in the heading and accessible name while an unbroken sender filename cannot displace either action. Default classes remain byte-for-byte behaviorally equivalent.

- [ ] **Step 4: Run focused Modal tests and dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/Modal.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the independently testable Modal extension**

```powershell
git status --short
git add dashboard/src/routes/contact/Modal.tsx dashboard/src/routes/contact/Modal.module.css dashboard/src/routes/contact/Modal.test.tsx
git commit -m "feat: extend modal lifecycle for media viewer" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 2: Add router-state and nested-scroll primitives

**Files:**
- Create: `dashboard/src/ui/imageViewer/history.ts`
- Create: `dashboard/src/ui/imageViewer/history.test.ts`
- Create: `dashboard/src/ui/imageViewer/scroll.ts`
- Create: `dashboard/src/ui/imageViewer/scroll.test.ts`

**Interfaces:**
- Consumes: React Router user state as `unknown`, a connected trigger `HTMLElement`, and DOM scroll owners.
- Produces: `ImageViewerMarker`, `readImageViewerMarker`, `addImageViewerMarker`, `removeImageViewerMarker`, `ScrollSnapshot`, `captureScrollOwners`, and `restoreScrollOwners` with the exact signatures below.

- [ ] **Step 1: Write failing pure tests for exact state preservation**

Use these exported types and cases in `history.test.ts`:

```ts
export interface ImageViewerMarker {
  token: string;
  returnLocationKey: string;
}

const marker = { token: 'viewer-1', returnLocationKey: 'route-key-1' };
const markedRecord = addImageViewerMarker({ from: 'inbox' }, marker);
expect(markedRecord).toMatchObject({ from: 'inbox' });
expect(readImageViewerMarker(markedRecord)).toEqual(marker);
expect(removeImageViewerMarker(markedRecord)).toStrictEqual({ from: 'inbox' });
expect(removeImageViewerMarker(addImageViewerMarker('legacy-state', marker))).toBe('legacy-state');
expect(readImageViewerMarker({ __hcImageViewer: { token: 1 } })).toBeUndefined();
```

Also prove `null`, arrays, numbers, malformed markers, `Date`, and `Map` normalize without throwing and round-trip exactly, and that removing a marker from an ordinary record preserves every unrelated key.
Add a record containing pre-existing `__hcImageViewer` and `__hcImageViewerPriorState` fields and assert add/remove returns it with `toStrictEqual`; the red implementation must not be allowed to treat namespace-key presence as proof of ownership.

- [ ] **Step 2: Write failing DOM tests for real scroll-owner discovery**

Construct `page -> stream -> trigger`, stub `getComputedStyle` so page and stream report `overflowY: 'auto'`, and define nonzero scroll/client dimensions. Assert both ancestors plus `document.scrollingElement` are captured once with exact `scrollTop`/`scrollLeft`; mutation followed by `restoreScrollOwners` returns exact values; disconnected owners are skipped.

- [ ] **Step 3: Run the two test files and verify missing-module failures**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts
```

Expected: exit 1 because both production modules are absent.

- [ ] **Step 4: Implement the namespaced router-state helpers**

Use a versioned owned marker whose metadata distinguishes record and non-record state and preserves namespace collisions:

```ts
const MARKER_KEY = '__hcImageViewer';
const PRIOR_STATE_KEY = '__hcImageViewerPriorState';

export interface ImageViewerMarker {
  token: string;
  returnLocationKey: string;
}

type StoredImageViewerMarker = ImageViewerMarker & {
  version: 1;
  priorStateKind: 'record' | 'non-record';
  priorMarker:
    | { present: false }
    | { present: true; value: unknown };
};

interface WrappedPriorState {
  ownerToken: string;
  value: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function addImageViewerMarker(
  state: unknown,
  marker: ImageViewerMarker,
): Record<string, unknown> {
  if (isPlainRecord(state)) {
    const present = Object.prototype.hasOwnProperty.call(state, MARKER_KEY);
    const stored: StoredImageViewerMarker = {
      ...marker,
      version: 1,
      priorStateKind: 'record',
      priorMarker: present
        ? { present: true, value: state[MARKER_KEY] }
        : { present: false },
    };
    return { ...state, [MARKER_KEY]: stored };
  }
  const stored: StoredImageViewerMarker = {
    ...marker,
    version: 1,
    priorStateKind: 'non-record',
    priorMarker: { present: false },
  };
  const prior: WrappedPriorState = { ownerToken: marker.token, value: state };
  return { [PRIOR_STATE_KEY]: prior, [MARKER_KEY]: stored };
}

export function removeImageViewerMarker(state: unknown): unknown {
  if (!isPlainRecord(state)) return state;
  const stored = readStoredImageViewerMarker(state);
  if (stored === undefined) return state;
  if (stored.priorStateKind === 'non-record') {
    const prior = state[PRIOR_STATE_KEY];
    if (isWrappedPriorState(prior) && prior.ownerToken === stored.token) return prior.value;
  }
  const next = { ...state };
  if (stored.priorMarker.present) next[MARKER_KEY] = stored.priorMarker.value;
  else delete next[MARKER_KEY];
  return next;
}
```

Implement private structural guards `readStoredImageViewerMarker` and `isWrappedPriorState` using `isPlainRecord`; require version 1, the exact state-kind union, and nonempty string `token`/`returnLocationKey`. `readImageViewerMarker` returns only the public `{ token, returnLocationKey }`. Date, Map, Set, arrays, and class instances use the owned non-record wrapper rather than object spread. Add collision tests that round-trip this exact record without losing or rewriting either reserved field:

```ts
const collidingState = {
  from: 'inbox',
  __hcImageViewer: { legacy: true },
  __hcImageViewerPriorState: 'keep this field',
};
expect(removeImageViewerMarker(addImageViewerMarker(collidingState, marker))).toStrictEqual(
  collidingState,
);
const when = new Date('2026-08-27T12:00:00.000Z');
expect(removeImageViewerMarker(addImageViewerMarker(when, marker))).toStrictEqual(when);
const mapped = new Map([['from', 'inbox']]);
expect(removeImageViewerMarker(addImageViewerMarker(mapped, marker))).toStrictEqual(mapped);
```

- [ ] **Step 5: Implement connected nested-scroll capture and restoration**

Use these public types/signatures:

```ts
export interface ScrollSnapshot {
  element: HTMLElement;
  top: number;
  left: number;
}

export function captureScrollOwners(trigger: HTMLElement): ScrollSnapshot[];
export function restoreScrollOwners(snapshots: readonly ScrollSnapshot[]): void;
```

Walk `trigger.parentElement` to `document.documentElement`. Record an ancestor when computed `overflowX` or `overflowY` matches `/auto|scroll|overlay/` and its corresponding scroll extent exceeds its client extent. Always add `document.scrollingElement` when it is an `HTMLElement`, deduplicate with a `Set`, and restore only elements whose `isConnected` is true.

- [ ] **Step 6: Run primitive tests and dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit the pure primitives**

```powershell
git status --short
git add dashboard/src/ui/imageViewer/history.ts dashboard/src/ui/imageViewer/history.test.ts dashboard/src/ui/imageViewer/scroll.ts dashboard/src/ui/imageViewer/scroll.test.ts
git commit -m "feat: add image viewer history and scroll primitives" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 3: Build the app-level provider, portal, and guarded history lifecycle

**Files:**
- Create: `dashboard/src/ui/imageViewer/ImageViewerProvider.tsx`
- Create: `dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx`
- Create: `dashboard/src/ui/imageViewer/ImageViewer.tsx`
- Create: `dashboard/src/ui/imageViewer/ImageViewer.module.css`
- Modify: `dashboard/src/main.tsx`

**Interfaces:**
- Consumes: `ImageViewerMarker`, `addImageViewerMarker`, `readImageViewerMarker`, `removeImageViewerMarker`, `captureScrollOwners`, `restoreScrollOwners`, the extended media `Modal`, `useLocation`, and `useNavigate`.
- Produces: `ViewerImage`, `ImageViewerContextValue`, `ImageViewerProvider`, `useImageViewer`, and `ImageViewerProps` with the exact signatures below. Renderer tasks call only `useImageViewer().openImage`.

- [ ] **Step 1: Add failing provider tests under real BrowserRouter and StrictMode**

Create a harness that seeds pre-existing router user state and exposes a real button:

```tsx
function ViewerHarness(): React.JSX.Element {
  const { openImage } = useImageViewer();
  const location = useLocation();
  return (
    <>
      <output data-testid="route-state">{JSON.stringify(location.state)}</output>
      <button
        type="button"
        onClick={(event) =>
          openImage(
            {
              src: '/api/messages/MM1/media/0',
              alt: 'Front porch.jpg',
              title: 'Front porch.jpg',
            },
            event.currentTarget,
          )
        }
      >
        View Front porch.jpg
      </button>
    </>
  );
}
```

Before render, seed BrowserRouter's envelope with:

```ts
window.history.replaceState(
  { usr: { from: 'inbox' }, key: 'contact-entry', idx: 0 },
  '',
  '/contacts/tenant-1',
);
```

Render `StrictMode -> BrowserRouter -> ImageViewerProvider -> ViewerHarness` and prove:

- one click increments `window.history.state.idx` from 0 to 1 exactly once and keeps the URL `/contacts/tenant-1`;
- a second direct `openImage` call while that marker is active is ignored and does not create a second viewer entry;
- rerender and image load do not change the index;
- Back removes the dialog without a second traversal and restores `{ from: 'inbox' }`;
- Forward reopens the same image during the provider lifetime;
- Close, Escape, and desktop backdrop each return from index 1 to 0 exactly once;
- two synchronous dismissal events for one token cause one traversal;
- programmatic navigation to `/other` while open removes the portal but does not restore the old trigger or scroll positions;
- an unmounted/disconnected trigger is not focused on verified dismissal;
- remounting the provider on an entry containing an unknown marker replaces only that marker, never reopens or calls Back, never loops in StrictMode, and preserves prior non-record state;
- after unknown-marker normalization, Back then Forward traverses clean same-URL entries without reopening or auto-bouncing;
- a sibling body portal whose prior `inert` value is true and the app root whose prior value is false both receive `inert = true` while open and regain their exact values on close;
- the media backdrop carries `data-modal-variant="media"` while the sibling portal remains inert at z-index 100;
- router state contains the opaque token and return key but never the source URL, alt, or title;
- opening a new viewer after Back truncates the old Forward branch under normal browser semantics;
- Forward activation refreshes current connected-owner scroll snapshots before a later close.

- [ ] **Step 2: Add failing scroll/focus lifecycle tests around AppFrame-like and Timeline-like owners**

Nest the trigger in two overflow owners with distinct x/y values:

```ts
pageScroller.scrollTop = 140;
pageScroller.scrollLeft = 9;
timelineScroller.scrollTop = 420;
timelineScroller.scrollLeft = 3;
```

Open, mutate all four values, and separately dismiss by Back, Close, Escape, and backdrop. Each verified return must restore `140/9` and `420/3`, then call the trigger's `focus({ preventScroll: true })`. For an independent `/other` location key, assert the destination's chosen values remain untouched and the trigger is not focused.

- [ ] **Step 3: Run the provider test and verify the missing implementation fails**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx
```

Expected: exit 1 because the provider, hook, and viewer shell do not exist.

- [ ] **Step 4: Define the provider and viewer interfaces**

Use these exported contracts:

```tsx
export interface ViewerImage {
  src: string;
  alt: string;
  title?: string;
}

export interface ImageViewerContextValue {
  openImage: (image: ViewerImage, trigger: HTMLElement) => void;
}

export interface ImageViewerProps {
  token: string;
  image: ViewerImage;
  onDismiss: (token: string) => void;
}
```

The provider's private registry entry is:

```ts
interface RegistryEntry {
  image: ViewerImage;
  trigger: HTMLElement;
  scroll: ScrollSnapshot[];
}
```

Use `crypto.randomUUID()` for the opaque token and `const MAX_RETAINED_IMAGES = 20`. When adding entry 21, evict the oldest non-active token. If Forward later reaches an evicted token, the unknown-marker normalization path handles it.

- [ ] **Step 5: Implement the single-push open and guarded dismissal paths**

In the thumbnail event callback, capture the current location synchronously, register the descriptor, then navigate once:

```tsx
const openImage = useCallback(
  (image: ViewerImage, trigger: HTMLElement): void => {
    if (readImageViewerMarker(location.state) !== undefined) return;
    const token = crypto.randomUUID();
    registryRef.current.set(token, {
      image,
      trigger,
      scroll: captureScrollOwners(trigger),
    });
    trimRegistry(registryRef.current, token);
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      {
        replace: false,
        state: addImageViewerMarker(location.state, {
          token,
          returnLocationKey: location.key,
        }),
      },
    );
  },
  [location, navigate],
);
```

Derive `activeEntry` only from `readImageViewerMarker(location.state)` plus the registry. Implement `requestDismiss(token)` with a synchronous `dismissRequestedRef` set: if the location marker is absent, differs from `token`, or the token was already requested, return without navigating; otherwise add the token and call `navigate(-1)`. Clear the set when the location no longer carries that token so same-session Forward can be dismissed normally.

- [ ] **Step 6: Implement transition-sensitive restoration and stale-marker normalization**

Keep the previously active `{ marker, entry }` pair in a ref. When a marker becomes active, refresh its scroll snapshot if its trigger remains connected; this covers Forward after the user changed underlying scroll. When a previously visible marker disappears:

```ts
if (location.key === previous.marker.returnLocationKey) {
  restoreScrollOwners(previous.entry.scroll);
  if (previous.entry.trigger.isConnected) {
    previous.entry.trigger.focus({ preventScroll: true });
  }
}
```

For every other location key, discard the active restoration context without writing scroll or focus.

When a structurally valid marker has no registry entry, guard with a ref keyed by `${location.key}:${marker.token}` and run one replacement:

```tsx
navigate(
  { pathname: location.pathname, search: location.search, hash: location.hash },
  { replace: true, state: removeImageViewerMarker(location.state) },
);
```

Never call Back from marker cleanup and never serialize `image.src`, `image.alt`, or `image.title` into router state.

- [ ] **Step 7: Implement the body portal, inert cleanup, and basic shell**

Create one provider-owned portal node with `data-image-viewer-portal="true"`. Use layout effects for portal/inert setup and verified scroll/focus restoration so background interaction and restoration cannot flash a frame behind the dialog. While active, append the node directly to `document.body`, snapshot every other direct `HTMLElement` child's boolean `inert` value, set each to true, and restore those values before removing the portal. Render exactly one keyed viewer:

```tsx
createPortal(
  <ImageViewer
    key={activeMarker.token}
    token={activeMarker.token}
    image={activeEntry.image}
    onDismiss={requestDismiss}
  />,
  portalNode,
);
```

The initial `ImageViewer` uses the media Modal with `title={image.title ?? image.alt}`, `trapFocus`, `initialFocus="close"`, `restoreFocus={false}`, a Download anchor with `href={image.src}` and `download`, and one non-focusable `<img alt={image.alt}>`. Pass `onDismiss(token)` to Close, Escape, and backdrop through the Modal's one `onClose` callback.

- [ ] **Step 8: Mount the provider at the stable app boundary**

Change `dashboard/src/main.tsx` to:

```tsx
<StrictMode>
  <BrowserRouter>
    <ImageViewerProvider>
      <App />
    </ImageViewerProvider>
  </BrowserRouter>
</StrictMode>
```

This location must remain above public/authenticated routes so a Timeline message, file pane, AppFrame outlet, or whole route can unmount without owning viewer history.

- [ ] **Step 9: Run the provider, Modal, and primitive tests plus dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewerProvider.test.tsx src/ui/imageViewer/history.test.ts src/ui/imageViewer/scroll.test.ts src/routes/contact/Modal.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0.

- [ ] **Step 10: Commit the stable provider lifecycle**

```powershell
git status --short
git add dashboard/src/ui/imageViewer/ImageViewerProvider.tsx dashboard/src/ui/imageViewer/ImageViewerProvider.test.tsx dashboard/src/ui/imageViewer/ImageViewer.tsx dashboard/src/ui/imageViewer/ImageViewer.module.css dashboard/src/main.tsx
git commit -m "feat: add app-level image viewer lifecycle" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 4: Add the pinned gesture engine and complete the viewer interaction shell

**Files:**
- Modify: `dashboard/package.json`
- Modify: `package-lock.json`
- Modify: `dashboard/src/ui/imageViewer/ImageViewer.tsx`
- Modify: `dashboard/src/ui/imageViewer/ImageViewer.module.css`
- Create: `dashboard/src/ui/imageViewer/ImageViewer.test.tsx`
- Create: `dashboard/src/ui/imageViewer/ImageViewer.testUtils.ts`
- Create: `dashboard/src/ui/imageViewer/fitImage.ts`
- Create: `dashboard/src/ui/imageViewer/fitImage.test.ts`

**Interfaces:**
- Consumes: `ImageViewerProps`, media `Modal.onDialogKeyDown`, image natural dimensions, canvas dimensions, `ResizeObserver`, and `react-zoom-pan-pinch` controls/state.
- Produces: `fitImageToCanvas(natural: Size, canvas: Size): Size`, the test-only `installImageViewerResizeObserver` and `loadViewerImage` helpers, plus the finished single-image viewer with scale range 1..8, bitmap-aware bounded transform state, loading/error behavior, hidden keyboard announcement, and stable `data-image-viewer-*` diagnostics for Playwright.

- [ ] **Step 1: Add the exact dashboard runtime dependency**

```powershell
npm install react-zoom-pan-pinch@4.0.4 -w @housingchoice/dashboard
npm ls react-zoom-pan-pinch -w @housingchoice/dashboard
git diff -- dashboard/package.json package-lock.json
```

Expected: `npm ls` reports 4.0.4, only the dashboard dependency manifest and root lockfile change, and no `app/package.json` entry appears.

- [ ] **Step 2: Write failing viewer tests for chrome, transform config, keyboard, and media state**

Test the real component with a controlled module mock whose `TransformWrapper` captures props and exposes `zoomIn`, `zoomOut`, and `resetTransform`. Assert:

```ts
expect(wrapperProps).toMatchObject({
  initialScale: 1,
  minScale: 1,
  maxScale: 8,
  smooth: false,
  disablePadding: true,
  centerOnInit: true,
  centerZoomedOut: true,
  limitToBounds: true,
  wheel: { step: 0.2 },
  pinch: { step: 5, allowPanning: true },
  panning: { allowLeftClickPan: true },
  doubleClick: { disabled: true },
});
```

In `fitImage.test.ts`, prove the package content box matches the fitted bitmap rather than the whole canvas:

```ts
expect(fitImageToCanvas({ width: 4000, height: 2000 }, { width: 1000, height: 600 })).toEqual({
  width: 1000,
  height: 500,
});
expect(fitImageToCanvas({ width: 2000, height: 4000 }, { width: 1000, height: 600 })).toEqual({
  width: 300,
  height: 600,
});
expect(fitImageToCanvas({ width: 2, height: 2 }, { width: 1000, height: 600 })).toEqual({
  width: 600,
  height: 600,
});
```

Mock `ResizeObserver`, load a 2x2 image into a 1000x600 canvas, and assert `TransformComponent.contentStyle` is 600x600 while its wrapper remains 1000x600. Repeat with portrait and landscape natural sizes. This makes the package's measured content element identical to the actual fitted pixels on both letterboxed axes.

Assert the component exposes one `[data-image-viewer-root="true"]` containing one distinct `[data-image-viewer-canvas="true"]`, and that the probe/loading layer is inside that root without being the element that supplies its dimensions. Browser geometry in Task 8 is the enforcement for the CSS flex-fill contract; this component assertion prevents the owned root/canvas seam from disappearing behind package markup.

Also assert the only visible actions are Close and Download; roles/names for Zoom in, Zoom out, Reset, Previous, and Next are absent. Fire unmodified `+`, `=`, `-`, and `0` at the dialog and assert the matching package control is called. Fire Ctrl `+` and Meta `-` and assert no control call and no `preventDefault`. Drive the captured transform callback to scale `2.25`, x `34`, y `-18`, then assert hidden diagnostics report those values and the polite region announces `225%` only after a keyboard command.

The controlled package mock must also prove `smooth={false}` and `disablePadding` are top-level `TransformWrapper` props, not nested inside `wheel` or `pinch`. The pinned 4.0.4 source multiplies a smooth wheel step by `abs(deltaY)` and otherwise permits 0.4 elastic scale padding for touch pinch and Ctrl-wheel trackpad pinch. These two explicit props make `wheel.step: 0.2` a delta-magnitude-independent increment and enforce the approved 1..8 scale as a hard bound during the gesture rather than only after animation settles.

Add the pinned package's no-op boundary: with ref state already `{ scale: 1, positionX: 0, positionY: 0 }`, press `0` twice and have the mock emit no transform callback. After each microtask, assert the polite region announces `100%` and that its keyed child DOM node was replaced, proving assistive technology receives a fresh mutation even when the percentage is unchanged. Then drive a pointer-originated transform to 1.4 and assert it updates diagnostics without replacing the live-region child or changing the announcement to `140%`.

Start with no image event and assert `Loading image...`; fire `load` and assert it clears; fire `error` and assert `This image could not be displayed.` while Close and Download remain usable. Unmount a transformed instance, rerender it with a new token, and assert the wrapper receives scale 1 and centered defaults again.

- [ ] **Step 3: Run the viewer test and verify behavioral failures**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/fitImage.test.ts
```

Expected: exit 1 because the basic shell has no transform, load/error, keyboard, or diagnostics behavior.

- [ ] **Step 4: Implement the transform and keyboard command path**

Export the shared geometry type from `fitImage.ts`:

```ts
export interface Size {
  width: number;
  height: number;
}
```

Implement `fitImageToCanvas` with `scale = Math.min(canvas.width / natural.width, canvas.height / natural.height)` and return natural width/height multiplied by that scale; return zero dimensions when either input dimension is non-positive. `ImageViewer.testUtils.ts` imports `type Size` from this module and imports `fireEvent` and `within` from Testing Library.

In `ImageViewer`, put the viewer content in `<div className={styles.viewer} data-image-viewer-root="true">`. Load the source first through an absolutely positioned, visually hidden probe `<img alt="" aria-hidden="true" data-image-viewer-probe="true">`. Its `onLoad` records `naturalWidth`/`naturalHeight`; its `onError` enters the existing failure state. Observe the outer canvas with `ResizeObserver` and record its `clientWidth`/`clientHeight`. Mount `TransformWrapper` only after both positive sizes produce a fitted box. Key the wrapper by token plus fitted width/height so a canvas resize produces a fresh fitted transform at scale 1.

Use a `ReactZoomPanPinchContentRef`, transform state, and a monotonically increasing pending-keyboard-command id. The transform callback wins when the package emits; a microtask fallback reads the ref's current state when the package correctly emits nothing for a boundary no-op:

```tsx
<div ref={canvasRef} className={styles.canvas} data-image-viewer-canvas="true">
  <TransformWrapper
    key={`${token}:${fitted.width}x${fitted.height}`}
    ref={transformRef}
    initialScale={1}
    minScale={1}
    maxScale={8}
    smooth={false}
    disablePadding
    centerOnInit
    centerZoomedOut
    limitToBounds
    wheel={{ step: 0.2 }}
    pinch={{ step: 5, allowPanning: true }}
    panning={{ allowLeftClickPan: true }}
    doubleClick={{ disabled: true }}
    onTransform={(_ref, next) => updateTransform(next)}
  >
    <TransformComponent
      wrapperStyle={{ width: '100%', height: '100%' }}
      contentStyle={{ width: `${fitted.width}px`, height: `${fitted.height}px` }}
    >
      <img className={styles.image} src={image.src} alt={image.alt} draggable={false} />
    </TransformComponent>
  </TransformWrapper>
</div>
```

In `onDialogKeyDown`, return when Ctrl, Meta, or Alt is held. For `+`/`=` call `zoomIn(0.2, 0)`, for `-` call `zoomOut(0.2, 0)`, and for `0` call `resetTransform(0)`; prevent default only for those handled unmodified keys.

Wrap each package call with this announcement ownership pattern:

```ts
const commandId = ++nextKeyboardCommandId.current;
pendingKeyboardCommand.current = commandId;
runControl();
queueMicrotask(() => {
  if (pendingKeyboardCommand.current !== commandId) return;
  pendingKeyboardCommand.current = null;
  const currentScale = transformRef.current?.state.scale ?? transform.scale;
  publishAnnouncement(`${Math.round(currentScale * 100)}%`);
});
```

Define announcement state as `{ sequence: number; text: string }`. `publishAnnouncement(text)` increments `sequence` even when `text` is unchanged. In `onTransform`, always update diagnostic transform state. Only when a keyboard command is pending, clear it and publish from `next.scale`. A later wheel, pinch, or drag callback therefore never consumes a stale keyboard command.

Render the hidden live region with an atomic keyed child:

```tsx
<output
  aria-live="polite"
  aria-atomic="true"
  className={styles.visuallyHidden}
  data-image-viewer-scale={transform.scale.toFixed(3)}
  data-image-viewer-x={transform.positionX.toFixed(1)}
  data-image-viewer-y={transform.positionY.toFixed(1)}
>
  <span key={announcement.sequence}>{announcement.text}</span>
</output>
```

The sequence is a React key, not visible text. Repeated boundary commands replace the child node and re-announce the same percentage; pointer input changes diagnostics but never changes this child.

Create `ImageViewer.testUtils.ts` for renderer integration tests. It is test-only and exports exactly:

```ts
export function installImageViewerResizeObserver(size: Size): () => void;

export async function loadViewerImage(
  dialog: HTMLElement,
  alt: string,
  natural?: Size,
): Promise<HTMLImageElement>;
```

`installImageViewerResizeObserver` saves the prior global, installs a synchronous `ResizeObserver` mock, defines positive `clientWidth` and `clientHeight` on every observed canvas, invokes its callback with that same `contentRect`, and returns a cleanup function that restores the prior global. Use 1000x600 unless a test needs another size. `loadViewerImage` defaults natural size to 1200x800, finds `[data-image-viewer-probe="true"]` only inside the supplied dialog, defines its `naturalWidth` and `naturalHeight`, fires its `load` event, and returns `within(dialog).findByRole('img', { name: alt })`. Throw a descriptive error if the probe is absent. Integration tests must install the observer before render, restore it in `afterEach` or `finally`, and use this helper instead of a global image query.

- [ ] **Step 5: Finish responsive layout, gesture containment, loading, and failure**

Use a dark neutral canvas and keep the action bar above the transform layer. Complete the definite sizing chain established by Task 1 with these exact component-owned responsibilities:

```css
.viewer {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
}

.canvas {
  position: relative;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
}
```

The canvas also owns `touch-action: none`, `overscroll-behavior: contain`, and hidden overflow. Put the hidden probe, loading indicator, and failure copy inside the positioned canvas as absolutely positioned overlays so none can supply or inflate canvas dimensions. The transformed `.image` owns the exact fitted bitmap box with `display: block`, `width: 100%`, `height: 100%`, `object-fit: contain`, and `user-select: none`; because its box and the package content share the natural aspect ratio, there is no unmeasured object-fit letterbox inside the package bounds. Desktop maintains bounded viewport margins. At `max-width: 599px`, use width `100vw`, height `100dvh`, no border radius, and top/bottom safe-area padding; do not expose a backdrop gap.

Show `Loading image...` with the existing Spinner until `onLoad`. On `onError`, retain the dialog and render exact copy `This image could not be displayed.` with no Retry action. Keep Download as `<a href={image.src} download>` in the current context; do not add `target`.

Include one concise instruction: `Wheel or pinch to zoom; drag to pan. Keyboard: +, -, or 0 to reset.` Associate it with the transform canvas using `aria-describedby`.

- [ ] **Step 6: Run viewer/provider tests, dependency check, and dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/ui/imageViewer/ImageViewer.test.tsx src/ui/imageViewer/fitImage.test.ts src/ui/imageViewer/ImageViewerProvider.test.tsx src/routes/contact/Modal.test.tsx
npm ls react-zoom-pan-pinch -w @housingchoice/dashboard
npm run typecheck -w @housingchoice/dashboard
```

Expected: all three commands exit 0.

- [ ] **Step 7: Commit the gesture-complete viewer and lockfile**

```powershell
git status --short
git add dashboard/package.json package-lock.json dashboard/src/ui/imageViewer/ImageViewer.tsx dashboard/src/ui/imageViewer/ImageViewer.module.css dashboard/src/ui/imageViewer/ImageViewer.test.tsx dashboard/src/ui/imageViewer/ImageViewer.testUtils.ts dashboard/src/ui/imageViewer/fitImage.ts dashboard/src/ui/imageViewer/fitImage.test.ts
git commit -m "feat: add direct-manipulation image inspection" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 5: Route eligible Timeline images through the shared viewer

**Files:**
- Modify: `dashboard/src/routes/contact/Timeline.tsx`
- Modify: `dashboard/src/routes/contact/Timeline.module.css`
- Modify: `dashboard/src/routes/contact/Timeline.mms.test.tsx`
- Modify: `dashboard/src/routes/contact/Timeline.email.test.tsx`
- Modify: `dashboard/src/routes/contact/Timeline.test.tsx`

**Interfaces:**
- Consumes: `useImageViewer().openImage(image, trigger)`, `ViewerImage`, the prerequisite `isInlineRenderable`, `attachmentLabel`, the existing `AttachmentGallery` shared by MessageBubble and EmailCard, and the Task 4 viewer load helpers.
- Produces: semantic Timeline image buttons named `View ${attachmentLabel}`; all non-image links and parent-card click semantics remain unchanged.

- [ ] **Step 1: Add failing MMS and email renderer assertions**

Use an eligible attachment fixture:

```ts
media_attachments: [
  {
    s3Key: 'inbound/MMFRONT1/0',
    contentType: 'image/png',
    filename: 'Front porch.jpg',
  },
],
```

Import `installImageViewerResizeObserver` and `loadViewerImage` from `../../ui/imageViewer/ImageViewer.testUtils`. In each image-bearing test file, install a 1000x600 observer before render and restore the prior global in `afterEach` or `finally`. Wrap only image-bearing Timeline test trees in `MemoryRouter -> ImageViewerProvider`. In both `Timeline.mms.test.tsx` and `Timeline.email.test.tsx`, assert:

```tsx
const trigger = screen.getByRole('button', { name: 'View Front porch.jpg' });
expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
expect(screen.queryByRole('link', { name: 'Front porch.jpg' })).not.toBeInTheDocument();
await user.click(trigger);
const dialog = screen.getByRole('dialog', { name: 'Front porch.jpg' });
const viewerImage = await loadViewerImage(dialog, 'Front porch.jpg');
expect(viewerImage).toHaveAttribute('src', expect.stringContaining('/media/0'));
```

The meaningful image query is deliberately scoped to `dialog`; never use a global `getByRole('img')`, which can match the still-mounted Timeline thumbnail.

Keep an `application/pdf` fixture and assert its anchor still has `target="_blank"`. Add an `image/heic` fixture and assert it remains a file link, proving this feature consumes rather than widens `isInlineRenderable`.

- [ ] **Step 2: Add a failing multi-image and retry-collapse lifecycle test**

Render two PNG attachments named `Front.jpg` and `Kitchen.jpg`. Open Front, call `loadViewerImage` for that dialog, and assert no Previous, Next, or `View Kitchen.jpg` interaction is reachable inside the dialog. Close, then open Kitchen, load its probe independently, and assert its scoped image is the only active viewer image.

For retry collapse, use a dedicated real-BrowserRouter harness rather than the one-entry `MemoryRouter` helper. Seed two observable entries before mount, then render the real Timeline route:

```tsx
window.history.replaceState({ usr: null, key: 'prior', idx: 0 }, '', '/prior');
window.history.pushState({ usr: null, key: 'timeline', idx: 1 }, '', '/timeline');
const view = render(
  <BrowserRouter>
    <ImageViewerProvider>
      <Routes>
        <Route path="/prior" element={<div>PRIOR ROUTE</div>} />
        <Route path="/timeline" element={<Timeline {...timelineProps} items={[failedMms]} />} />
      </Routes>
    </ImageViewerProvider>
  </BrowserRouter>,
);
```

Open the failed MMS carrying `Front porch.jpg`, obtain the dialog, and call `loadViewerImage` before rerendering. Then rerender the same route tree with a delivered `retry_of` row that supersedes the failed source. Assert the source trigger is disconnected but that same dialog and its loaded image remain. Close it and assert no disconnected-trigger focus attempt. Then call `window.history.back()` inside `act`, wait for `PRIOR ROUTE`, and prove the following Back is ordinary route history rather than a no-op hidden behind an extra viewer entry.

- [ ] **Step 3: Run the three Timeline test files and verify anchor/behavior failures**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.test.tsx
```

Expected: exit 1 because eligible images are still `_blank` anchors.

- [ ] **Step 4: Implement a hook-owning image trigger component**

Define a child component so hooks are never called conditionally inside `AttachmentGallery`:

```tsx
function ImageAttachmentButton({ src, label }: { src: string; label: string }): React.JSX.Element {
  const { openImage } = useImageViewer();
  return (
    <button
      type="button"
      className={styles.mediaButton}
      aria-label={`View ${label}`}
      aria-haspopup="dialog"
      onClick={(event) => openImage({ src, alt: label, title: label }, event.currentTarget)}
    >
      <img className={styles.mediaImg} src={src} alt={label} loading="lazy" />
    </button>
  );
}
```

In the existing `isInlineRenderable(att.contentType)` branch, compute `label` once with `attachmentLabel` and return `ImageAttachmentButton`. Preserve the containing gallery's `onClick={(e) => e.stopPropagation()}`. Leave the PDF/declarable/opaque anchor branch and authenticated `messageMediaSrc` unchanged.

Replace `.mediaLink` with `.mediaButton`; reset `padding`, `font`, and default button appearance while retaining the thumbnail size, border, overflow, hover, and focus-ring behavior.

- [ ] **Step 5: Run Timeline/viewer tests and dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/Timeline.mms.test.tsx src/routes/contact/Timeline.email.test.tsx src/routes/contact/Timeline.test.tsx src/ui/imageViewer/ImageViewerProvider.test.tsx
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the shared Timeline renderer integration**

```powershell
git status --short
git add dashboard/src/routes/contact/Timeline.tsx dashboard/src/routes/contact/Timeline.module.css dashboard/src/routes/contact/Timeline.mms.test.tsx dashboard/src/routes/contact/Timeline.email.test.tsx dashboard/src/routes/contact/Timeline.test.tsx
git commit -m "feat: open timeline images in the shared viewer" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 6: Route MediaGallery images through the same viewer

**Files:**
- Modify: `dashboard/src/routes/contact/MediaGallery.tsx`
- Modify: `dashboard/src/routes/contact/MediaGallery.module.css`
- Create: `dashboard/src/routes/contact/MediaGallery.test.tsx`
- Modify: `dashboard/src/routes/contact/UnknownFile.test.tsx`
- Modify: `dashboard/src/routes/contact/files.test.tsx`
- Watch unchanged reader: `dashboard/src/routes/contact/TenantFile.tsx`
- Watch unchanged reader: `dashboard/src/routes/contact/LandlordFile.tsx`
- Watch unchanged reader: `dashboard/src/routes/contact/PartnerFile.tsx`
- Watch unchanged reader: `dashboard/src/routes/contact/UnknownFile.tsx`

**Interfaces:**
- Consumes: `useImageViewer().openImage`, `isInlineRenderable`, `CommsMediaItem.key`, newest-first media order, `MediaGalleryPaging`, and the Task 4 viewer load helpers.
- Produces: exact image trigger name `View image attachment`, exact viewer alt/title `Image attachment`, stable media identity, and unchanged non-image/paging behavior for all four file-pane readers.

- [ ] **Step 1: Add failing shared-gallery tests**

Render under `MemoryRouter -> ImageViewerProvider` with this ordered fixture:

```ts
const media: CommsMediaItem[] = [
  { key: 'new-image', src: '/api/messages/MM2/media/0', contentType: 'image/png', at: '2026-08-27T12:00:00Z' },
  { key: 'old-image', src: '/api/messages/MM1/media/0', contentType: 'image/jpeg', at: '2026-08-26T12:00:00Z' },
  { key: 'document', src: '/api/messages/MM0/media/0', contentType: 'application/pdf', at: '2026-08-25T12:00:00Z' },
];
```

Import the test-only viewer helpers, install a 1000x600 observer before render, and restore it after each test. Assert the first two items are buttons named `View image attachment` in original order, the PDF remains a `_blank` link, and `Load older media` still calls `paging.onLoadMore` and disables while `loadingMore`. Open the first button, obtain the labelled dialog, call `loadViewerImage(dialog, 'Image attachment')`, and assert that scoped image uses the new-image URL; assert no next/previous action exists and the second button cannot be selected until Close returns to the gallery. Then open the second, load its separate probe, and assert the scoped dialog image uses the old-image URL.

Add a declarable `image/heic` item and assert it stays a file link.

- [ ] **Step 2: Add a failing UnknownFile host assertion**

Extend the existing UnknownFile test with `media` containing one PNG. Render the real file component with the provider and observer helper, assert its `Media from comms` section exposes `View image attachment`, open the shared labelled dialog, and call `loadViewerImage` before checking the scoped visible image. This is the representative file-pane host proof; TenantFile, LandlordFile, and PartnerFile are static readers of the same prop-only `MediaGallery` and are checked by the inventory command in Step 5.

Also update the existing image-bearing TenantFile harness in `files.test.tsx`: put `ImageViewerProvider` inside its `MemoryRouter`, rename `renders a media-from-comms thumbnail linking to the authed media URL` to `opens a media-from-comms thumbnail in the shared viewer`, and replace the stale link-oriented assertion with:

```tsx
const trigger = screen.getByRole('button', { name: 'View image attachment' });
expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
await user.click(trigger);
const dialog = screen.getByRole('dialog', { name: 'Image attachment' });
const viewerImage = await loadViewerImage(dialog, 'Image attachment');
expect(viewerImage).toHaveAttribute(
  'src',
  '/api/messages/MM1/media/0',
);
```

Install the observer before this TenantFile render and restore it after the test. The scoped helper is required here because the MediaGallery thumbnail has the same accessible image name as the visible viewer image.

- [ ] **Step 3: Run shared-gallery and UnknownFile tests to verify failures**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/MediaGallery.test.tsx src/routes/contact/UnknownFile.test.tsx src/routes/contact/files.test.tsx
```

Expected: exit 1 because image tiles are anchors and the hook integration is absent.

- [ ] **Step 4: Convert only the eligible image branch to a semantic button**

Add a child component that owns the hook:

```tsx
function MediaImageButton({ item }: { item: CommsMediaItem }): React.JSX.Element {
  const { openImage } = useImageViewer();
  return (
    <button
      type="button"
      className={styles.tile}
      aria-label="View image attachment"
      aria-haspopup="dialog"
      onClick={(event) =>
        openImage(
          { src: item.src, alt: 'Image attachment', title: 'Image attachment' },
          event.currentTarget,
        )
      }
    >
      <img className={styles.img} src={item.src} alt="Image attachment" loading="lazy" />
    </button>
  );
}
```

Return this component only from `isInlineRenderable(m.contentType)`. Keep `key={m.key}` at the mapped component boundary. Leave non-image anchors, title, glyph, and paging markup unchanged. Reset button `padding`, `font`, and `color` in `.tile` without changing grid sizing or focus appearance.

- [ ] **Step 5: Verify every file-pane reader still uses the shared component**

```powershell
rg -n "<MediaGallery" dashboard/src/routes/contact/TenantFile.tsx dashboard/src/routes/contact/LandlordFile.tsx dashboard/src/routes/contact/PartnerFile.tsx dashboard/src/routes/contact/UnknownFile.tsx
```

Expected: exactly one call site in each of the four named files and no local image-link branch added to any reader.

- [ ] **Step 6: Run gallery tests, media classification tests, and dashboard typecheck**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/MediaGallery.test.tsx src/routes/contact/UnknownFile.test.tsx src/routes/contact/files.test.tsx src/routes/contact/media.test.ts
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0. `media.test.ts` remains the shared renderability authority from the prerequisite branch.

- [ ] **Step 7: Commit the file-gallery integration**

```powershell
git status --short
git add dashboard/src/routes/contact/MediaGallery.tsx dashboard/src/routes/contact/MediaGallery.module.css dashboard/src/routes/contact/MediaGallery.test.tsx dashboard/src/routes/contact/UnknownFile.test.tsx dashboard/src/routes/contact/files.test.tsx
git commit -m "feat: open file gallery images in the shared viewer" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 7: Prove every current Timeline host reaches the app-level provider

**Files:**
- Modify: `dashboard/src/routes/contact/ContactDetail.test.tsx`
- Modify: `dashboard/src/routes/contact/ContactCommsPane.test.tsx`
- Modify: `dashboard/src/routes/conversation/ConversationDetail.test.tsx`
- Modify: `dashboard/src/routes/conversation/GroupTextView.test.tsx`
- Modify: `dashboard/src/routes/tours/TourConversation.test.tsx`
- Modify: `dashboard/src/routes/placements/PlacementConversation.test.tsx`

**Interfaces:**
- Consumes: the unchanged production host components, shared Timeline integration, and `ImageViewerProvider` inside each test's MemoryRouter.
- Produces: named regression proof for ContactDetail, its extracted ContactCommsPane, relay conversation, native group-text, tour-conversation, and placement-conversation readers; no host-specific viewer state or component is introduced.

- [ ] **Step 1: Wrap each host test helper at the same boundary production uses**

For ContactDetail, preserve its existing exact routes and insert only the provider:

```tsx
<MemoryRouter initialEntries={[`/contacts/${contactId}`]}>
  <ImageViewerProvider>
    <Routes>
      <Route path="/contacts/:contactId" element={<ContactDetail />} />
      <Route path="/inbox" element={<div>INBOX</div>} />
    </Routes>
  </ImageViewerProvider>
</MemoryRouter>
```

For ContactCommsPane, put the provider around the existing pane harness:

```tsx
<MemoryRouter>
  <ImageViewerProvider>
    <PaneHarness {...props} />
  </ImageViewerProvider>
</MemoryRouter>
```

For ConversationDetail and GroupTextView, preserve their existing exact routes and insert only the provider:

```tsx
<MemoryRouter initialEntries={[`/conversations/${conversationId}`]}>
  <ImageViewerProvider>
    <Routes>
      <Route path="/conversations/:conversationId" element={<ConversationDetail />} />
      <Route path="/contacts/:contactId" element={<div>CONTACT PAGE</div>} />
      <Route path="/inbox" element={<div>INBOX</div>} />
    </Routes>
  </ImageViewerProvider>
</MemoryRouter>
```

For direct TourConversation and PlacementConversation renders, use:

```tsx
<MemoryRouter>
  <ImageViewerProvider>
    <TourConversation {...props} />
  </ImageViewerProvider>
</MemoryRouter>
```

and:

```tsx
<MemoryRouter>
  <ImageViewerProvider>
    <PlacementConversation {...props} />
  </ImageViewerProvider>
</MemoryRouter>
```

Do not add fallback no-provider behavior to `useImageViewer` merely to satisfy tests.

- [ ] **Step 2: Add one eligible-image assertion to each current reader**

Use this exact attachment and Timeline item for ContactDetail, ContactCommsPane, TourConversation, and PlacementConversation. The servable SID comes from the suffix of `tsMsgId`:

```ts
const mediaAttachments = [
  { s3Key: 'inbound/MMHOST1/0', contentType: 'image/png', filename: 'Host proof.png' },
];

const timelineMessage: TimelineItem = {
  kind: 'message',
  id: 'host-image-message',
  at: '2026-08-27T12:00:00.000Z',
  conversationId: 'conv-host',
  tsMsgId: '2026-08-27T12:00:00.000Z#MMHOST1',
  direction: 'inbound',
  author: 'tenant',
  type: 'mms',
  body: 'Host image',
  delivery_status: 'delivered',
  media_attachments: mediaAttachments,
};
```

For ConversationDetail and GroupTextView, use a valid wire `Message` factory with both required identifiers:

```ts
function wireImageMessage(conversationId: string): Message {
  return {
    conversationId,
    tsMsgId: '2026-08-27T12:00:00.000Z#MMHOST1',
    provider_sid: 'MMHOST1',
    provider_ts: '2026-08-27T12:00:00.000Z',
    direction: 'inbound',
    author: 'tenant',
    type: 'mms',
    body: 'Host image',
    delivery_status: 'delivered',
    media_attachments: mediaAttachments,
  };
}
```

Do not invent a camel-case `providerSid` property; `messageSid` reads `tsMsgId` and the wire type names its separate field `provider_sid`.

Arrange the correct data seam in each file:

- ContactDetail: `getContactTimeline.mockResolvedValue({ items: [timelineMessage], nextCursor: null })` with the existing tenant contact fixture.
- ContactCommsPane: `getContactTimeline.mockResolvedValue(timelinePage([timelineMessage]))`.
- ConversationDetail relay: `getConversationMessages.mockResolvedValue([wireImageMessage('conv-g1')])` with `relayHeader()`.
- GroupTextView native group: `getConversationMessages.mockResolvedValue([wireImageMessage('gt-1')])` with `groupHeader()`.
- TourConversation: select the tenant person tab and return `{ items: [timelineMessage], nextCursor: null }` from `getContactTimeline`.
- PlacementConversation: select the tenant person tab and return `{ items: [timelineMessage], nextCursor: null }` from `getContactTimeline`.

In every case:

```tsx
const trigger = await screen.findByRole('button', { name: 'View Host proof.png' });
await user.click(trigger);
expect(screen.getByRole('dialog', { name: 'Host proof.png' })).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: 'Close' }));
expect(trigger).toHaveFocus();
```

Assert the surrounding selected tab and route label are unchanged after close. These tests name all current readers and reject a future host-local viewer fork.

- [ ] **Step 3: Run the six focused host files**

```powershell
npm test -w @housingchoice/dashboard -- src/routes/contact/ContactDetail.test.tsx src/routes/contact/ContactCommsPane.test.tsx src/routes/conversation/ConversationDetail.test.tsx src/routes/conversation/GroupTextView.test.tsx src/routes/tours/TourConversation.test.tsx src/routes/placements/PlacementConversation.test.tsx
```

Expected: exit 0 after the wrappers and host cases are correct. Any failure in unrelated existing cases must be diagnosed before broadening changes.

- [ ] **Step 4: Run the complete dashboard workspace test and typecheck**

```powershell
npm test -w @housingchoice/dashboard
npm run typecheck -w @housingchoice/dashboard
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the reader-surface regression coverage**

```powershell
git status --short
git add dashboard/src/routes/contact/ContactDetail.test.tsx dashboard/src/routes/contact/ContactCommsPane.test.tsx dashboard/src/routes/conversation/ConversationDetail.test.tsx dashboard/src/routes/conversation/GroupTextView.test.tsx dashboard/src/routes/tours/TourConversation.test.tsx dashboard/src/routes/placements/PlacementConversation.test.tsx
git commit -m "test: cover image viewer across timeline hosts" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 8: Extend hermetic Playwright coverage for desktop, mobile, and shared hosts

**Files:**
- Modify: `e2e/tests/dashboard-next/outbound-mms.spec.ts`

**Interfaces:**
- Consumes: the existing `FIXTURE_PNG`, authenticated media send, `expectNoHorizontalOverflow`, contact page, relay group page, Chromium CDP, and `data-image-viewer-*` transform diagnostics.
- Produces: real-browser proof of same-tab opening, wheel/pinch/pan, Back, focus/scroll restoration, responsive geometry, transform reset, MediaGallery parity, and relay-host parity.

Add this local diagnostic reader near the existing MMS helpers:

```ts
async function readViewerScale(page: Page): Promise<number> {
  const raw = await page.locator('[data-image-viewer-scale]').getAttribute(
    'data-image-viewer-scale',
  );
  const scale = Number(raw);
  if (raw === null || !Number.isFinite(scale)) throw new Error(`invalid viewer scale: ${raw}`);
  return scale;
}
```

Also add a browser-side mutation recorder so hard-bound checks inspect transient values rather than only the settled scale:

```ts
async function startViewerScaleRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ownedWindow = window as typeof window & {
      __hcViewerScaleObserver?: MutationObserver;
      __hcViewerScaleSamples?: number[];
    };
    ownedWindow.__hcViewerScaleObserver?.disconnect();
    const output = document.querySelector<HTMLElement>('[data-image-viewer-scale]');
    if (output === null) throw new Error('viewer scale diagnostic not found');
    const record = (): void => {
      const value = Number(output.dataset.imageViewerScale);
      if (!Number.isFinite(value)) throw new Error('invalid viewer scale diagnostic');
      ownedWindow.__hcViewerScaleSamples?.push(value);
    };
    ownedWindow.__hcViewerScaleSamples = [];
    record();
    ownedWindow.__hcViewerScaleObserver = new MutationObserver(record);
    ownedWindow.__hcViewerScaleObserver.observe(output, {
      attributes: true,
      attributeFilter: ['data-image-viewer-scale'],
    });
  });
}

async function readViewerScaleSamples(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const ownedWindow = window as typeof window & { __hcViewerScaleSamples?: number[] };
    return [...(ownedWindow.__hcViewerScaleSamples ?? [])];
  });
}
```

Start a fresh recorder for each discrete-wheel, Ctrl-wheel, and touch-pinch phase. After the phase, require a nonempty sample list and assert every recorded value is between 1 and 8 inclusive. This is intentionally stronger than waiting for package alignment and reading one final value.

- [ ] **Step 1: Prepare the 1:1 desktop viewer proof without opening it yet**

Set 1280x900 before login. Register a context page counter, locate the Timeline trigger, record the URL, and leave the viewer closed while Step 2 arranges the exact scroll state the provider must capture:

```ts
await page.setViewportSize({ width: 1280, height: 900 });
let openedPages = 0;
page.context().on('page', () => {
  openedPages += 1;
});
const trigger = timeline.getByRole('button', { name: 'View Attachment 1' }).last();
const beforeUrl = page.url();
await trigger.scrollIntoViewIfNeeded();
await expect(page.getByRole('dialog')).toHaveCount(0);
```

- [ ] **Step 2: Prove desktop wheel levels, bounds, scroll restoration, Escape, and focus**

Before opening, explicitly identify the AppFrame `<main>` and the Timeline's nested overflow ancestor. Deliberately make both scrollable in the hermetic page, keep the trigger visible, set named nonzero positions, and return the exact values before the click:

```ts
const expectedScroll = await trigger.evaluate((element) => {
  const appFrame = element.closest('main');
  if (!(appFrame instanceof HTMLElement)) throw new Error('AppFrame main not found');
  const routeRoot = appFrame.firstElementChild;
  if (!(routeRoot instanceof HTMLElement)) throw new Error('AppFrame route root not found');
  routeRoot.style.minHeight = `${appFrame.clientHeight + 500}px`;

  let timelineStream: HTMLElement | null = element.parentElement;
  while (timelineStream !== null && timelineStream !== appFrame) {
    if (/auto|scroll|overlay/.test(getComputedStyle(timelineStream).overflowY)) break;
    timelineStream = timelineStream.parentElement;
  }
  if (timelineStream === null || timelineStream === appFrame) {
    throw new Error('Timeline stream not found');
  }
  if (timelineStream.scrollHeight <= timelineStream.clientHeight) {
    timelineStream.style.maxHeight = '180px';
  }
  if (timelineStream.scrollHeight <= timelineStream.clientHeight) {
    throw new Error('Timeline stream could not be made scrollable');
  }

  appFrame.dataset.viewerTestAppframe = 'true';
  timelineStream.dataset.viewerTestTimeline = 'true';
  element.scrollIntoView({ block: 'center' });
  appFrame.scrollTop = Math.min(20, appFrame.scrollHeight - appFrame.clientHeight);
  timelineStream.scrollTop = Math.min(
    Math.max(10, timelineStream.scrollTop),
    timelineStream.scrollHeight - timelineStream.clientHeight,
  );
  if (appFrame.scrollTop === 0 || timelineStream.scrollTop === 0) {
    throw new Error('named scroll owners were not arranged away from zero');
  }
  const box = element.getBoundingClientRect();
  if (box.bottom <= 0 || box.top >= innerHeight) throw new Error('trigger is not visible');
  return {
    appFrame: { top: appFrame.scrollTop, left: appFrame.scrollLeft },
    timeline: { top: timelineStream.scrollTop, left: timelineStream.scrollLeft },
  };
});

await trigger.click();
expect(openedPages).toBe(0);
const dialog = page.getByRole('dialog', { name: 'Attachment 1' });
await expect(dialog).toBeVisible();
await expect(page.locator('[data-modal-variant="media"]')).toHaveCSS('z-index', '200');
expect(page.url()).toBe(beforeUrl);
```

Assert Close and Download are visible and `getByRole('button', { name: /Zoom|Reset|Previous|Next/i })` has count 0. Measure the dialog, the `[data-image-viewer-canvas]`, the heading, Download, and Close. At 1280x900 require dialog width and height each to be at least 75% of the viewport; require canvas width to be at least `dialog.width - 4`, canvas height to be at least 60% of the viewport, canvas top to be no higher than one pixel above the lowest header/action bottom, and canvas bottom to remain within one pixel of the dialog bottom. These thresholds prove the modal/body/viewer flex chain leaves a genuinely large inspection surface rather than a positive but postage-stamp canvas.

At scale 1, compare the image and canvas boxes: the image box is fully contained, their centers differ by no more than one CSS pixel, and the image has computed `object-fit: contain`. This explicitly proves the 2x2 fixture is assigned a fitted canvas box instead of remaining a corner-sized intrinsic image.

Move the mouse to an off-center point inside `[data-image-viewer-canvas]`, start the transient recorder, and apply three separate `page.mouse.wheel(0, -80)` events. With `smooth={false}`, each event uses the configured 0.2 increment regardless of the browser's delta magnitude. After each event, poll `readViewerScale(page)` above the prior value and store it before sending the next. Assert all three values are distinct and strictly increasing, the first is greater than 1, and the third is less than 8. Assert x or y changed from zero so wheel zoom remained pointer-anchored. Then send further discrete wheel events until the reported scale reaches 8, send one additional zoom-in event at the cap, and assert every transient recorder sample remained in 1..8.

At high zoom, drag to each extreme with large mouse movements (left, right, up, and down). After every boundary, compare the real transformed `<img>` box with the canvas box and assert positive overlap on both axes. Because Task 4 makes that element box equal the fitted bitmap rather than a letterboxed canvas box, this proves package bounds cannot lose all image pixels.

Read each owner's current position while open to prove background state did not move. Press Escape, then assert:

```ts
await expect(page.getByRole('dialog')).toHaveCount(0);
await expect(trigger).toBeFocused();
expect(page.url()).toBe(beforeUrl);
```

Read `[data-viewer-test-appframe]` and `[data-viewer-test-timeline]` independently and compare each exact top/left pair with `expectedScroll.appFrame` and `expectedScroll.timeline`. Reopen and assert `data-image-viewer-scale="1.000"`.

Start a fresh transient recorder and exercise the trackpad-pinch wheel path by dispatching cancelable wheel events at the canvas with `ctrlKey: true`, pointer coordinates at its center, and small `deltaY` magnitudes. First dispatch a zoom-out event at scale 1 and require the scale to remain 1. Then dispatch three separate `deltaY: -1` events, polling after each; require three strictly increasing intermediate scales below 8. Continue Ctrl-wheel zoom-in through the hard maximum and one extra event, then reverse through the hard minimum and one extra event. Require all recorder samples to remain within 1..8 and the final scale to equal 1. Close, reopen, and assert scale 1 again. This covers trackpad-style small deltas separately from the discrete `deltaY: -80` mouse-wheel path and proves `disablePadding` applies to Ctrl-wheel throughout the gesture.

- [ ] **Step 3: Prove MediaGallery parity on the same authenticated image**

Close the Timeline viewer, locate the `Media from comms` card, click its newest `View image attachment` button, and assert the same dialog shell, canvas attribute, Close, and Download appear with image alt `Image attachment`. Close before interacting with any other thumbnail.

- [ ] **Step 4: Add a mobile 360x800 viewer sequence using real Back and CDP pinch**

Use a separate 1:1 test that sends `FIXTURE_PNG`, then:

```ts
await page.setViewportSize({ width: 360, height: 800 });
const session = await page.context().newCDPSession(page);
const mobileTimeline = page.getByRole('region', { name: 'Communications and activity' });
const trigger = mobileTimeline.getByRole('button', { name: 'View Attachment 1' }).last();
await expect(trigger).toBeVisible({ timeout: 20_000 });
await trigger.click();
const dialog = page.getByRole('dialog');
await expect(dialog).toBeVisible();
await expect(dialog).toHaveAccessibleName('Attachment 1');
```

Replace the heading text in-browser with `${'a'.repeat(2048)}.png` to exercise a valid hostile-length unbroken filename while retaining the full accessible title:

```ts
const longFilename = `${'a'.repeat(2048)}.png`;
await dialog.getByRole('heading').evaluate((heading, value) => {
  heading.textContent = value;
}, longFilename);
await expect(dialog).toHaveAccessibleName(longFilename);
```

Compare the dialog bounding box to the 360x800 visual viewport within one CSS pixel, call `expectNoHorizontalOverflow(page, 'image viewer at 360px')`, and verify the Close and Download bounding boxes each remain wholly inside both the dialog and the viewport after the long-title mutation. Measure the canvas after that mutation: require its width to match the dialog within two CSS pixels, its height to exceed half the viewport, its top to be at least `Math.max(closeBox.bottom, downloadBox.bottom) - 1`, and its bottom to remain inside the dialog. This is the mobile enforcement for the same definite flex-fill chain and proves hostile title length cannot collapse the inspection surface.

Start a fresh transient recorder. Before zooming in, synthesize a `scaleFactor: 0.5` pinch at fit and assert the current scale remains 1 with no recorded value below 1. Then read the canvas center and dispatch two separate intermediate pinches, sampling scale after each:

```ts
await session.send('Input.synthesizePinchGesture', {
  x: Math.round(centerX),
  y: Math.round(centerY),
  scaleFactor: 1.25,
  relativeSpeed: 800,
  gestureSourceType: 'touch',
});
const firstPinchScale = await readViewerScale(page);
await session.send('Input.synthesizePinchGesture', {
  x: Math.round(centerX),
  y: Math.round(centerY),
  scaleFactor: 1.25,
  relativeSpeed: 800,
  gestureSourceType: 'touch',
});
const secondPinchScale = await readViewerScale(page);
expect(firstPinchScale).toBeGreaterThan(1);
expect(secondPinchScale).toBeGreaterThan(firstPinchScale);
expect(secondPinchScale).toBeLessThan(8);
```

Apply additional large pinches until the scale reaches 8, then one more zoom-in pinch at the cap. Require every value captured by the mutation recorder across the below-minimum attempt, intermediate pinches, and cap attempts to remain within 1..8. Dispatch a touch drag with CDP touch events and assert x or y transform position changes while scale stays within 1..8. Drive large drags toward all four pan boundaries and after each assert the fitted image element still overlaps the canvas on both axes. Call `page.goBack()`, then assert the viewer is gone, the URL remains the same contact route, the Comms pane remains selected, and the trigger is visible/focused. Reopen and assert scale 1, then use visible Close.

Use this concrete one-finger drag after the pinch:

```ts
await session.send('Input.dispatchTouchEvent', {
  type: 'touchStart',
  touchPoints: [{ x: centerX, y: centerY, id: 1, radiusX: 5, radiusY: 5 }],
});
await session.send('Input.dispatchTouchEvent', {
  type: 'touchMove',
  touchPoints: [{ x: centerX + 60, y: centerY + 35, id: 1, radiusX: 5, radiusY: 5 }],
});
await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
```

After the drag, assert the transformed image's bounding box still intersects the canvas on both axes, proving the bounded pan cannot lose it completely off canvas.

- [ ] **Step 5: Extend the relay group send test with shared-host viewer proof**

In existing relay test `(b)`, after the sent token is visible, locate its message card's `View Attachment 1` trigger, open it, assert the same labelled dialog and canvas, then Close and assert `INBOX_LABEL` plus the selected Conversation tab remain unchanged.

- [ ] **Step 6: Run only the changed Playwright spec through the e2e workspace**

```powershell
npm run e2e -w @housingchoice/e2e -- --grep "Outbound MMS"
```

Expected: exit 0 with the 1:1, mobile, and relay viewer assertions green. The explicit workspace qualifier is required because root `npm run e2e -- --grep` swallows the nested argument. Do not invoke root/stray Playwright and do not target ports 5174/8080.

- [ ] **Step 7: Commit the browser coverage**

```powershell
git status --short
git add e2e/tests/dashboard-next/outbound-mms.spec.ts
git commit -m "test: verify image viewer on desktop and mobile" -m "Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>"
```

### Task 9: Perform live self-QA and the full feature-mission gates

**Files:**
- Create ignored artifacts: `.playwright-mcp/mms-image-viewer-desktop.png`
- Create ignored artifacts: `.playwright-mcp/mms-image-viewer-mobile.png`
- Create/update ignored mission records: `.superpowers/sdd/progress.md`, `.superpowers/sdd/handback.md`

**Interfaces:**
- Consumes: the finished branch, hermetic `e2e:session` lane, repository completion gates, and the prerequisite-synced `main` SHA from preflight.
- Produces: live interaction evidence, exact bare-gate exits, current-main drift report, and a clean merge-ready branch handback. No deployment or merge is performed.

- [ ] **Step 1: Verify the worktree is quiet and record current main drift**

```powershell
git status --short
git log --oneline --decorate -10
git rev-parse main
```

Expected: the worktree is clean. Compare `main` with the preflight recorded SHA. If they match, the prerequisite sync is still current and satisfies the required final-sync condition. If `main` advanced, write `STATUS: QUESTION` to the mission ledger and stop before live QA, gates, or a merge-ready claim. Ask the human whether to authorize a second sync despite the repository's normal one-sync discipline. If authorized, merge current `main`, resolve intent-preservingly, record the new SHA, rerun every affected focused check, and only then continue this task. If not authorized, hand back explicitly non-merge-ready.

- [ ] **Step 2: Run hermetic live self-QA at desktop size**

Start the sanctioned interactive stack:

```powershell
npm run e2e:session
```

Authenticate with `/auth/dev-login` through the browser flow, create or use a hermetic image message, and inspect at 1280x900. Exercise multiple levels with both discrete mouse-wheel deltas and trackpad-style small Ctrl-wheel deltas; drive each path against its minimum and maximum while observing that scale never leaves 1..8. Also exercise bounded high-zoom pan, backdrop close, Escape, Download without a popup, exact focus/scroll restoration, the file-gallery path, loading, and no failed media requests or page errors. Save `.playwright-mcp/mms-image-viewer-desktop.png`.

- [ ] **Step 3: Run hermetic live self-QA at mobile size and stop the session**

At 360x800, exercise pinch attempts below fit and above the cap while watching transient scale remain in 1..8, intermediate pinch levels, two-finger repositioning, pan bounds, browser Back, Close, transform reset after reopen, safe-area action reachability, and no underlying/horizontal/bottom overflow. Save `.playwright-mcp/mms-image-viewer-mobile.png`, then stop only this worktree's lane:

```powershell
npm run e2e:stop
```

Expected: the session stops cleanly and no listener from this lane survives.

- [ ] **Step 4: Run the five required bare gates from a quiet tree**

Run each command separately and record its real exit code:

```powershell
npm run typecheck
```

```powershell
npm test
```

```powershell
npm run smoke
```

```powershell
npm run e2e
```

```powershell
npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')
```

Expected: every gate exits 0. Never pipe a gate. If `npm test` first fails in DynamoDB Local suites with timeout/SQLite-lock symptoms and zero assertion failures, rerun the app suite under a clean access key exactly as AGENTS.md specifies before attributing the failure. If Gate 5 reports errors, compare the same paths at the merge base and block only new errors under the touched-lines ratchet.

- [ ] **Step 5: Verify branch scope and dependency integrity**

```powershell
npm run bootstrap:check
npm ls react-zoom-pan-pinch -w @housingchoice/dashboard
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Expected: all checks exit 0, the dependency resolves to 4.0.4 only in the dashboard workspace, diff check is clean, scope matches this plan, and the worktree is clean.

- [ ] **Step 6: Write the build handback without merging**

Record task commits, exact gate commands/exits/counts, focused test outcomes, live-QA observations and screenshot paths, current `main` drift, dependency version, any reviewer findings/fixes, and `UNMERGED (human gate)` in `.superpowers/sdd/handback.md`. Report no post-merge obligation beyond the normal dependency install. Do not commit ignored `.superpowers` or `.playwright-mcp` artifacts.

## Spec coverage map

| Spec surface | Plan owner |
|---|---|
| Shared app owner, one active descriptor, body portal, layer 200 | Tasks 1 and 3 |
| Same-URL Router marker, preserved user state, Back/Forward/reload, single dismissal | Tasks 2 and 3 |
| Nested AppFrame/Timeline scroll, inert siblings, exact focus restoration | Tasks 2, 3, and 8 |
| Scale 1..8, wheel, pinch, pan, hidden keyboard alternative, reset-on-reopen | Task 4 and Task 8 |
| Close/Download only, loading/error, responsive desktop/mobile shell | Tasks 1, 4, and 8 |
| Timeline MMS and email renderer, retry collapse, multi-image close-first | Task 5 |
| MediaGallery and tenant/landlord/partner/unknown file readers | Task 6 |
| Contact, relay, native group, tour, and placement Timeline readers | Task 7 |
| Real authenticated media, desktop, mobile Back, CDP pinch, relay host | Task 8 |
| Live self-QA, full gates, dependency and human-merge boundary | Task 9 |

No task adds carousel state, visible zoom controls, routes, persistent storage, new media eligibility, server/media mutations, or deployment behavior.
