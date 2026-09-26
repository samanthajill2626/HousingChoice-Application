# Spec R3 adversarial review (reviewer A) - inbox rows + timestamps

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 4)
Also read: `spec-r2-adjudications.md`.
Repo read at: worktree `W:\tmp\inbox-rows-timestamps` (base cd8e8ddd).
Posture: adversarial, read-only. Code claims cite file:line that was read;
browser-engine claims not exercised in a lane are marked UNVERIFIED.

Each finding is tagged DECISION (the builder cannot proceed correctly without a
ruling, or the mechanism must change) or PRECISION (the decision stands; a
rule, a test or a sentence needs fixing).

**Honest read for the loop:** this round is NOT precision-only. Finding 1 is a
self-contradiction in the new model R that needs a ruling, and finding 3 is a
small ruling on what Unknown's normal budget exit shows. Finding 2 is precision
in kind but HIGH in consequence: the anti-chain fix as placed may not work, and
the test written to prove it cannot fail. Findings 4-8 are precision, but
several are the kind a builder gets wrong silently. I expect one more round
after these edits to be precision-only.

---

## 1. [HIGH] [DECISION] Model R contradicts itself: a non-empty incomplete head REPLACES the list, while three other statements say an incomplete refresh never shrinks it

**What is wrong.** 5.6 model R, `else` arm (budget exit or depth cap): when
`P.length > 0` it runs `head := P; tail := []; cursor := C` ("a short page IS
page one"). A budget-short page with 12 rows therefore replaces a 100-row (or
250-row) list with 12 rows. Against that:

- Section 3, design consequence: "an incomplete refresh never shrinks it".
- 5.6, invariant paragraph: "On Unread and Unknown a complete head read
  replaces the list with its fresh page one and an incomplete one changes
  nothing."
- Section 6, invariant 1: "Unread/Unknown: ... an incomplete one changes
  nothing."

The `else` arm is exactly the round-1 finding (A2/B2) this model was built to
close, and it is most reachable on Unknown, whose budget exit returns short
pages when soft-deleted residue sits in the queue (`app/src/lib/unknownQueue.ts`
header: residue "accumulate[s] in this partition FOREVER" and "a page thick
with residue returns short - even EMPTY - pages WITH a lastEvaluatedKey").
Walk the requested interleaving: on Unread, a 100-row head plus a tail whose
last page hit the depth cap (`nextCursor: null`, `truncated`,
`app/src/routes/inbox.ts:1655-1660`) meets a budget-short head read (short page,
cursor, `truncated`, `:1661-1672`). `headComplete` is false, `P.length > 0`, so
the list collapses to the short page and the operator's scroll position clamps.

**What it implies.** A ruling: either "incomplete never shrinks" (then state what
happens to `head`, `cursor` and the flags when P has rows: for example keep the
old list and cursor, take P's fresh copies of rows it contains, show nothing)
or "a short page replaces" (then correct section 3 and both invariants). The
builder cannot satisfy both as written.

---

## 2. [HIGH] [PRECISION] `overflow-anchor: none` on the `<ul>` does not disable anchoring, and test 6 cannot detect the chain it is meant to rule out

**What is wrong.**

(a) Placement. `overflow-anchor: none` excludes the element and its subtree from
anchor-node SELECTION; it does not turn anchoring off for the scroller. The
scroller is `main.content` (`dashboard/src/app/AppFrame.module.css:383-387`,
no `overflow-anchor`). With the list excluded, the anchor-selection walk
(CSS Scroll Anchoring: the first non-excluded, fully visible element in DOM
order, descending into partially visible ones) moves on to what follows the
list. When auto-load fires, the operator is at the bottom, and what is visible
after the `<ul>` is the sentinel and the Load more button
(`dashboard/src/routes/inbox/Inbox.tsx:284-293`; 5.2 places the sentinel
between them). The button becomes the anchor. The appended page sorts ABOVE
the group wall inside the `<ul>`, i.e. before the anchor in DOM order, so the
browser raises `scrollTop` to hold the button in place. The sentinel does not
move relative to the viewport, it stays intersecting, the commit bumped the
epoch, and 5.2's effect fires again: the R2 chain, intact. The contact
timeline's opt-out works because it sits on the SCROLLER itself
(`dashboard/src/routes/contact/Timeline.module.css:117,142`, `.stream` has
`overflow: auto`). UNVERIFIED in a browser (Chromium's candidate filtering for
the empty sentinel div is not verified; the button is an ordinary candidate).
Putting the property on the Inbox page root (`.page`, the Outlet's only child
in `main.content`) excludes the whole page subtree and has the intended effect.

(b) The test. 7.3 test 6 runs at `?limit=2`. A 2-row page is about 120px, far
less than the 400px margin, so with anchoring fully disabled the sentinel STILL
stays inside the margin after each page and the epoch rule chains to the end of
the feed - by design (5.2: "only a SHORT page ... can leave it inside the
margin and continue"; at limit 2 every page is short in pixels). Its assertions
("at most one [cursor request] per page the list gained", "stops growing when
the feed ends") are satisfied by a chain: each chained request gains one page,
and every chain stops at the end of the feed. The test cannot fail on the
defect it names.

**What it implies.** Move the property to the page root. Make test 6 use a page
taller than the viewport plus 400px (for example `?limit=15` at 1280x500 with
enough seeded parties for two pages beyond the first) and assert EXACTLY ONE
cursor request after a single scroll to the bottom.

---

## 3. [MEDIUM] [DECISION] Model R's zero-row incomplete arm raises "Couldn't refresh the inbox." for Unknown's budget exit, a state the server deliberately does not call a failure

**What is wrong.** On Unknown, `{ rows: [], nextCursor }` is a normal, documented
answer (spec section 2; `Inbox.tsx:257-271`). The server refuses to attach
`truncated` to it precisely so the dashboard does NOT show a failure: "NEVER the
`truncated` wire flag here ... an empty page carrying it renders the
dashboard's FAILURE banner - on a tab whose NORMAL state is an empty, cleared
queue" (`app/src/routes/inbox.ts:2279-2284`). Model R classifies that page as
incomplete (`C !== null`, `pagedP.length < limit`), finds rows rendered, and
sets `refreshFailed` (5.6, 5.7). The copy is false - the read succeeded - and
"Retry refresh" re-runs the same prefix with the same budget and gets the same
answer. On a queue whose front is thick with residue this happens on every head
read, so the banner is permanent and the Unknown list never refreshes. On
Unread the same arm is consistent with the server (there a zero-row page with
`truncated` IS the server's early-end signal, `inbox.ts:1634-1645`, `:1714`).
Rare (it needs a full scan budget of residue at the queue front), but a design
that renders a failure for a success.

**What it implies.** Rule that on Unknown a zero-row incomplete head with rows
present keeps the list silently (no banner), and keep the banner for Unread.

---

## 4. [MEDIUM] [PRECISION] The tail re-walk (5.8) is underspecified at every edge that decides whether it delivers its promise

5.8 promises that a return "show[s] the operator's own triage, rename or
deletion on a tail row, and another operator's reads". As written:

- **Coverage.** It requests `tailPages` pages from the fresh head's cursor. The
  tail holds `tailPages` pages of loadMore rows PLUS every slid row (5.5), and
  the mount head read slides more rows in (activity while the operator was
  away). `tailPages * limit` can fall short of the tail; the shortfall is the
  OLDEST rows, the ones at the bottom where a POP restore just put the
  operator. They are "not returned by any page" and dropped, the list shrinks
  under her restored position, the final cursor is non-null even when the old
  tail had reached the end (null), and auto-load (sentinel now in view) fetches
  them back. Invariant 8 ("a fully loaded list stays fully loaded") fails on
  return. Stop on "cursor null, or the page's oldest row is older than the old
  tail's oldest row", not on a page count.
- **"The corresponding stretch".** Nothing defines which old tail rows a page
  "re-read" versus which are "not yet re-read"; a boundary (the page's oldest
  `lastActivityAt`) is needed, or only the end-of-walk drop is implementable.
- **Concurrency with `loadMore`.** After the mount head read, model P keeps the
  OLD cursor (tail kept). A POP restore at the bottom makes the sentinel
  intersect, so auto-load runs `loadMore` from that old cursor while the re-walk
  runs from the head's cursor. A `loadMore` commit does not bump
  `firstPageGenRef`, so the re-walk is not abandoned; at its end the rows
  `loadMore` just appended are "old tail rows that no page returns" and are
  dropped, and the re-walk's final cursor overwrites `loadMore`'s. Specify that
  the re-walk holds `loadingMore` (so auto-load and the button wait) and
  whether re-walk commits bump the epoch.
- **Abandonment.** Any later head read abandons the re-walk (5.8) with no
  resume. On a busy inbox an SSE event lands inside the re-walk's window often,
  and the refresh the return promised silently does not happen.
- **A failed mount reconcile never re-walks.** The re-walk is keyed to "the
  mount reconcile's head read commits". If that read fails (banner), a later
  Retry or SSE head read is not the mount reconcile, so this visit never
  refreshes the tail. Key it to "the first head read that commits after a
  store restore".

---

## 5. [MEDIUM] [PRECISION] Two save-gating holes re-open the empty-snapshot and wrong-key cases invariant 7 closes

- **The unmount save is not gated on `ready`.** 5.8 gates `commitList` saves on
  `status === 'ready'`, but THE UNMOUNT SAVE is a separate direct write
  (layout-effect cleanup) with no stated gate. StrictMode (on in dev and e2e,
  spec section 2) runs that cleanup on every mount; on a store miss the status
  is `'loading'` and the list is empty, so an empty snapshot is written. A real
  exit before the first page lands does the same. The next return restores
  `'ready'` with zero rows and renders the filter's empty copy ("You're all
  caught up") until the head read lands - invariant 7's "no snapshot is written
  before the first page commits".
- **The reset saves.** "The filter/limit-change reset commits an empty
  `ListState` and clears ... the status." `commitList` saves when the status
  is `'ready'`, and on a tab switch the status IS `'ready'` until the reset
  clears it. Depending on whether `keyRef` has moved yet, the empty list lands
  under the NEW key (a false empty-ready restore if she leaves before the first
  page) or the OLD key (the old tab's snapshot is destroyed, breaking 5.8's
  "the other key's snapshot is kept for its own return"). `keyRef` cannot be
  written during render (`react-hooks/refs`, spec section 2), so the ordering is
  decided in an effect the spec does not describe.

Also: "WHEN TO SAVE: only from `commitList`" contradicts the direct unmount save,
and the initial load must apply `'ready'` before its `commitList`, or the first
page is not saved until the next commit.

---

## 6. [MEDIUM] [PRECISION] `aliveRef` is only ever set false; after StrictMode's simulated unmount it stays false for the component's life

5.5: "`aliveRef` is set false in the unmount cleanup". Nothing sets it true
again. StrictMode's mount/cleanup/mount replay (spec section 2) runs that
cleanup once on every mount, so in dev and in the e2e harness `aliveRef` is
false from the first commit on: `commitList` never saves, and "A `loadMore`,
`markRead` or `markUnread` that settles after unmount neither commits nor saves"
fires for every settle - auto-load pages and mark-read commits never land. The
suite would catch it at once, so it would not ship; it is the standard
StrictMode trap and the spec should name the fix: set `aliveRef.current = true`
in the same effect's body, and gate the unmount save the same way.

---

## 7. [MEDIUM] [PRECISION] Kept additive rows are filed as "tail", which breaks the cursor, arming and re-walk rules built for loadMore rows

`keep(oldRow, true)` on an additive row whose kind did not come back returns
`true`, so the row goes into `newTail`. Everything keyed on
`newTail.length > 0` then treats it as a loadMore chain:

- **Duplicate rows on conversion.** Relay-to-group conversion happens in place,
  under the same conversationId ("converts it in place instead of minting a
  second thread", `e2e/tests/dashboard-next/group-text-conversion.spec.ts`
  header; the lean fixture `app/src/lib/seed/lean.ts:257-265`). The rowKeys
  differ (`g:` versus `gt:`, `useInbox.ts:104-108`). When the LAST relay group
  converts, P has no `relay_group` rows, the old relay row is kept, and P's new
  group-text row for the same conversation renders beside it.
- **Stale cursor.** A head read with `C === null` (the feed ended inside page
  one) plus one kept relay row leaves `cursor := cursor` (the old, non-null
  cursor), so Load more reappears over rows the head already holds.
- **Never dropped.** `tailPages` stays 0 when only additive rows were kept, so
  the re-walk never runs and never drops them; with the store they outlive
  every return until a reload.

Keep kept additive rows in `head` (they are page-one rows), exclude them from
`newTail.length` for the cursor, arming and `tailPages` rules, and drop an old
additive row whose conversationId appears in P under any kind.

---

## 8. [MEDIUM] [PRECISION] The Back promise is false on Unread and Unknown past 100 rows

Invariant 2 promises that Back "shows the same rows and scroll position, then
reconciles"; section 3 adds "Scroll position is kept on every tab". Under model
R the mount reconcile is a complete head read on almost every return, so it
REPLACES the restored list with page one: a list scrolled to row 180 collapses
to 100 rows one round trip after the POP restore, and the restored position
clamps. On Unknown this is the triage loop itself (scroll deep, open a number,
triage, Back). Section 8 states replacement "on the next event"; the mount
reconcile runs on every return, not on an event. Either restate invariant 2 and
the outcome for these tabs, or (a DECISION) have the model-R mount reconcile
read `1 + tailPages` pages and replace with all of them, which is sound in queue
order.

---

## 9. [LOW] [PRECISION] The row click's own optimistic mark-read never reaches the unmount save

Opening a row runs `onOpen` (markRead: `setPatch`, a functional state update,
`useInbox.ts:379-385`) and the `Link` navigation in the same click
(`InboxRow.tsx:94`). React batches both; the render that applies them unmounts
the Inbox, so the pending patch is never rendered, no ref mirrors it, and the
layout-cleanup save folds in nothing. The POST then settles after unmount and,
correctly, does not commit. On return the opened row shows its old unread count
for a round trip (on Unread, the row she just read is listed as unread) while
the badge already cleared it. Write `pending` through a ref synchronously, the
way `commitList` does for the list.

## 10. [LOW] [PRECISION] `epoch` has two definitions, and one of them re-fires a failed page

5.2: bumped "on every COMMITTED head read and every COMMITTED `loadMore`".
5.5 (`ListState.epoch`): "bumped on every commit", which includes mark-read
commits and rollbacks, the reset and re-walk pages, since `commitList` is the
only writer. Under 5.5's reading a failed `loadMore` (no bump) is retried as
soon as the operator marks any row read, contrary to invariant 3 ("never
re-tries a failed page without an intersection change or a manual click"), and
re-walk commits fire `loadMore` mid-re-walk (finding 4). Pick 5.2's definition
and say `commitList` bumps only for those two writers.

## 11. [LOW] [PRECISION] The `<=` tie comment misstates the cost

"Keeping a gone one for one read": a kept head row moves to the tail
(`wasInHead` is false from then on), where the boundary rule never re-examines
it; a genuinely closed row at the boundary instant persists until the next
return's re-walk or a reload.

## 12. [LOW] [PRECISION] The narrow query must reset `.head`'s 45% cap

5.4 sets `.head { max-width: 45% }` in the default styles and says the narrow
layout's name has "no `max-width`", but the cap is on `.head`, not `.name`, and
it carries into the grid unless the media query resets it
(`max-width: none`). On a 360px phone it caps the name area at about 125px.

## 13. [LOW] [PRECISION] Seeding `scrollTopRef` from the snapshot is wrong on a PUSH arrival

On PUSH the rows restore but the container starts at the top (5.8). The ref is
still seeded with the snapshot's old offset, so leaving before any scroll event
saves a position this visit never showed, and the next POP restores it. Seed
with the value actually applied (the snapshot under POP, the container's
current value under PUSH).

## 14. [LOW] [PRECISION] 5.10's contact-lookup cache: two statements contradict

"`rowForConversation`'s existing try/catch block calls through them unchanged in
shape" needs a failed `findByPhone` to REJECT into that catch, which skips
`findByEmail` and logs the WARN (`app/src/routes/inbox.ts:1079-1086`). "Rejections
are never cached: the degraded fallback ... is what the promise resolves to"
makes the phone lookup resolve `undefined`, the catch never fires, and the email
lookup runs where the sequential path did not. Say which: for example the cache
stores nothing on rejection (the loop's call re-reads and rejects into the
existing catch), and the prefetch swallows its own rejection.

## 15. [LOW] [PRECISION] 7.3 test 3's "exactly one head read" must count finished requests

StrictMode runs the filter effect twice on every mount, Back included; the first
run's head read is issued and aborted (5.8 says so for the store-miss case, and
the store-hit case schedules a reconcile on both runs). A request log that
counts issued requests sees two. Count responses (`requestfinished`), as the
perf harness does.

## 16. [LOW] [PRECISION] The rationale "page one is the badge cap" does not cover Unknown

Section 8 justifies dropping a model-R tail past 100 rows with "Page one is the
badge cap". The badge counts unread rows; the Unknown queue is not bounded by it
and can exceed 100 read-but-untriaged numbers. The consequence is stated; the
reason is wrong for one of the two tabs (see finding 8).

---

## Contest of the round-2 adjudications

All 17 of my round-2 findings were accepted; nothing to contest as rejected.
Where an accepted fix introduced a new problem it is raised above as a new
finding rather than a reopening: R2-1 (anchoring) -> findings 2 and 10;
R2-2 (two models) -> findings 1, 3, 8, 16; R2-3 (re-walk) -> finding 4;
R2-7 (`aliveRef`) -> finding 6; R2-9 (seeded ref) -> finding 13;
R2-10 (`.head` cap) -> finding 12; R2-14 (additive kind rule) -> finding 7;
R2-15 (caches) -> finding 14.

## Are the other DRAFT 4 changes correct?

- `headComplete` with `!truncated` (R2-5): correct; the Unread zero-row
  budget exit no longer wipes the list (it shows the banner, which matches the
  server's early-end semantics on Unread).
- The null-cursor-kept rule (R2-4): correct for loadMore tails; see finding 7
  for kept additive rows.
- `commitList` over an authoritative ref (R2-8): correct in principle; the
  saved value is the committed value. Gating holes in findings 5 and 6.
- The epoch effect (R2-6, R2-11): the lifecycle is right. Walked: a head read
  that installs a cursor while the sentinel intersects fires once through the
  epoch; a head read that discards an in-flight `loadMore` fires once after
  that page settles (`loadingMore` false, epoch unrecorded); a failed page with
  no commit does not fire. See finding 10 for the definition clash.
- Model P on All and Groups: walked page one plus groups with one and two
  successive arrivals, a slid-then-slid-again row, and a zero-paged-row head
  (`C === null`, correct drop); Groups' walk-budget page carries a cursor
  (`app/src/repos/conversationsRepo.ts`, `listGroupTexts` returns `nextCursor`
  with `truncated: items.length < limit && exclusiveStartKey !== undefined`), so
  it is correctly incomplete. Correct except finding 7.
- Sign-out mid-loadMore: correct as specified. The layout cleanup saves, then
  aborts the page (`filterStale()` sees the abort, so no commit); the passive
  AuthGate effect clears after every deleted child's cleanup; a late mark-read
  cannot write once `aliveRef` is false (finding 6 is about setting it true
  again, not about this path).
- `useOptionalAuth` / `'anon'`: correct; the existing hook tests need no
  provider.
- 5.10 promise caches and `stop` flag: correct apart from finding 14; memoizing
  the raw message read and deriving per call keeps previews identical.
