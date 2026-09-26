# Code review round 2 - adjudications and the fix-wave-2 charter

Date: 2026-09-26. Branch `feat/inbox-rows-timestamps`, reviewed @e05c985f by a
fresh reviewer (`code-review-r2.md`) briefed with the round-1 reports, the
round-1 adjudications and the fix-wave-1 report. The reviewer measured row
geometry in a real Chromium with the shipped CSS inlined.

Adjudicator: the build orchestrator. Same rule as round 1: FIX when confirmed
against the spec's intent (the spec's letter can be the bug - fix on-branch
and record it); REJECT when it contradicts a human-ruled trade-off; FILE when
out of scope; NOTE otherwise.

| # | Sev | Decision | Rationale |
|---|---|---|---|
| R2-1 | MUST-FIX | FIX (spec bug) | `.head { flex: 0 1 auto }` (spec 5.4's own CSS) lets the preview's overflow shrink the name: measured 24/95 px at 1280 with a 300-char message, 0/95 for an email body at every width, 0/108 on a 768 unknown row - a regression from `main` (`flex: 0 0 auto`) on the primary surface, and it contradicts spec 5.4's own claim that an ordinary name is never ellipsized. Fix: `.head { flex: 0 0 auto; min-width: 0; max-width: 45% }` - the head is min(content, 45%) and never shrinks further; the preview absorbs the rest; a genuinely long name still ellipsizes under the cap (measured: 50-char name 401/407 at 1280). Amend spec 5.4; pin in e2e test 4 with a ~300-character inbound (name not ellipsized at WIDE_RESTORE; the stub row's name has `clientWidth > 0` at 768). |
| R2-2 | SHOULD-FIX | FIX (spec refinement) | Chips never yield, so a long placement tag ("Awaiting receipt confirmation", 29 chars) erases the name at 768 (0/62) and on phones (0-6/62) and overprints the preview. Spec 5.4 said tags never shrink; the row's identity is the name, and the spec deferred exactly this row shape to the live self-QA. Fix: `.tag` and `.deletedTag` get `min-width: 0; overflow: hidden; text-overflow: ellipsis; flex-shrink: 100` so they yield BEFORE the name (measured with R2-1: 768 name 62/62, tag 101/172; 360 name 62/62, tag 118/172). `.channel` and `.triage` stay nowrap (short, and the triage chip is a stated affordance) - see R2-6. Amend spec 5.4; flagged in the handback as a visual change confined to long-tag rows. |
| R2-3 | NOTE (contests AD-12) | FIX (small) | Reproduced: an empty page with a cursor, Load more in flight, an SSE head read fails (no rows rendered -> `error`, no `firstPageGen` bump), the page commits rows into the error list; the scroll-root effect keyed on `[hasRows]` ran while the `<ul>` was absent and never re-runs after Retry, so that mount has no scroll listener (back returns to the top) and the observer root is null. Rare and self-healing, but the fix is one condition: key the effect on the list being rendered (`status === 'ready' && rows.length > 0`). Pin it with the reviewer's reproduction (scroll to 250 after Retry, unmount, the snapshot holds 250). AD-12's "unreachable" is withdrawn. |
| R2-4 | NOTE | FIX (small) | `React.memo` makes the midnight rollover inconsistent within one list (an appended page labels "Yesterday" while memoized rows above keep clock times). Fix: `Inbox.tsx` passes a `dayKey` prop (`new Date().toDateString()`, computed once per Inbox render) to `InboxRow` so the memo invalidates on a day change at no per-render cost; `InboxRow` keeps computing `now` at render. Pin: rerendering a row with a new `dayKey` recomputes its label (pin the clock with `vi.setSystemTime` across a local midnight). Spec 4.2 and the filed midnight issue stay true. |
| R2-5 | NOTE | FILE | The module-level formatters resolve the time zone once at load; after an OS zone change mid-session the tier follows the new zone and the text the old one until a reload. Filed as `inbox-time-formatters-pin-time-zone-at-load` (low, debt). |
| R2-6 | NOTE | NOTE (human's eye) | An unknown row's number - its identity - is ellipsized at 360 (59-93 of 108 px depending on the time column) and at 768 under the 45% cap with the Text + Needs triage chips (75/108 after R2-1). Follows spec 5.4's letter; whether the "Text" or "Needs triage" chip should yield before the number is Sam's call. Measured in the live self-QA and surfaced in the handback. |
| R2-7 | NOTE | FIX (text) | Make the texts true: the AD-15 paragraph in `inbox-loaded-pages-survive-refresh.md` (a reader parked past page one is returned to the bottom of page one on every event - the visible cost spec 8 states; only a reader near row 100 sees nothing); spec 5.5's cursor definition (after AD-4 a null cursor takes the read's cursor, which continues after `P`); spec 5.2 and `useAutoLoad.ts:18-21` (the drain and the re-observe are synchronous, so the default factory leaves no residual); spec 5.4's `title` sentence (the tooltip is unreachable on rows that offer an action - AD-3, filed); spec 8's "re-reading at most one page" (true for auto-load, which disarms on an all-duplicate page; a manual Load more through an N-page list re-walks up to N-1 pages). |
| SC-9 rollback pin | NOTE | FIX (trivial) | The store assertion at `useInbox.test.tsx:1336` is vacuous (the head read wrote the store before the patch); replace it with an assertion that carries weight (the store's row still shows the pre-patch count after the rollback settles) or drop it. |

Adjudication challenges from round 2: AD-2 REJECT - the reviewer agrees
(and adds a cost missing from spec 8: any notice or banner toggling above
the list shifts the list, since nothing anchors - add that sentence to spec
8). AD-4 ACCEPT - agrees; text corrections in R2-7. AD-3 / AD-13 FILE -
agrees; the AD-3 geometry is now measured (overlay 85.6-99.6 px wide, 12 px
inside the right edge, covering the time on every row measured) - add the
numbers to the filed issue. AD-12 - withdrawn (R2-3).

Fix-wave-1 verdicts: every FIX row REAL except AD-15 (text, fixed under
R2-7) and SC-13 (Playwright assertions never executed - wave 2 runs the spec
against a session lane, and the final full e2e gate runs it again).

## Wave 2 scope summary

Production: `InboxRow.module.css` (R2-1, R2-2), `Inbox.tsx` (R2-3 effect
key, R2-4 `dayKey` prop), `InboxRow.tsx` (R2-4 prop), `useAutoLoad.ts`
header text. Spec: 5.4 (two rules + the title sentence), 5.5, 5.2, section 8
(two sentences). Tests: the e2e pin in test 4 (run against a session lane),
the R2-3 and R2-4 unit pins, the SC-9 assertion. Docs: the AD-15 paragraph,
the AD-3 issue numbers, one new issue (R2-5). Re-review of the wave-2 diff
by a fresh reviewer; then the single main sync and the full gate battery on
the final commit.
