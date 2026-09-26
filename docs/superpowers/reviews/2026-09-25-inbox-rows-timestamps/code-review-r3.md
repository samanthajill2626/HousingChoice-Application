# Code review round 3 - inbox rows + timestamps

Date: 2026-09-25. Branch `feat/inbox-rows-timestamps` @6024b619 (merge base
`main` @cd8e8ddd; round 2 reviewed e05c985f; fix wave 2 = fd64976d, afa482f0,
cdae0d97, report 6024b619). Reviewer: fresh, read-only on the tree. Inputs:
`code-review-r2.md`, `code-review-r2-adjudications.md`,
`fix-wave-2-report.md` (round-1 adjudications and the wave-1 report for
context), spec DRAFT 8.5 (5.2, 5.4, 5.5, 8), the diff `4a47fa35..6024b619`,
the live files.

Evidence method, stated once. (a) Row geometry measured in the desktop app's
browser pane (Chromium 152.0.7977.130, Windows 10, `system-ui` = Segoe UI)
with NO server, lane or suite: a plain https page (example.com) hosting
`srcdoc` iframes whose width IS the viewport, so the 767.98px query applies
natively. Each frame holds the live `InboxRow.module.css` (comments stripped,
class names unhashed), `tokens.css`, `index.css`, `.page`/`.rows` from
`Inbox.module.css`, a shell built from `AppFrame.module.css` (240px sidebar
at >=768, `main.content` padding 24px) and the exact row DOM of
`InboxRow.tsx:102-171`. At >=768 `main` is `overflow-y: scroll` (a 100-row
list always overflows; the Windows classic scrollbar takes 17px); below 768
there is no scrollbar (phones overlay theirs). Where it matters, the
no-scrollbar figure is given too. The tab was closed afterwards. Font metrics
vary by OS; the mechanisms do not. (b) The three touched unit files run alone
at HEAD: `InboxRow.test.tsx` 23/23, `Inbox.test.tsx` 59/59,
`useInbox.test.tsx` 62/62, exit 0 each. No throwaway test file was needed or
created; `git status` is clean apart from this report.

Summary: 1 MUST-FIX (R3-1, a regression the R2-2 fix itself introduced: short
tags are blanked, not ellipsized), 3 NOTEs; one adjudication challenged with
measurements (R2-2's chip split and R2-6); every wave-2 FIX row is REAL, R2-2
with the R3-1 regression.

## 1. New findings

### R3-1 MUST-FIX - the R2-2 rule does not ellipsize tags, it blanks them: Closed, Deleted and placement tags collapse to an 18px box showing one clipped letter

Where: `dashboard/src/routes/inbox/InboxRow.module.css:112-115` (`.tag`:
`min-width: 0; overflow: hidden; text-overflow: ellipsis; flex-shrink: 100`)
and `:139-142` (`.deletedTag`, the same), which style the relay Closed tag
(`InboxRow.tsx:118`), the placement tag (`:119`) and the Deleted tag
(`:121`). Spec 5.4 `spec:458-462`.

Mechanism: the head's width is fixed - min(content, 45%) at >=768 since
R2-1, the grid column below 768 (where `flex` is ignored but the head is
still a flex container). Inside the head the shortfall is shared in
proportion to flex-shrink x inner base size: a tag weighs 100 x its text
width, the name 1 x its own, so the tag takes ~99% of the shortfall until its
content box reaches the `min-width: 0` floor, freezes, and only then does the
name shrink. `overflow: hidden` clips at the padding box, so a frozen tag is
an 18px box (2 x 8px padding + borders) showing the clipped first glyph; the
ellipsis cannot fit and is not drawn. "Ellipsize before the name" therefore
holds only while the shortfall is smaller than the tag's own text width: 36px
for Closed, 42px for Deleted. R2-2's evidence was a long tag beside a 62px
name, where the margin sufficed. A typical name, or any relay row, exceeds it:
relay labels spell FULL member names (`app/src/lib/groupTitle.ts:110, :173`,
"With Dana Reed & Marcus Johnson").

Reproduction (measured as built; tag text px shown/full; 0 = the 18px box
with one clipped letter, screenshot-verified at 768 as "[D]", "[T]", "[C]",
"[A][D]"):

| Row | 360 | 390 | 414 | 768 | 900 | 1024 | 1100 | 1280 |
|---|---|---|---|---|---|---|---|---|
| Closed relay "With Dana Reed & Marcus Johnson": Closed | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 36/36 |
| Closed relay, three full names: Closed | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 | 0/36 (36/36 at 1440) |
| "Christopher Johnson" (unread): Deleted | 5/42 | 34/42 | 42/42 | 0/42 | 42/42 | 42/42 | 42/42 | 42/42 |
| Same name, placement "Touring" | 23/40 | 40/40 | 40/40 | 0/40 | 40/40 | 40/40 | 40/40 | 40/40 |
| Same name, "Awaiting receipt confirmation" | 24/156 | 54/156 | 78/156 | 0/156 | 59/156 | 114/156 | 148/156 | 156/156 |
| "Alexandria Montgomery", "Awaiting approval" + Deleted | 0, 0 | 0, 0 | 13, 6 | 0, 0 | 0, 0 | 38, 17 | 61, 27 | full |

For the two-member relay the Closed tag is blank below about 1140px and
clipped up to about 1220px (17px lower without a classic scrollbar); at 768
without one: Closed 0/36, Deleted 1/42. On `main` no tag ever shrank
(`git show cd8e8ddd:dashboard/src/routes/inbox/InboxRow.module.css:81-113`),
and in the round-2 state (R2-1 only) Closed and Deleted rendered whole at
every width measured. What the names gain is small, and the relay name is
ellipsized either way (768: relay name 97 vs 61 of 264px; Deleted row 138 vs
96 of 146px). No gate can see it: unit tests run `css: false`; the lean
world's relay is connecting, not closed, and cannot mint a placement tag
(`e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts:14-16, :31-33`); the
resurfacing spec checks Deleted at 1280, where it is whole
(`deleted-contact-resurfacing.spec.ts:100`); `toBeVisible` passes on an 18px
box.

Consequence: a relay's Closed state is unreadable in the inbox on laptops
below ~1140-1340px (by label length) and on phones; the danger-tinted Deleted
chip (`InboxRow.module.css:128-129`, "deleted, but they messaged you") and
stage labels are unreadable at the 768 band and on phones with ordinary
names. The adjudication's premise that R2-2 is "a visual change confined to
long-tag rows" (`code-review-r2-adjudications.md:16`) is false, and so is
spec 5.4's "ellipsize before the name" for these rows.

Smallest fix (both measured):
- (a) A floor per class: `min-width: 4em` in place of `min-width: 0` on
  `.tag` and `.deletedTag` (48px box, 30px of text: "Clo...", "Del...",
  "Tou...", "Aw..."). No tag below 30px anywhere measured. Names at 768:
  Deleted row 108/146, closed relay 67/264, 29-char tag row 109/140,
  Deleted + tag 52/173; at 360: 120/146, 84/264, 133/140, 76/173.
- (b) Yield only the unbounded label: move the shrink rules to a
  placement-only class on `InboxRow.tsx:119` with the same 4em floor, and
  leave Closed and Deleted rigid as on `main` (6-7 characters - the reason the
  adjudication gave for keeping `.channel`/`.triage` rigid). Closed and
  Deleted whole at every width; names at 768: 96/146, 61/264, 109/140,
  40/173; at 360: 107/146, 78/264, 133/140, 64/173.

Either way: amend spec 5.4 (name the Closed tag, state the floor), correct
the handback flag, and consider `title` on a truncated tag (the full stage
label is otherwise unrecoverable on hover). Pin: a source-reading test in the
style of `Inbox.styles.test.ts` that the tag rules carry a non-zero
`min-width`; optionally an e2e check at 768 on a resurfaced Deleted row with
a ~20-character name that the chip's `clientWidth` exceeds its horizontal
padding. The live self-QA should use the full profile (closed relay, deleted
contact, placement tags) at 768 and 360.

### R3-2 NOTE - spec text still false or stale after the wave

- `spec:463-465`: "The preview, the count and the time therefore always keep
  their room" - since R2-1 the preview is the item that absorbs the overflow
  (`spec:455-457`); measured down to 77px at 768. True for the count and the
  time only.
- `spec:458-462` names "the placement and Deleted tags"; the relay Closed tag
  is also `.tag` (`InboxRow.tsx:118`) and yields too; "ellipsize" per R3-1.
- `spec:3` (Status) cites only the round-1 refinements; R2-1 and R2-2 changed
  the row CSS Sam approved (spec 10), so `code-review-r2-adjudications.md`
  belongs there.
- `spec:1070-1084` (7.3 test 4) does not describe the 304-character pin
  (`inbox-rows-timestamps.spec.ts:289-299, :331-336, :342-344`); the
  implementer flagged it; still open.

### R3-3 NOTE - the committed fix-wave-2 report contradicts the history

`fix-wave-2-report.md:7-34, :96, :127` says "NOTHING COMMITTED", "hashes
pending" and that `npm run test -w @housingchoice/dashboard` was NOT RUN. The
three commits exist, and the messages of fd64976d and afa482f0 say the
orchestrator ran that suite and typecheck (exit 0) - with no counts, recorded
nowhere else. The mission record needs an addendum: the hashes, who
committed, and those gate runs with counts (AGENTS.md, "Mission reasoning is
version-controlled").

### R3-4 NOTE - `listShown` is a second copy of the `<ul>`'s condition

`Inbox.tsx:158-159` says "The <ul> below renders exactly when this is true",
but `:378` repeats `inbox.status === 'ready' && inbox.rows.length > 0`
instead of reading `listShown`. True today by duplication only; gate the
`<ul>` on `listShown` so the R2-3 key cannot drift from the element it waits
for.

## 2. Cold review of the three commits

**fd64976d (R2-1, R2-2, e2e).** `.head { flex: 0 0 auto }` is right: the
head's hypothetical size is min(max-content, 45%) and it never shrinks
further. Measured: a 160-character preview leaves "Tasha Nguyen" 95/95 at
768-1440 and an unknown number 108/108 at >=900 (69/108 at 768 is the 45%
cap, not the preview); the time stays inside the row for every row shape at
every measured width, and no head overflows its box. The `flex` change does
not touch the grid (<768; grid items ignore `flex`); the tag rule does,
because the head is still a flex container there (R3-1 at 360-414). The
`.tag`/`.deletedTag` rule fixes R2-2's case ("Awaiting receipt confirmation"
beside "Tasha Nguyen": name 95/95 at 360 and 768, tag 68 and 44 of 156px) and
introduces R3-1; its comment ("so it ellipsizes first and the name keeps its
width") holds only within the tag's text width and omits Closed. E2E: the
long body is minted before the page loads (no SSE dependency), in its own
block (7) per the header's rule; the WIDE_RESTORE check (`:344`)
discriminates E1 (a 304-character nowrap preview drives the name to ~0 under
`flex: 0 1 auto`); the 768 checks (`:335-336`) are `> 0` - as chartered and
discriminating E1 per the reported run, but a name cut to a few pixels would
pass; the long-name check at `:336` cannot fail under E1 (its preview is 11
characters) - a smoke check.

**afa482f0 (R2-3, R2-4).** `listShown` is exactly the `<ul>`'s render
condition, so the layout effect re-runs when the list appears after any state
that hid it: the error arm (R2-3), and the same shape through `loading` - a
Retry with nothing rendered sets `loading` (`useInbox.ts:496-502`), and a
loadMore page that resolves before that head read commits is not
reconcile-stale and commits rows under the spinner. Both were holes under
`[hasRows]`; both are closed. `listRef` is attached before layout effects
whenever `listShown` is true, and the root is resolved once per mount (the
container lives outside the route), so no transition needs a re-resolve.
`dayKey` is not destructured (`InboxRow.tsx:60-65`), so it cannot reach the
DOM; `React.memo`'s default shallow compare covers every passed prop, which
is why M4 survives at runtime. Nothing else must bust the memo: every tier
boundary is local midnight (`inboxTime.ts:52-59`), and the row reads nothing
outside its props but static CSS and router context, which `Link` consumes
itself. The render-time `new Date()` is not cached: `@vitejs/plugin-react`
runs without the React Compiler (`dashboard/vite.config.ts:60`). Tests: the
row pin (`InboxRow.test.tsx:295`) and the page pin (`Inbox.test.tsx:744`)
discriminate M2/M3 as reported; the page pin's mocked hook returns one state
object, which is a real situation (an observer report, a `loadingMore` flip
or an append re-renders Inbox with unchanged row objects).
`InboxRow.test.tsx:304` asserts the STALE label ("11:59 PM" after midnight) as
expected: it pins AD-1's memo, a perf property, by pinning a wrong label, so
a future row-level midnight fix must delete it - acceptable; its title says
so. The `vi.setSystemTime` calls do not leak: `dashboard/src/test/setup.ts:34-36`
re-pins before every test. The composed R2-3 pin (`useInbox.test.tsx:1385`)
never asserts its own precondition (that the page committed rows under the
alert); only the M1 run proves it - acceptable, the hook exposes no other
observable. The control (`:1421`) is independent: the store is cleared per
test (`useInbox.test.tsx:105-106`); jsdom keeps the root's `scrollTop` as a
plain property, which the control overwrites anyway.

**cdae0d97 (R2-7, R2-5, SC-9).** SC-9 (`useInbox.test.tsx:1340-1341`): after
a rollback nothing commits, so the unmount save is the only write that can
fold a stale `pendingRef` patch - the new assertion carries weight (M5); the
old one could not. Texts checked against the code: spec 5.5's cursor
(`inboxListMerge.ts:135`); spec 5.2 and `useAutoLoad.ts:18-23` (unobserve,
takeRecords and observe run in one synchronous turn, and the IO spec queues
entries only during a rendering update and only for registered targets -
true); spec 8's re-reading (`inboxListMerge.ts:156` disarms on a page with no
fresh row; each manual click re-walks one loaded page - true); spec 8's AD-2
addendum (`Inbox.module.css:11` - true); spec 5.4's `title` sentence (true);
the AD-15 paragraph (the complete head read shrinks the list to page one, the
browser clamps, the re-fetched page appends below her - true); the AD-3
numbers (match round 2, section 3); the R2-5 issue (accurate). Added lines in
the wave: 436, 0 non-ASCII.

**6024b619 (report).** R3-3.

## 3. Adjudication challenges

- **R2-2's chip split, with R2-6 deferred to the self-QA**
  (`code-review-r2-adjudications.md:16, :20`). The split kept `.channel` and
  `.triage` rigid because they "are short", while Closed (6 characters) and
  Deleted (7), equally short, were made to yield first - which is what blanks
  them (R3-1). Meanwhile the one chip that carries no per-row information
  stays whole: "Needs triage" is on every unknown-role row
  (`app/src/routes/inbox.ts:1114, :1173`) beside the amber unknown dot, and
  the number - the only per-row identity - is cut on EVERY unread unknown
  row, not an edge case: 59/108px at 360 ("(555) ..." - the area code only),
  89/108 at 390, 69/108 at 768 with a Windows scrollbar ("(555) 1...";
  75/108 without). Measured alternative: `.triage { min-width: 4em;
  overflow: hidden; text-overflow: ellipsis; flex-shrink: 100 }` gives the
  number 99/108 at 360 and 107/108 at 390 and 768, the chip 30-51px
  ("Nee..." / "Needs t..."). It remains Sam's call, but the evidence is
  complete now; the rule should be one rule (short fixed-vocabulary chips
  either all yield with a floor or all stay rigid), and the handback should
  carry these numbers rather than "worth an eye".
- **R2-2's handback flag, "a visual change confined to long-tag rows"**:
  false (R3-1).
- **`listShown` (R2-3) and `dayKey` (R2-4)**: agree. `dayKey` is the cheapest
  correct option (a custom comparator would re-implement `memo`'s shallow
  compare; a context would re-render the same rows); it fixes consistency
  within the list only, and the filed midnight issue still stands.
  `listShown`: agree, with R3-4.

## 4. Per-FIX-row verdicts

| Row | Verdict | Evidence |
|---|---|---|
| R2-1 | REAL | `InboxRow.module.css:77`; measured (section 2); e2e `:344` discriminates E1 (reported run; reading agrees). |
| R2-2 | REAL for the name; introduces R3-1 | The name no longer reaches 0 beside a long tag (95/95 at 360 and 768); short tags are blanked. |
| R2-3 | REAL | `Inbox.tsx:159, :169, :176`; also closes the `loading` variant; the pin discriminates M1. |
| R2-4 | REAL | `Inbox.tsx:214, :384`; no DOM leak; no compiler caching; the pins discriminate M2/M3. |
| R2-5 (FILE) | Filed, accurate | `docs/issues/inbox-time-formatters-pin-time-zone-at-load.md`. |
| R2-7 | REAL | All five texts now true (section 2). |
| SC-9 rollback pin | REAL | `useInbox.test.tsx:1340-1341`; M5. |
| AD-2 addendum | REAL | `spec:1133-1136`. |
| AD-3 geometry | REAL | The issue's `:19-20, :35-39` match round 2. |
| R2-6 (NOTE) | Untouched; challenged | Section 3. |
| SC-13 | Reported executed (runs 1 and 4) | Not re-run here (e2e is outside this review's remit). |

## 5. Looked for and did not find

- A time clipped, or a head overflowing its box, for any row shape (contact
  with and without chips, unknown with Needs triage, closed relay, group text,
  Deleted, placement, long name, unread with a count) at 360, 390, 414, 768,
  900, 1024, 1100, 1280 and 1440: none.
- A state that renders the `<ul>` without re-running the scroll-root effect,
  or one where `listShown` is true and `listRef` is null: none.
- `dayKey` reaching the DOM, or another input that must bust the memo: none.
- A React Compiler caching the render-time `new Date()`: none.
- A mocked clock or store leaking between the new tests: none.
- Another consumer of `InboxRow` or `InboxRow.module.css`: none (only
  `InboxRow.tsx` imports the module).
- A locator collision from the block-7 mint, or a strict-mode risk in the new
  e2e locators: none.
- A new pin that passes only through a mock hiding the real path: none.
- Non-ASCII in the wave's added lines: 0 of 436.
- A red touched unit file at HEAD: none (23, 59, 62, each alone).
