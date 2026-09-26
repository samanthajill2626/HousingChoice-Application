# Code review round 2 - inbox rows + timestamps

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps` @e05c985f (merge base
`main` @cd8e8ddd; round 1 reviewed 156022b7; fix wave 96dce256..ef37bf69 plus
the spec/report commits c86c70ea, e05c985f). Reviewer: fresh, read-only on the
tree. Inputs: both round-1 reports, the adjudications, the fix-wave report,
spec DRAFT 8.5, the fix diff and the live files.

Evidence method, stated once. (a) One throwaway vitest file
(`dashboard/src/routes/inbox/zz-review2-error-rows.test.tsx`, real `Inbox` +
`useInbox`, mocked API), run alone and deleted by exact name; `git status` is
clean apart from this report. (b) Layout geometry measured in the desktop
app's browser pane (Chromium 152.0.7977.130, Windows, `system-ui` = Segoe UI):
the row DOM of `InboxRow.tsx` with the rules of `InboxRow.module.css` and the
`tokens.css` values inlined, injected into a plain https page (the pane refuses
local files and `data:` URLs), inside boxes sized as `main.content` at each
viewport (viewport - 240px sidebar, 24px padding each side; the 360px box
applies the 767.98px query's rules). No app server, lane, suite, e2e or
perf:pages run; the tabs were closed afterwards. Font metrics vary by OS; the
mechanisms below do not.

Summary: 1 MUST-FIX (R2-1, a user-visible regression the first pass and every
gate missed), 1 SHOULD-FIX (R2-2), 5 NOTEs; one adjudication contested with a
reproduction (AD-12); every FIX row is real except one doc paragraph (AD-15)
that states something false; SC-13 is correct by reading but has never run.

## 1. New findings

### R2-1 MUST-FIX - `.head { flex: 0 1 auto }` makes the NAME absorb the preview's overflow: long messages cut or erase the contact's name at every desktop width

Where: `dashboard/src/routes/inbox/InboxRow.module.css:72` (`.head` `flex: 0 1
auto`, with `min-width: 0; max-width: 45%` at :73-74), `.preview` `flex: 1 1
auto` (:125-133); prescribed verbatim by spec 5.4 (`spec:451-453`), whose own
claim at `spec:456-459` ("An ordinary name in a wide row is NOT ellipsized ...
The preview, the count and the time therefore always keep their room") it
contradicts. On `main` `.head` was `flex: 0 0 auto`: a name was never cut.

Mechanism: when the one-line row overflows, flexbox shares the shortfall
between the shrinkable items in proportion to flex-shrink x base size. The
preview is `white-space: nowrap`, so its base size is the max-content width of
the WHOLE latest message on one line; the head's share tends to its min-width
(0) as the message grows. Used head width = head_base x avail / (head_base +
preview_base). The chips cannot shrink (nowrap, automatic min size), so the
name (min-width 0) takes all of it. The preview is the latest message's full
body, never capped (`app/src/routes/inbox.ts:735-737`); inbound email bodies
are stored up to 100 KB and used verbatim (`app/src/services/inboundEmail.ts:101,
:562, :719`).

Reproduction (measured, as built; "shown/full" px of the `.name` box):

| Viewport (sidebar open) | Row | Name shown/full |
|---|---|---|
| 1280 | "Tasha Nguyen", 22-char preview | 95/95 |
| 1280 | same, 160-char SMS (read / unread) | 69/95, 61/99 |
| 1280 | same, 300-char message | 24/95 |
| 1280 | 160-char SMS + "Awaiting approval" tag | 24/95 |
| 1440 | 160-char SMS / 300-char / 160 + tag | 88/95, 34/95, 57/95 |
| 1920 | 160-char SMS / 300-char | 95/95, 65/95 |
| 1536, 1920, 2560 | 1500-char body (an email) | 0/95 at all three |
| 768 | unknown row "(555) 123-4567" + Text + Needs triage, 160-char unread body | 0/108, chips overflow the head box by 71px onto the preview |

The last row is exactly the row shape e2e test 4 checks at 768
(`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts:315-319`); it passes
because the minted body is ~20 characters and the check covers the time box
only. The WIDE_RESTORE check (`:321-324`) passes because Tasha's seeded
preview is 72 characters (`app/src/lib/seed/lean.ts:288`). Unit tests run
with `css: false`. No gate can see it.

Consequence: on Sam's desktop the row's identity - the name, or the number on
an unknown row - is cut to a few letters for any multi-sentence text or any
templated "You: ..." send at 1280-1440px, and disappears entirely for email
rows at every width. A regression from `main`, on the primary surface.

Smallest fix (measured): `.head { flex: 0 0 auto; }` keeping `min-width: 0;
max-width: 45%` (the head is then min(content, 45%) and never shrinks further;
the preview absorbs the rest). With it: 1280 names 95/95 with 160- and
300-char previews; a 50-char name caps at 401/407 (the 45% rule, as
intended); 768 ordinary names 95/95, the unknown row 75/108 with no overflow;
the time box stays inside the row in every case; the narrow grid is
unaffected (grid ignores flex). Amend spec 5.4 (`spec:452-453`) with the
reason. Pin it in e2e test 4: a party whose inbound is ~300 characters, its
name not ellipsized at WIDE_RESTORE and `clientWidth > 0` at 768.

### R2-2 SHOULD-FIX - chips never yield: a long placement tag erases the name on phones and overprints the preview in the 768-900px band

Where: `InboxRow.module.css:87-110` (`.channel`, `.tag`, `.triage`,
`.deletedTag`: nowrap, automatic min size), `:68-75` (the head cap), `:219-223`
(narrow: head in `minmax(0, 1fr)`). Stage labels run to 29 characters
(`app/src/lib/statusModel.ts:98` "Awaiting receipt confirmation"; five labels
of 21+).

Mechanism: once the chips alone exceed the head's width, the name goes to 0
and the chips overflow the head box, which does not clip.

Reproduction (measured, as built): 768 band, contact + Text + "Awaiting
receipt confirmation": name 0/62, chips overflow 40.5px (short preview) to
150px (160-char preview) over the preview. 360 (grid): name 6/62 with that
tag, 0.5/60 with "Awaiting landlord submission". With R2-1's fix the 768 case
is still name 0 with 12px overflow; phones are unchanged (grid).

Consequence: contacts in the long "Awaiting ..." stages lose their name on
phones and at the tightest one-line band; chip text overprints the preview.
Spec 7.3 test 4 moved placement-tag rows to the live self-QA (7.4), which has
not reported on them.

Smallest fix (measured with R2-1): `.tag { min-width: 0; overflow: hidden;
text-overflow: ellipsis; flex-shrink: 100; }` (same for `.deletedTag` if
wanted): 768 name 62/62, tag 101/172, no overflow; 360 name 62/62, tag 118/172.

### R2-3 NOTE - "error with rows" IS reachable (contests AD-12), and it leaves the mount without a scroll listener or an observer root

Where: `dashboard/src/routes/inbox/useInbox.ts:395-413` (a failed head read
with no rows rendered sets `error` WITHOUT bumping `firstPageGenRef`),
`:527, :530` (loadMore is reconcile-stale only on that counter),
`Inbox.tsx:161-169` (scroll-root effect keyed on `[hasRows]` only), `:364`
(the `<ul>` renders only while `ready`), `:171-177` (listener).

Interleaving: a page with no rows and a cursor (Unknown budget exit) -> the
operator clicks Load more -> an SSE head read FAILS while that page is in
flight -> status `error` (nothing rendered) -> the page is not stale, so it
commits its rows into the `error` list. The scroll-root effect ran while the
`<ul>` was absent, returned, and never re-runs when Retry brings the `<ul>`
back, because `hasRows` stayed true. AD-12's "unreachable (a loadMore in
flight across a head commit is reconcileStale)" misses that a FAILED head read
commits nothing.

Reproduction (throwaway, deleted): the failure surface is up with the page's
rows committed and not rendered; after Retry, a scroll to 250 followed by
unmount saves `scrollTop` 0 (control, a plain load: 250).

Consequence: rare; for that mount the back-button return lands at the top,
and auto-load runs with `root: null` (the implicit viewport root cannot see
past `main`'s clip, so the 400px lookahead is gone). Self-heals on remount.
Smallest fix: key the effect on the list being rendered (`listShown =
inbox.status === 'ready' && hasRows`) or use a callback ref on the `<ul>`.

### R2-4 NOTE - the memo makes the midnight staleness inconsistent within one list

Where: `InboxRow.tsx:53` (memo), `:67` (`new Date()` at render);
`inboxListMerge.ts:129-130` (branch I keeps unmatched row objects), `:145-159`
(appendPage keeps every existing object).

Mechanism: a row re-renders only when its object changes. Before the memo any
Inbox render (an observer report, a badge change) refreshed every label. After
local midnight with no complete head read, an auto-load append labels its
(older) rows "Yesterday" while the rows above keep yesterday's clock times
("11:58 PM" reads as tonight); a mark-read flips only its own row. Spec 4.2
(`spec:278-280`: "a reconcile (any inbox event) ... re-renders them") and the
filed `docs/issues/inbox-labels-do-not-roll-over-at-midnight.md` ("until
anything re-renders the list") are now half true: an incomplete reconcile
does not. Smallest fix: pass a day key prop computed in Inbox's render (e.g.
`new Date().toDateString()`), which invalidates the memo on a day change at no
per-render cost; or amend the spec line and the issue.

### R2-5 NOTE - the module formatters pin the time zone at load

Where: `inboxTime.ts:19-32` vs `:43-49, :56-58`. Each `Intl.DateTimeFormat`
resolves the default zone at construction; the tier logic reads `Date`
getters that follow the current zone. After an OS zone change mid-session the
tier is chosen in the new zone and printed in the old one (a row that is
11:30 PM locally can print "12:30 AM"). The replaced `toLocale*String` calls
resolved the zone per call. Listed under "Worth an eye" in the fix-wave
report, not filed. Smallest fix: file it (low), or rebuild the four formatters
when `Intl.DateTimeFormat().resolvedOptions().timeZone` changes.

### R2-6 NOTE - an unknown row's number is ellipsized where it is the row's identity (design question)

Measured: at 360 "(555) 123-4567" shows 59-93 of 108px (with "Dec 18, 2025" /
"Sep 12" in the time column); at 768, after R2-1's fix, 75 of 108px (the 45%
cap with Text + Needs triage). "(555) 123-4..." hides the digits that tell two
unknown callers apart. Per the letter of spec 5.4; worth Sam's eye (e.g. let
the "Text" chip yield before the number).

### R2-7 NOTE - text that is now false

- `docs/issues/inbox-loaded-pages-survive-refresh.md:22-28` (the AD-15 FIX):
  "a reader parked past page one ... invisible except as cost". The complete
  head read drops the tail, the browser clamps `scrollTop` to the bottom of
  page one, and the reload appends BELOW her, so her position jumps back to
  about row 100 on every event - the visible cost spec 8 states
  (`spec:1112`). Only a reader parked near row 100 sees nothing.
- Spec 5.5 (`spec:510-511`) "cursor: the position after the last row of head
  ++ tail": after AD-4 a null cursor takes C, which continues after P.
- Spec 5.2 (`spec:353-357`) and `useAutoLoad.ts:18-21`: the residual "an entry
  the browser delivers between that drain and the following observe" cannot
  occur (two synchronous calls). For the default factory no residual is left.
- Spec 5.4 (`spec:488-491`) "`title` ... gives the full stamp on hover": false
  on every row that offers an action (AD-3, measured in section 3).
- Spec 8 (`spec:1139`) "re-reading at most one page": true for auto-load (it
  disarms on the first all-duplicate page); a manual reader of a list loaded
  over N pages re-walks up to N-1 pages, each click adding nothing visible.

## 2. Cold review of the fix diff

**96dce256 (AD-1).** Formatters: same locale and options as the calls they
replace, so the strings are identical; `plainSpaces` kept. Side effect R2-5.
The NBSP pins spy the prototype `format` getter, so they would also pass with a
per-call `new Intl.DateTimeFormat(...)`: the perf property itself is unpinned
(acceptable for a perf property). Memo: prop identity holds - `onOpen` /
`onMarkRead` = `markRead` (`useInbox.ts:587-669`; every dep is a `[]`
callback or stable per `UnreadContext.tsx:193-211, :302-305`), `onMarkUnread`
= `markUnread` (`:671-710`). Row objects survive observer reports, `loadingMore`
flips and badge changes (the renders AD-1 measured); every complete head read
replaces every object (fresh JSON), and every PATCHED row gets a new object per
render (`useInbox.ts:156-162`), so those re-render as before - correct, just
no saving. The only consumer that relied on re-rendering is the label's `now`
(R2-4). The comment at `InboxRow.tsx:51-52` is true.

**6959578c (AD-4).** Traced per filter: All never takes branch I (the pager
fills to `limit` or exhausts, `app/src/routes/inbox.ts:2437-2473`; `truncated`
is unread-only), so no change there. Unread budget exit (truncated + cursor):
null -> C; depth cap (truncated + null): null stays null. Unknown budget stop
or deferral (short + cursor): null -> C. Groups: same, rare. With appendPage the
re-walk re-delivers present rows, rowKey dedupe drops them, `fresh.length ===
0` disarms: no chain. `autoLoadArmed` is kept (often true) and the sentinel
mounts in the same commit as the epoch bump, so an operator parked at the
bottom gets one load - intended. The saved snapshot carries C, so a restore
offers Load more - intended. The pin (`inboxListMerge.test.ts:172`)
discriminates both mutants. Text: R2-7.

**d9923997 (AD-5).** `takeRecords()` between `unobserve` and `observe` drains
only entries queued at earlier rendering updates; the new observation always
queues its own initial entry at the next update (a fresh registration starts
at previousThresholdIndex -1 in the IO spec), which describes the committed
DOM, so no legitimate report is lost. One target per observer, so the drain
cannot drop another target's entry. Each factory call owns its `live` flag, so
a StrictMode replay is unaffected. Per round 1 Chromium already discards an
unobserved target's records (a no-op there); the benefit is Gecko's. I tried
to exercise it in the pane, but the pane was hidden, `requestAnimationFrame`
never fired and the probe timed out: no live-browser evidence either way. The
unit harness injects its own factory, so nothing tests the default one (as
before). Text: R2-7.

**9edab26a (docs).** AD-9 comment true enough (precisely: the stale copy wins
until a complete head read, or an incomplete one that carries that row).
AD-10 comments match React 19's deletion order (layout cleanups parent-first,
all before passive work). AD-7 numbers updated. AD-15 paragraph: R2-7.

**9dd2f2dd (tests).** Traced against the named mutants: SC-1/SC-2
(`useAutoLoad.test.tsx:115, :132`), SC-3 (`useInbox.test.tsx:1233`), SC-6
(`:1248`), SC-7 (`:1265, :1282`), SC-8 (`:184`), SC-10 (`:357`), SC-5 and AD-4
(`inboxListMerge.test.ts:112, :172`), SC-11, SC-12, gaps 6-9
(`Inbox.test.tsx:674, :700, :712`) and SC-4 (`:725`, a pass-through mock that
pins the page's wiring, which is its job) all discriminate. SC-9: the flip and
commit test discriminates; the rollback test's store assertion
(`useInbox.test.tsx:1336`) is vacuous (the store was written by the head read
before the patch, and a rollback commits nothing), its render assertion
carries it; the post-unmount test kills only the double removal (as the
report says). AD-8 (`inboxLimits.test.ts`) reads both sources and fails
loudly on a format change. SC-13 (e2e): the first-row regex, the sorted
hrefs and the top-edge bound are right against the code; never executed. No
new test passes only because a mock hides the real path.

**ef37bf69 (issues).** The four filed issues read accurately; the AD-3 issue
says "no browser was run" - now measured (section 3). **c86c70ea / e05c985f**:
the Status line keeps the approval; 7.1 matches 5.6; 5.2 residual per R2-7.

## 3. Adjudication challenges

- **AD-12 (NOTE, "unreachable")**: contested with a reproduction - R2-3.
- **AD-2 (REJECT)**: agree. The old group rows sit BELOW the insertion point
  of an appended page, so they would be the anchor and the view would hold at
  the wall; excluding only the sentinel and button cannot stop that chain. One
  unlisted cost for spec 8: every toggle of the refresh banner or a notice
  above the list now shifts the list too.
- **AD-4 (ACCEPT)**: agree with the rule; the cost statement and the 5.5
  cursor definition need the corrections in R2-7.
- **AD-3 (FILE)**: agree it is Sam's call. Measured: the revealed overlay is
  85.6px (Mark read) / 99.6px (Mark unread) wide from 12px inside the row's
  right edge; it covered the time box on every row measured at 360, 768 and
  1280, so the tooltip is unreachable wherever an action is offered. Amend
  spec 5.4 (`spec:488-491`).
- **AD-13 (FILE)**: agree.

## 4. Per-FIX-row verdicts

| Row | Verdict | Evidence |
|---|---|---|
| AD-1 | REAL | Formatters identical in output (same options); memo effective for non-head-read renders; props stable (section 2). Side effects R2-4, R2-5. |
| AD-4 | REAL | `inboxListMerge.ts:135`; traced per filter; pin discriminates. Text R2-7. |
| AD-5 | REAL (hardening) | Code as described; no report can be lost; not browser-verified (pane hidden). |
| AD-7 | REAL | Both issues updated. |
| AD-8 | REAL | Source-reading pin; mutant killed. |
| AD-9 | REAL | Comments and issue reworded; accurate within the nuance in section 2. |
| AD-10 | REAL | Comments and spec 5.8 now match React 19. |
| AD-15 | PLAUSIBLE-ONLY | Paragraph added, but "invisible except as cost" is false for a reader past row ~100 (R2-7). |
| AD-16 | REAL | `inboxListKey()`; `HYDRATE_CONCURRENCY + 1`. |
| SC-1..SC-12 | REAL | Traced; SC-9 rollback's store assertion vacuous (render assertion carries it). |
| SC-13 | PLAUSIBLE-ONLY | Correct by reading; never run. |
| Slice D gaps 6-9 | REAL | `Inbox.test.tsx:614, :674, :700, :712`. |
| FILE rows (AD-3, AD-13, SC-19, slice G) | Filed | AD-3 geometry now measured. |

## 5. Looked for and did not find

- A save under another operator's key, after the sign-out clear, or from a
  reset: none (the wave changed no save path).
- A memo prop that changes identity each render (dead memo) or a memoized row
  that misses a patch: none.
- An AD-4 loop or chain, or a cursor crossing a filter or limit: none.
- A report dropped by the AD-5 drain: none by the IO registration rule.
- Behavior change in the wave's server edits: none (comments; a test constant).
- Non-ASCII bytes in the wave's added lines: 0.
- A consumer of `InboxRow` outside `Inbox.tsx` and its test: none (grep).
- An e2e or perf locator broken by the wave: none; the classifier and the
  profiler plan still match `DEFAULT_PAGE_LIMIT`.
- A new test that passes only through a mock hiding the real path: none (one
  vacuous assertion, section 2).
