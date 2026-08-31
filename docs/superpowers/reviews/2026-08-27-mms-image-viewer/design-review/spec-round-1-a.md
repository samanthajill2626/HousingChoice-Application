# MMS image viewer design review - round 1A

## 1. [BLOCKING] The proposed raw history marker can corrupt the active React Router entry

### What is wrong

Section 6 requires the viewer to `pushState` an app-owned marker, but it never
defines the state shape or how that marker preserves React Router's state. This
dashboard is mounted under `BrowserRouter`, so `history.state` is router-owned
as well as browser-owned. A marker such as `{ imageViewer: instanceId }` replaces
the router's key/index/user state on the new entry. The proposed mechanism then
uses `history.back()` and `popstate` to cross that malformed entry.

This is not an implementation detail that can be deferred to the plan: the
protected history invariant in section 6 depends on it. The current code already
documents the exact hazard: `QuickReply` says raw `history.replaceState` discards
the router's own history-entry state and uses router navigation instead
(`dashboard/src/routes/quickReply/QuickReply.tsx:175-177`). The dashboard root
actually uses `BrowserRouter` (`dashboard/src/main.tsx:1-18`).

### Evidence

- Spec section 6.1 requires `pushState` with an app-owned marker; sections 6.2-
  6.3 require raw Back/popstate handling. It specifies neither composition with
  the existing router state nor a router-supported equivalent.
- `dashboard/src/main.tsx:5-18` mounts the application with `BrowserRouter`.
- `dashboard/src/routes/quickReply/QuickReply.tsx:175-177` explicitly warns that
  raw history state replacement discards router entry state.

### What it implies

The spec must define and test a BrowserRouter-compatible protocol: the exact
marker representation, preservation of the router state on the pushed entry,
how the marker is recognized after Forward, and what happens when a router
navigation occurs while it is current. The history tests must run through the
real browser-history router, not only `MemoryRouter`. Until that protocol exists,
the promised one-entry Back behavior cannot be safely built.

## 2. [BLOCKING] A specified selected-image mutator has no history cleanup behavior

### What is wrong

Section 10 lists `renderer unmount` as a mutator of selected-image state, while
section 4.1 says the calling gallery owns that selection and the viewer owns the
history lifecycle. But sections 6.1-6.4 define no outcome for an open viewer
whose owning renderer disappears. It is a reachable normal update, not just a
route unload: Timeline removes a message when a retry supersedes it.

If selection is held in the specified calling `AttachmentGallery`, an open
viewer can unmount with its marker still in history. Nothing in the spec says
whether cleanup backs out the entry, replaces it, or leaves it; each choice has
different popstate and focus consequences. A subsequent Back can therefore
encounter a stale marker, and a later viewer can no longer prove it owns the
current entry.

### Evidence

- Spec section 4.1 assigns selection to the calling gallery and history to
  `ImageViewer`; section 10A lists `renderer unmount` as a selection mutator.
  Section 6 covers explicit dismissal, platform Back, reload, and Forward, but
  not renderer disappearance.
- `AttachmentGallery` is rendered inside each message/card
  (`dashboard/src/routes/contact/Timeline.tsx:625-673`, `:957`, `:1384`).
- Timeline's visible item set intentionally removes any message whose `tsMsgId`
  is later named by a retry (`dashboard/src/routes/contact/Timeline.tsx:1660-1678`),
  and the stream keys/remounts its items from that set
  (`dashboard/src/routes/contact/Timeline.tsx:2034-2049`).

### What it implies

The design must choose a stable owner above volatile message/card renderers, or
define an idempotent unmount protocol that reconciles the exact owned entry
without accidentally navigating a newly current route. It also needs a test
that opens a viewer, removes its source message through retry collapse, and then
proves history, focus, and the next Back operation are correct. Without this,
the spec's stated one-disposable-entry invariant is false on a declared mutation
surface.

## 3. [HIGH] The renderer inventory omits four current Timeline surfaces

### What is wrong

The spec describes `AttachmentGallery` as applying to MMS bubbles and email
cards, then limits its renderer tests to those two paths. That is not the
complete current surface. The shared `Timeline` (and therefore its
`AttachmentGallery`) also renders on the relay conversation, native group-text,
placement conversation, and tour conversation screens. The proposed change
therefore changes image opening, focus restoration, portal stacking, and history
behavior on all of those routes without a stated product decision or coverage.

### Evidence

- Spec sections 1 and 4.2 name only MMS bubbles and email cards, and section
  11.1 asks only for MMS/email renderer coverage.
- `AttachmentGallery` is part of the shared Timeline's `MessageBubble` and
  `EmailCard` render paths (`dashboard/src/routes/contact/Timeline.tsx:625-673`,
  `:957`, `:1384`).
- `Timeline` is also mounted by the relay conversation
  (`dashboard/src/routes/conversation/ConversationDetail.tsx:32`, `:480`),
  native group-text view (`dashboard/src/routes/conversation/GroupTextView.tsx:21`,
  `:448`), placement conversation (`dashboard/src/routes/placements/PlacementConversation.tsx:55`,
  `:320`), and tour conversation (`dashboard/src/routes/tours/TourConversation.tsx:44`,
  `:467`).

### What it implies

The spec must explicitly include these four consumers or explicitly exclude them
and split the renderer. If included, it needs at least route-level coverage for
their differing host layouts and existing dialogs. Otherwise a supposedly
shared viewer ships into unreviewed conversation surfaces, defeating the
spec's own state-surface inventory.

## 4. [HIGH] The scroll-preservation guarantee ignores the actual scroll owners

### What is wrong

Sections 4.1 and 7 say the viewer owns scroll containment, locks background
scroll, and restores the underlying conversation/file-pane position. They do
not identify the elements to lock or snapshot. This app does not use the document
as the relevant scroll container: `AppFrame` deliberately clamps the viewport
and scrolls its `.content` element, while every Timeline has its own scrollable
stream. Locking `body`/`documentElement`, the usual modal implementation, does
not lock either of those surfaces and cannot deliver the stated guarantee.

### Evidence

- Spec sections 4.1 and 7 guarantee background-scroll lock and saved-position
  restoration but name no existing scroll container; section 11 tests only an
  end-state scroll position, not the distinct active containers.
- The application shell is height-clamped (`dashboard/src/app/AppFrame.module.css:3-8`)
  and its `.content` is the page scroll container
  (`dashboard/src/app/AppFrame.module.css:383-387`).
- Timeline creates an additional `overflow: auto` stream
  (`dashboard/src/routes/contact/Timeline.module.css:112-143`) and directly
  maintains its `scrollTop` (`dashboard/src/routes/contact/Timeline.tsx:1794-1862`).

### What it implies

The design must name the lock and restoration owner(s), including nested
Timeline streams and the file-pane shell, and say how wheel/touch/key scrolling
is prevented without resetting those positions. Add a test with each relevant
scroll container set away from zero before opening, then verify it neither moves
while open nor changes after every dismissal path. As written, a body-only
implementation can pass the described modal tests while allowing the real page
to scroll underneath.

## 5. [LOW] The MediaGallery accessible fallback is misdescribed

### What is wrong

Section 4.2 says MediaGallery's existing accessible fallback "remains `Image
attachment`". It does not. The current thumbnail `img` has `alt="Attachment"`.
The spec does not say whether it intends a deliberate accessible-name copy change
or truly wants to preserve present behavior.

### Evidence

- Spec section 4.2: "Its accessible fallback remains `Image attachment`".
- `dashboard/src/routes/contact/MediaGallery.tsx:36-45` renders the current
  image with `alt="Attachment"`.

### What it implies

Choose one exact accessible name, record it as a deliberate requirement, and
make the renderer/E2E selectors test that name. A builder otherwise cannot both
preserve current behavior and satisfy the stated wording.
