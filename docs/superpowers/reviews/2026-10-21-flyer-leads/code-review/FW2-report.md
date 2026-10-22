# FW2 report - feat/flyer-leads (code review round 2 fix wave)

Findings only. Work list: the FIX / DOC / FILE rows of `adjudications.md`
"Round 2" (N1 label, N2, N4, F1, F2, F3, F4, the A3 issue). Base 2733dc84.

| Commit | Subject |
|---|---|
| a29e52aa | fix(app): Follow up labels a nameless contact by its formatted phone (flyer-leads R2 N1) |
| 8ea3ebdb | fix(dashboard): the flyer area line wraps a long token instead of overflowing the card (flyer-leads R2 N4) |
| 41b6f83a | fix(dashboard): a long milestone pin wraps instead of cutting the typed name (flyer-leads R2 F1, F2) |
| 86fdf53b | docs(issues): flyer-leads FW2 - correct the decline-click race window and what main did before; add the new-phone case (R2 F3, F4, N2) |
| a3d5cf21 | docs(issues): flyer-leads FW2 - offer the sign-up's web-form evidence when staff record consent (R2 A3) |

## F1 + F2 - what was built, and why these values

- `.pill` (`dashboard/src/routes/contact/Timeline.module.css:444-470`):
  `white-space: normal` with `min-width: 0` and `max-width: 100%` kept (QA-1:
  the pane still never grows past its column); `border-radius:
  var(--radius-lg)` (:450); `text-align: center` (:463). `.pillText`
  (:481-485) is `overflow-wrap: anywhere` only.
- `overflow: hidden` is NOT needed and was dropped: with `anywhere` nothing
  overflows sideways, and `anywhere` (unlike `break-word`) also counts its
  break points in the min-content size, so the span shrinks as a flex item
  without the scroll-container minimum `overflow: hidden` used to give it.
  Measured: cut 0 on every pin, a 75-character unbroken word included.
- Radius: a one-line pin measured 24 px tall (12 px text at line-height 1.5,
  2 px padding and a 1 px border each way), so 12 px (`--radius-lg`) keeps a
  one-line pin's round ends exactly, and a wrapped pin is a rounded box.
  `--radius-pill` would clamp to half the WRAPPED height (21 / 30 / 39 px at
  2 / 3 / 4 lines); from 3 lines on its curve passes inside the outer corners
  of the first and last line boxes (they start 13 px in and 3 px down; a
  30 px radius is 17 px in at that depth).
- Alignment: decided in the browser from a page-side preview (no source edit
  while the session ran): left-aligned wrapped pins read like inbound bubbles;
  centered lines read as a pin between its side rules. Pinned (RED shown on
  its own: `fw2-f1-align-red.log`).
- `MilestonePin` (`Timeline.tsx:493-511`) carries no `title` on either
  variant; a 4-line comment says why, so nobody re-adds it.
- `e2e/support/selectors.md:52` needs no change (it never named the title;
  the accessible name is still the label).

Real-browser measurements (hermetic `e2e:session`, lane 12; fixtures made
through the real routes: one tenant, three sign-ups - the e2e test's flyer pin
`Typed<stamp> Montgomery-Featherstonehaugh` (121 characters), a short /join
pin "Signed up on the join page as Ann Lee" (37), and a flyer pin whose typed
first name is one 75-character word (155)):

| Viewport | Pane | e2e pin | short pin | unbroken-word pin | Other |
|---|---|---|---|---|---|
| 1280x720 | 593 = column | 2 lines, 544x42, cut 0 | 1 line, 230x24, 12 px radius | 2 lines, cut 0 | Send hit-tests to Send; no title on any pin |
| 375x812 | 327 | 3 lines, 278x60, cut 0 | 1 line, 230x24 | 4 lines, 278x78, cut 0 | no sideways scroll in the stream or `<main>` |

Every pin lies inside its stream at both widths.

## Deviations from the brief

- The e2e "whole label is visible" check runs at 1280x720 AND again at 360px
  (`e2e/tests/dashboard-next/flyer-leads.spec.ts:558-565`, `NARROW_360` from
  `e2e/support/viewport.ts`), not at the default only: F1's worst case was
  phones (no flyer pin showed its name), and R2 asked for 1280 and a phone
  width. The test restores `WIDE_RESTORE` (1280x900), so its later Properties
  sent checks run at 1280x900 instead of 1280x720.
- The QA-1 precondition (the label span's `scrollWidth` exceeds the column)
  cannot hold once the label wraps. It now measures the label as ONE line in
  its own computed font on a canvas (`:535-543`), with a guard that the
  canvas took that font, so it holds on the ellipsis CSS (RED) and the wrap
  (GREEN) alike.
- (iii) is a module helper, `expectWholePinLabelVisible` (`:276-289`): the
  label span's `scrollWidth - clientWidth <= 1`, and the pin inside, side to
  side, the nearest ancestor whose `overflow-x` is not visible (the stream).
  Horizontal only: vertical visibility is a scroll position, not this defect.
  Soft, like (i) and (ii).
- N1: besides the OR-12 pin, the pre-existing last-heard-from case
  `app/test/followUps.test.ts:187` also pinned the raw E.164; both updated,
  and the new case (`:208`) pins AR13 parity with a NANP number (formatted)
  and a non-NANP one (as stored). No other test or e2e spec pins the raw
  label (`followUpsApi.test.ts` and `follow-up-tab.spec.ts` use named
  contacts).
- `docs/issues/public-signup-abuse-hardening.md`: the title now names both
  vectors (a known phone's contact, or made-up phones).

## Doc facts verified (F3, F4, N2, A3)

- One app process: `app/src/lib/events.ts:5-6`. On the Not interested path
  nothing is awaited between `at` (`units.ts:1596`) and `setDeclined`
  (`:1690`). The DynamoDB client sets no retry policy, so the SDK default
  retries apply (`app/src/lib/dynamo.ts:61-79`).
- Main (0f6f29f9) for an existing contact: `createOrGetByParticipantPhone(phone,
  'tenant_1to1')` and the welcome to one never welcomed
  (`app/src/routes/public.ts:376-411` there); its audit carried no
  `consentVersion`, so pre-branch `housing_fair_signup` rows lack it (named in
  the A3 issue).
- New phones: Today's Unreplied branch `app/src/routes/today.ts:809-841`
  (Today's untriaged pass reads `unknown` contacts only, so before the branch a
  new flyer TENANT with a read thread was not on Today); the Sent to filing
  `dashboard/src/routes/listing/listingFormat.ts:352`.
- A3 needs more than a modal option: the server refuses `web_form` from every
  staff path (`app/src/routes/contacts.ts:325-371`), so the issue
  (`docs/issues/consent-capture-ignores-signup-web-form.md`) suggests a
  server-stamped staff action from the audit row, after Cameron's compliance
  call on the consent-stamp / welcome pairing. Group-detection stubs are minted
  with no consent on purpose (`app/src/services/groupMembers.ts:100-125`), so
  they are in the affected class too.

## Runs (logs under `W:\tmp\flyer-leads\.superpowers\sdd\gates\`)

| Step | Log | Result |
|---|---|---|
| N1 unit RED | `fw2-n1-red.log` | 3 failed, 16 passed; `EXIT:1` - raw `+15550100042`, `+14045550123`, `+15550100077` where the formatted phone is expected (the non-NANP passthrough already held) |
| N1 unit GREEN | `fw2-n1-green.log` | followUps + followUpsApi: 2 files, 23 passed; `EXIT:0` |
| typecheck after N1 | `fw2-n1-typecheck.log` | `EXIT:0`, 0 `error TS` |
| N4 unit RED | `fw2-n4-red.log` | 1 failed, 5 passed; `EXIT:1` - `.area` has no `overflow-wrap: anywhere` |
| N4 unit GREEN | `fw2-n4-green.log` | FlyerPage styles + page: 2 files, 68 passed; `EXIT:0` |
| F1/F2 unit RED | `fw2-f1-unit-red.log` | 3 failed, 168 passed; `EXIT:1` - `.pill` not `white-space: normal`; radius `--radius-pill`; the link pin has a `title` |
| e2e C4 | `fw2-e2e-typecheck.log`, `fw2-e2e-eslint.log` | `EXIT:0`, `EXIT:0` |
| e2e RED, flyer-leads.spec.ts (lane 12) | `fw2-e2e-red.log` (+ `fw2-e2e-red-results/`) | 1 failed, 3 passed; `EXIT:1`. The existing-tenant test (`:425`) failed ONLY on (iii): "at 1280x720: the pin label is cut" Received 161, "at 360px: the pin label is cut" Received 442. Precondition, (i), (ii) and the stream bounds held |
| F1/F2 unit GREEN | `fw2-f1-unit-green.log` | 2 files, 171 passed; `EXIT:0` |
| alignment pin RED / GREEN | `fw2-f1-align-red.log`, `fw2-f1-unit-green2.log` | 1 failed, 3 passed, `EXIT:1` (no `text-align: center`); then 2 files, 171 passed, `EXIT:0` |
| visual sessions (lane 12) | `fw2-session.log`, `fw2-session-2.log`; stops `fw2-session-stop-1.log`, `fw2-session-stop-2.log` | ready lines logged; each `e2e:stop` `EXIT:0` (launcher stopped, lane tables dropped, lease released); the launchers' own `EXIT:1` is the stop |
| e2e GREEN, flyer-leads + stream-hidden-label-overflow + contact-detail + public-pages (lane 12) | `fw2-e2e-green.log` | 20 passed (contact-detail 8, flyer-leads 4, public-pages 7, stream-hidden-label-overflow 1); `EXIT:0` |
| typecheck before the F1 commit | `fw2-f1-typecheck.log` | `EXIT:0`, 0 `error TS` |
| `npm run issues` | `fw2-issues-1.log`, `fw2-issues-2.log` | `EXIT:0`, `EXIT:0` (648 total after the A3 file; INDEX.md gitignored, not committed) |
| dashboard full suite (`timeout 1200`) | `fw2-dashboard-suite.log` | 265 files, 5389 passed (5387 + the two new style pins); `EXIT:0` |
| eslint, FW2's 7 touched TS/TSX | `fw2-eslint.log` | `EXIT:1` on the one pre-existing `react-hooks/set-state-in-effect` at `Timeline.tsx:1625`; the pre-FW2 copy linted through stdin has the same error at `:1626` (`fw2-eslint-base-timeline.log`; MilestonePin is one line shorter). Nothing new |
| gate 5, branch-wide (69 files) | `fw2-eslint-gate5.log`, `fw2-eslint-gate5.norm` | `EXIT:1`, 3 errors, normalized IDENTICAL to `lint-base-1.norm` (Timeline.tsx x1, FlyerPage.tsx x2); 0 new |
| final typecheck on a3d5cf21 | `fw2-typecheck.log` | `EXIT:0`, 0 `error TS` |
| ASCII / backslash-u | - | 0 non-ASCII bytes in lines FW2 adds; `grep -cF '\u'` unchanged in every touched file (Timeline.tsx 2, pre-existing) |

No stack left running: after each C3 run and each session stop, lane 12's
four ports were free and no `e2e-session` / `playwright test` process for this
worktree remained (`e2e/.artifacts/session.pid` names dead launcher 49452).

## Screenshots

- `W:\tmp\flyer-leads\.playwright-mcp\fw2-pins-final-1280.png` - final CSS, 1280x720
- `W:\tmp\flyer-leads\.playwright-mcp\fw2-pins-final-375.png` - final CSS, 375x812
- `W:\tmp\flyer-leads\.playwright-mcp\fw2-preview-left-aligned-1280.png` - the wrap before `text-align: center`
- `W:\tmp\flyer-leads\.playwright-mcp\fw2-preview-centered-1280.png`, `fw2-preview-centered-375.png` - the page-side alignment preview
- RED failure: `W:\tmp\flyer-leads\.superpowers\sdd\gates\fw2-e2e-red-results\dashboard-next-flyer-leads-6097f-d-up-row-on-Properties-sent-chromium\test-failed-1.png`

## Risks and residuals

- The project Playwright MCP writes files only under the MAIN checkout
  (allowed roots: `W:\AI Projects\Housing Choice\HC Application`); the fw2
  screenshots were moved from its `.playwright-mcp\` to the worktree's. The
  MCP's own page-snapshot and console files from these sessions stay in the
  main checkout's gitignored `.playwright-mcp\`.
- The wrap applies to every `.pill` host (tour detail, placement
  conversation, relay view); their pins are short fixed labels (FWQA report)
  and stay one line. Only the contact page was measured.
- A wrapped pin no longer shows side rules (the pin takes the row) - as under
  QA-1's ellipsis; one-line pins keep them.
- `text-align: center` also applies to one-line pins: no visible change.
- Not in FW2's list and unchanged: OR-26 / OR-26b (Cameron), N3 (accepted),
  F5 (accepted), the final completion battery on HEAD (N5).
