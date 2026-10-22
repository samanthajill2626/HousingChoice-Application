# FWQA report - feat/flyer-leads (self-QA fix wave, QA-1)

Findings only. Commit: `a150db6b` (the fix and its tests, one commit: a
tests-only commit would have left the branch red). The root cause is exactly
as self-qa.md QA-1 states; the fix is the probe it ran:
`dashboard/src/routes/contact/Timeline.module.css:13` (`.comms` min-width: 0)
and `:454-455` (`.pill` min-width: 0, max-width: 100%), and `title={ms.label}`
on both pill variants at `dashboard/src/routes/contact/Timeline.tsx:502,506`.

## What the tree held that the finding did not say

1. More than Send was covered. The e2e RED failure screenshot
   (`.superpowers/sdd/gates/fwqa-e2e-red-results/`) also shows the comms
   header's All / Comms only filter hidden under the right column: `.seg`
   (`Timeline.module.css:43`) sits at the header's right end by
   `margin-left: auto`, so every control pinned to the pane's right edge went
   under. Same cause, same fix; no assertion pins the toggle (seen in the
   screenshot only).
2. Why the right column wins: `.right` is `position: relative`
   (`dashboard/src/ui/twoPaneShell.module.css:73`) and later in DOM order, so
   it paints over the comms pane's in-flow overflow - the reply box is not
   positioned. The overflow is covered rather than visible on top.
3. Overflow per character matches the finding: the e2e pin (121 characters)
   put the pane's right edge 160 px past its column at 1280x720 (finding: 238
   px at 140 characters) - about 5.4 px per character at the pin's font size.

## Other pages the Timeline CSS reaches

- Relay group view: `.comms` is a direct child of the shell's `.left` ROW
  (`dashboard/src/routes/conversation/ConversationDetail.tsx:480`) - the same
  exposure, now closed. Relay threads carry no milestone pins.
- Tour detail and placement detail (Conversation pane): `.comms` is a ROW
  flex item of `.channelPane`
  (`dashboard/src/routes/tours/TourDetail.module.css:157`, `display: flex`
  with no min-width; used at `tours/TourConversation.tsx:218` and
  `placements/PlacementConversation.tsx:219`) - the same exposure, now closed
  by the `.comms` rule. In practice no long pin reaches them: tour pins are
  tour-activity labels (`tours/tourActivityFormat.ts`, fixed strings, longest
  57 characters at `:26`) and placement threads interleave no milestones
  (`placements/PlacementConversation.tsx:36-39`).
- Group text view: `.comms` is a COLUMN flex item of `.groupLeftStack`
  (`conversation/ConversationDetail.module.css:228`, already min-width: 0;
  `conversation/GroupTextView.tsx:403`), where the new `.comms` rule is a
  no-op.
- `contact/ScheduledCard.tsx` imports the module for `.scheduled*` classes
  only: untouched.
- The stacked (<=860px) shell keeps `.left` a ROW flex container (its media
  query flips only `.body`), so the rule applies at phone width too. Not
  measured.
- The `.pill` rule applies to every milestone pin in every host; short pins
  are unchanged (they never reach the row's width).

## Deviations from the brief

- (ii) is `locator.evaluate` on the Send button - `getBoundingClientRect` and
  `document.elementFromPoint` at its centre in ONE page-side call - rather than
  `page.evaluate` with a separately read `boundingBox()`; same check, no gap
  between measuring and hit-testing, and a miss names what is on top
  (`e2e/tests/dashboard-next/flyer-leads.spec.ts:514-523`).
- (i)-(iii) are `expect.soft` (`:511-524`) so one run reports all three
  symptoms of the one defect - the first soft assertions under e2e/tests.
- Added a precondition (`:508-509`): the label span's `scrollWidth` (its full
  text width, cut or not) exceeds the column width, so (i) and (ii) cannot
  pass vacuously if the label or the viewport changes. It held in RED and
  GREEN.
- The styles test (`dashboard/src/routes/contact/Timeline.styles.test.ts`)
  also pins the pre-existing `.pill` nowrap and `.pillText` overflow /
  ellipsis (a PIN, green at RED); the file header's case 2 gained a QA-1
  clause. The typed last name is `Montgomery-Featherstonehaugh` (`:463`, 28
  characters).

## Runs (logs under `W:\tmp\flyer-leads\.superpowers\sdd\gates\`)

| Step | Log | Result |
|---|---|---|
| unit RED | `fwqa-unit-red.log` | 3 failed, 1 passed (the pin), 166 skipped; `EXIT:1`. Fails: `.comms` has no min-width 0; `.pill` has no min-width 0; the link pin has no `title` |
| e2e C4 | `fwqa-e2e-typecheck.log`, `fwqa-e2e-eslint.log` | `EXIT:0`, `EXIT:0` |
| e2e RED, flyer-leads.spec.ts only (lane 12) | `fwqa-e2e-red.log` (+ `fwqa-e2e-red-results/`) | 1 failed, 3 passed; `EXIT:1`. The existing-tenant test (`:400`) failed on exactly (i) `Received 1017.83`, `Expected <= 857.67`; (ii) the Send centre hit `<section class="_card_1isu3_4">` (a right-column card); (iii) `title` absent. Precondition held |
| unit GREEN | `fwqa-unit-green.log` | 2 files, 170 passed; `EXIT:0` |
| e2e GREEN, flyer-leads + stream-hidden-label-overflow + contact-detail (lane 12) | `fwqa-e2e-green.log` | 13 passed (contact-detail 8, flyer-leads 4, stream-hidden-label-overflow 1); `EXIT:0` |
| `npm run typecheck` | `fwqa-typecheck.log` | `EXIT:0`, 0 `error TS` |
| eslint, 4 touched TS files | `fwqa-eslint.log` | `EXIT:1` on the one pre-existing `react-hooks/set-state-in-effect` at `Timeline.tsx:1626` - the same error at `:1621` in HEAD's copy (stdin baseline lint); MilestonePin adds 5 lines above it. Nothing new |
| dashboard full suite (`timeout 1200`) | `fwqa-dashboard-suite.log` | 265 files, 5387 passed; `EXIT:0` |
| ASCII / backslash-u | - | 0 non-ASCII bytes in the new file and in added lines; `grep -cF '\u'` unchanged on all five files (Timeline.tsx 2, pre-existing) |

No stack left running: each C3 launcher left `e2e/.artifacts/session.pid`
(25608 after RED, 5072 after GREEN), both dead by `tasklist`; lane 12 and
lane 13 ports were free after each run.

## Risks and residuals

- Touch has no hover, so on a phone the `title` cannot show a cut label. A
  link pin still leads to the property, but a cut PLAIN pin (/join, or a flyer
  for a property that cannot be shared) cannot show its end - the typed name -
  at phone width. Not fixed (outside QA-1's scope).
- `e2e/support/selectors.md:52` (the sign-up pin row) needs no change: the
  accessible name is still the label text, and the title equals it.
