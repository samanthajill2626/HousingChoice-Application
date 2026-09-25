# Spec R4 (terminal) adversarial review (reviewer A) - inbox rows + timestamps

Spec: `docs/superpowers/specs/2026-09-25-inbox-rows-timestamps-design.md` (DRAFT 5)
Also read: `spec-r3-adjudications.md`.
Repo read at: worktree `W:\tmp\inbox-rows-timestamps` (base cd8e8ddd).
Posture: adversarial, read-only; code claims cite file:line that was read.

Labels. DECISION would mean a stated decision or mechanism is unsound and a
ruling is needed. PRECISION means the mechanism stands and the correct
replacement rule is determined (no choice between behaviors is needed), or a
test or sentence is missing.

**Honest read for the loop: this round is precision-only.** No finding below
needs a ruling. Findings 1-4 are MEDIUM because, built as written, each ships a
defect the listed tests would not catch; each has one determined fix.

---

## 1. [MEDIUM] [PRECISION] The re-walk fold's range starts at the first page's newest row, so gone rows at the top of the tail survive the refresh

**What is wrong.** 5.8 defines the walked range as `[freshOldest, freshNewest]`,
with `freshNewest` the newest row of the FIRST re-walk page, and keeps tail rows
newer than that range "unexamined" (to protect rows a meanwhile head read slid
in). But the walk starts at the head read's cursor, right after the head's
oldest paged row. A tail row that sits between that point and the first LIVE
tail row, and that the server no longer returns, is newer than `freshNewest`,
so it is kept.

Walk the case the re-walk exists for. Sam scrolls just past page one, opens the
first tail row, soft-deletes the contact (or triages the number), and presses
Back. The head read keeps the tail (branch P, `!wasInHead -> true`). The re-walk's
first page begins after the head. The deleted row is not returned, so the first
returned row is the next one, and `freshNewest` is that row's time. The deleted
row's time is newer, so it counts as "newer than the range" and stays. The rows
an operator acts on first are the ones nearest the top of the tail, which are
exactly the ones this bound misses.

**Fix (determined).** Make the range's upper bound the triggering head read's
boundary `b` (the oldest paged row of that head), exclusive: drop current tail
rows with `freshOldest <= lastActivityAt < b` that no page returned. That still
protects everything a meanwhile head read slides in, since those rows came
from a head whose rows were all at or above `b`. Add this case to the fold's
unit tests: the first tail row is gone and must be dropped.

## 2. [MEDIUM] [PRECISION] "Holds `loadingMore`" is a shared boolean that a discarded `loadMore` clears in the middle of the re-walk

**What is wrong.** The interleaving the adjudication asked about. On a POP
restore at the bottom of a list that is not fully loaded, the sentinel is
intersecting and `autoLoadArmed` was restored, so `useAutoLoad` fires `loadMore`
at mount, before the mount head read lands. The head read then commits. That
bumps `firstPageGenRef`, so the in-flight page is discarded, and it triggers the
re-walk, which sets `loadingMore` to hold it. The discarded page then settles,
and its `.finally` runs `if (!filterStale()) setLoadingMore(false)`
(`dashboard/src/routes/inbox/useInbox.ts:353-359`). A reconcile-stale page is not
filter-stale, so this clears the hold while the re-walk is still running.

`enabled` becomes true, and the epoch differs, because the head read bumped it
after the last fire. Auto-load therefore fires a second `loadMore` from the old
tail cursor, racing the walk. That page appends rows older than the tail. The
fold keeps them ("older than the range") but writes the re-walk's last cursor
over the `loadMore` cursor, so those rows now sit behind the cursor. The next
page re-fetches them as duplicates, and because the page delivered no NEW row
(5.5), auto-load disarms. The manual button is also live during the walk.
Test 3 cannot see this, because its list is fully loaded, so there is no
sentinel at mount.

**Fix (determined).** When the re-walk starts, abort any in-flight `loadMore`,
and give the walk its own in-flight flag that `enabled` and the button also read.
Do not reuse `loadingMore`. Add a hook test with a `loadMore` in flight when
the restore's head read commits.

## 3. [MEDIUM] [PRECISION] A store-hit PUSH does not start at the top: the container keeps the previous page's `scrollTop`

**What is wrong.** 5.8 says a PUSH arrival (the sidebar link or the nav badge)
"restores the ROWS instantly but starts at the top", and seeds `scrollTopRef`
with 0 on that basis. Nothing sets it to 0.

- `main.content` is the shared scroller for every route
  (`dashboard/src/app/AppFrame.tsx:194-196`,
  `dashboard/src/app/AppFrame.module.css:383-387`).
- Nothing in the shell resets scroll on navigation: there is no `scrollTop`,
  `scrollTo` or `useLocation` in `dashboard/src/app/*.tsx`.

Coming from a page that scrolls `main.content` (a long Contacts list, for
example), the route swap keeps that page's offset. A restored list is tall on
its FIRST render, so nothing clamps the offset, and the Inbox opens mid-list.
Today it opens at the top only by accident: the first render is a spinner
(`dashboard/src/routes/inbox/Inbox.tsx:206`), and content shorter than the
viewport clamps the offset to 0. The badge case this rule was written for is
the common path: Sam is somewhere else, sees the badge, and clicks it. The 0
seed is then also wrong, so leaving without scrolling saves a position she was
not at.

**Fix (determined).** In the same layout effect, set the container's
`scrollTop` to 0 on a store-hit PUSH. Add the case to `Inbox.test.tsx`: a pushed
arrival with a non-zero container offset ends at 0.

## 4. [MEDIUM] [PRECISION] The re-walk's `start` is ambiguous, and the wrong reading silently does nothing

**What is wrong.** 5.8: "let `start` be the committed head's cursor". The re-walk
runs only when the committed state holds a paged tail, and in that case branch P
sets `cursor := cursor`, the TAIL's old cursor (5.6). The head read's own `C`
is stored nowhere in `ListState`.

A builder who takes `start` from `listRef.current.cursor` walks from AFTER the
tail. The first page is already older than `oldest`, so the walk stops as
"range covered" after one page. The fold then drops nothing (every tail row is
newer than that page) and appends a page of new rows. The refresh never
happens, and 7.3 test 3 still passes: it counts one head read plus cursor reads
and an unchanged row count.

**Fix (determined).** Say "the head read's own `C`, captured from that
response". Pin it in `useInbox.test.tsx` by asserting the cursor the first
re-walk request carries.

## 5. [LOW] [PRECISION] Gating the unmount save on `aliveRef` can disable it, depending on unstated effect order

5.8 gates both saves on `aliveRef`. 5.5 sets `aliveRef` false in "the hook's
mount effect" cleanup. If that effect is a layout effect declared before the
unmount-save layout effect, its cleanup runs first on deletion. The unmount
save then sees `false` and never writes. The last `commitList` snapshot is what
gets restored, with its stale `scrollTop` and no `pendingRef` fold. The gate
protects nothing here, because this save IS the unmount. Gate the unmount save
on `statusRef === 'ready'` only, or state that the `aliveRef` effect is passive.

## 6. [LOW] [PRECISION] `rewalkDueRef` is never cleared except by a re-walk

The flag starts true on any store hit and the trigger is "the first head read
that commits ... when the committed state holds a non-empty PAGED tail". If
that first commit leaves no paged tail, the flag stays true. Examples: branch
R on Unread or Unknown, or branch P with `C === null`. A filter change doesn't
clear it either. A later head read on the same visit then runs a re-walk the
spec says is not owed. On Unread that can come via branch I, which keeps a
tail. Clear the flag on the first committing head read whatever it leaves, and
on the reset. Check the filter in the trigger.

## 7. [LOW] [PRECISION] Invariant 9 holds only in branch P

"A conversation never renders twice under two kinds". Only branch P's
`keepAdditive` applies the `convsInP` rule. Branch I and the `loadMore` append
dedupe by `rowKey` only, and relay-to-group conversion changes the key from `g:`
to `gt:` for the same conversationId
(`dashboard/src/routes/inbox/useInbox.ts:104-108`). A conversion caught by an
incomplete Unread head keeps the old relay row beside the new group-text row
until the next complete read. The fix is the same `conversationId` check in
branch I and in the append dedupe.

## 8. [LOW] [PRECISION] `intersecting` survives the sentinel's unmount and fires one load out of view

The sentinel renders only while `hasMore`. Say it unmounts while intersecting,
and a later head read installs a cursor. The new sentinel's observer delivers
its first callback asynchronously, but the effect runs first, with the stale
`intersecting: true` and the new epoch, and fires `loadMore` while the sentinel
may be far out of view. Set `intersecting` to false when the observer
disconnects.

---

## Interleavings walked (no finding)

- **Branch I on All with additive rows in P and an old paged tail.** It is
  unreachable. The All pager either fills `limit` rows and mints a cursor, or it
  exhausts the partition and returns `nextCursor: null`
  (`app/src/routes/inbox.ts:2329-2356`). `truncated` is only ever set in the
  unread branch (`inbox.ts:156-161`), so `headComplete` is always true on All.
  If it were reached, it would still be safe: old head rows, additive ones
  included, stay in head and are re-examined by the next branch P.
- **A re-walk whose first page is short with a cursor.** This happens on Groups
  only: `listGroupTexts` returns a cursor with `truncated` when its walk budget
  stops early. The range stop condition is not met, so the walk continues.
  `freshNewest` from a short first page is sound apart from finding 1.
- **A head read slides rows into the tail during the re-walk, then the fold
  runs.** Branch P keeps the tail and its cursor, and the slid rows are at or
  above the triggering head's boundary. The fold dedupes `fresh` against the
  current head and keeps rows above the range. Correct, and it stays correct
  under finding 1's bound.
- **StrictMode replay with the re-walk due flag.** The refs are not
  re-initialized. The first reconcile is aborted in cleanup (AbortError, no
  commit), so the replay's reconcile is the first commit and triggers the walk
  once. `aliveRef` is true again after the replay (5.5).
- **Sign-out.** The layout-cleanup save runs (see finding 5 for its gate), the
  unmount aborts `loadMore`, and the passive AuthGate `clear()` runs after
  every deleted child's cleanups. Correct.
- **`overflow-anchor: none` on the page root.** `.page` is the Outlet's only
  child in `main.content` (`AppFrame.tsx:194-196`; `Inbox.tsx:93`), so excluding
  its subtree leaves the scroller without an anchor candidate. Correct.
- **Test 6** (1280x400, `?limit=12`, about 30 parties). A 12-row page is taller
  than the viewport plus the 400px margin, so a chain would show up as a second
  cursor request after one scroll, and the test asserts exactly one. It can now
  fail on the defect it names.
- **`pendingRef`, the reset ordering, the `pageEpoch` definition, the
  POP-only seed** (apart from finding 3), and **`resolveContact` as the
  memoized pair operation**: all correct as specified. The throwing-phone
  fixture pins the "skip email after a phone error" behavior.
