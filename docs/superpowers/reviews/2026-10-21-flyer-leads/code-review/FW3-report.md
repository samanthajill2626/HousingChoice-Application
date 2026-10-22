# FW3 report - feat/flyer-leads (code review round 3 fix wave)

Findings only. Work list: the FIX / DOC rows of `adjudications.md` "Round 3"
(R3-1 to R3-5) and "Round 2 PLAUSIBLE items" (P-a, P-c). Base a9f28b87.

| Commit | Subject |
|---|---|
| 88a686f5 | test(dashboard,e2e): the milestone pin checks catch a hidden typed name again (flyer-leads R3-1) |
| c0b6b501 | fix(dashboard): the milestone pin keeps its ink inside its box, and its radius scales with its font (flyer-leads R3-3, R3-5) |
| 53168bf2 | docs(issues): flyer-leads FW3 - the new-phone bound, the typed-name layout and ink residuals, ledger contention, and the consent gap that predates the branch (R3-2, R3-3, R3-4, R2 P-a, P-c) |

## R3-1 - the hardened checks, and what each mutant shows

- e2e `expectWholePinLabelVisible`
  (`e2e/tests/dashboard-next/flyer-leads.spec.ts:272-312`, called at `:581`
  for 1280x720 and `:587` for 360px) keeps FW2's two checks and adds two, all
  soft: the label span's box inside the pin's border box on all four sides
  (`inside`, `:296`; tolerance 1 px, `:304-309`), and the stream's own
  `scrollWidth - clientWidth <= 1` (`:299`, `:311`) on the box the helper
  already finds as the pin's nearest ancestor whose computed `overflow-x` is
  not visible.
- Styles pins (`dashboard/src/routes/contact/Timeline.styles.test.ts`):
  `NOWRAP` (`:25`) matches `white-space`, `text-wrap` and `text-wrap-mode` set
  to `nowrap`; it now guards `.pill` (FW2's check, widened) and `.pillText`
  (new, `:62-65`). `.pill` declares neither `height` nor `max-height` (`:64`).
  R3 finding 1's nit is fixed (the header said the e2e measures 1280x720
  only).

| Mutant | Base | RED | Log |
|---|---|---|---|
| mutA: `white-space: nowrap` on `.pillText`, applied to the real CSS, then restored (`git diff` 0 bytes) | FW2 CSS (a9f28b87) | 1 failed / 3 passed. The existing-tenant test failed ONLY on the two new checks: label right inset -148.16 at 1280x720 and -428.83 at 360px; stream sideways 124 and 405 px. FW2's cut and pin-in-stream checks and the QA-1 checks held, as R3 measured | `fw3-e2e-mutA-red-2.log` (+ `-results/`), `EXIT:1` |
| mutB: `max-height: 24px` on `.pill` (which already clips), real CSS, restored (0 bytes) | final CSS (c0b6b501) | 1 failed / 3 passed. Only the four-side check: top and bottom -6 at 1280x720, -24 at 360px | `fw3-e2e-mutB-red.log` (+ `-results/`), `EXIT:1` |
| mutA again, real CSS, restored (0 bytes) | final CSS (c0b6b501) | 1 failed / 3 passed. Only the four-side check: right -148.16 / -428.83. The stream no longer scrolls sideways, because the pin now clips its label | `fw3-e2e-mutA-final-red.log` (+ `-results/`), `EXIT:1` |
| styles: mutA; mutAtw (`text-wrap-mode: nowrap` on `.pillText`); mutB (`max-height: 24px; overflow: hidden` on `.pill`); mutBh (`height: 24px` on `.pill`) - scratch COPIES of the CSS, each beside a copy of the styles test, directory deleted after | FW2 CSS | 4 files failed, each ONLY on "the label itself never stops wrapping, and the pin has no height cap" (4 failed, 16 passed) | `fw3-r31-styles-mutants-red.log`, `EXIT:1` |

## R3-3 + R3-5 - what was built, and the browser check

- `.pill` (`dashboard/src/routes/contact/Timeline.module.css:444-476`):
  `border-radius: calc(0.75em + 3px)` (`:451`, comment `:445-450`) and
  `overflow: hidden` with no height cap (`:467-471`). Pinned at
  `Timeline.styles.test.ts:71-73` and `:84-88`.
- Browser (hermetic `e2e:session`, lane 12, the dashboard served in dev mode
  with the change uncommitted; fixtures through the real routes: one tenant
  with the e2e test's flyer pin, 121 characters, and a /join pin whose typed
  name carries descenders and stacked Vietnamese diacritics, U+1EC5 and
  U+1ED6, 41 characters):

| | 1280x720 | 360x800 |
|---|---|---|
| Flyer pin (link) | 2 lines, 543.67x42; label inset 13 / 13 / 3 / 3 | 4 lines, 263x78; inset 13 / 13 / 3 / 3; the stream (311 px) sideways 0 |
| /join pin | 1 line, 261.59x24, radius 12px | the same |
| Pixels in the pin box plus 12 px, served CSS vs an inline `overflow: visible` | identical for both pins | identical for both pins |

- Positive control (runtime text only, no source edit): the /join label set
  to "T" plus 60 combining marks. The pin stays 24 px tall and the clip
  changes pixels: with the served CSS the stack smears only inside the pin;
  without it, it paints over the flyer pin above and the space below.
- Focus: after a key press, `focus()` on the wrapped flyer pin matches
  `:focus-visible`, the outline computes `solid 2px`, offset `2px`, its
  pixels differ from the blurred pin, and the ring shows on all four sides.
- R3-5: a one-line pin at a root font of 16 / 18 / 20 / 24 px is 24 / 26.25 /
  28.5 / 33 px tall, with a radius of 12 / 13.125 / 14.25 / 16.5 px: exactly
  half at every size (at 18 px and up the old fixed 12 px lost the round
  ends).

## Docs - every new ref re-read in the live tree (main 0f6f29f9 where named)

- `docs/issues/public-signup-abuse-hardening.md`:
  - R3-2: the new-phone bound now reads: the per-IP `/public` limiter only
    (`app/src/app.ts:185-191`); the welcome-text cap, as filed, holds back
    only the welcome while "the sign-up is still captured"
    (`public-welcome-text-global-cap.md` Suggested fix).
  - R3-3 (point 2 (a)): interior spacing characters survive `trim()` and do
    not collapse, so a run of em spaces puts typed text on its own line (R3's
    84-character "STAFF NOTE" probe); forced breaks do not break; the
    combining-mark stack is now contained by the pin (`Timeline.module.css:467-471`),
    with the unclipped inbound bubble as the pre-existing class
    (`Timeline.module.css:220-256`: `.bubble` / `.body`, no overflow clip).
  - P-a (new point 5): every pair-row write runs `applyLedgerLoop`
    (`app/src/services/shareLedger.ts:205-224`, `MAX_REAPPLY` 3 at `:50`);
    broadcast writers `app/src/jobs/broadcastFanOut.ts:1270` and
    `app/src/services/shareAttemptOutcome.ts:188`, the flyer writer
    `app/src/routes/public.ts:696`; healed by
    `app/scripts/repair-share-outcomes.ts` (broadcast slots only, per the
    flyer `lostLine`, `shareLedger.ts:286-287`).
  - R3-3 + P-c (Suggested fix): normalize before the checks at
    `public.ts:209-216` (`parseHousingFairBody` `:197`): control and bidi,
    format (Cf) characters such as U+200B, U+200C, U+200D and U+2060 (not
    removed by `trim()`), whitespace runs to one U+0020, a combining-mark cap.
  - Frontmatter refs gained the six new code refs; the intro names round 3.
- `docs/issues/consent-capture-ignores-signup-web-form.md` (R3-4): the gap
  predates the branch - main's existing-contact path read only
  `housing_fair_welcomed` (`0f6f29f9:app/src/routes/public.ts:324-329`) and
  wrote only that flag (`:399`), the #14 rule (spec
  `2026-10-21-flyer-leads-design.md:238-240`, citing D6 of
  `2026-10-12-join-housing-authority-design.md`, which exists); the branch
  adds visibility (the pin and the unread mark).

## Runs (logs under `W:\tmp\flyer-leads\.superpowers\sdd\gates\`)

| Step | Log | Result |
|---|---|---|
| styles mutants RED (4 scratch copies) | `fw3-r31-styles-mutants-red.log` | 4 files failed, 4 failed / 16 passed; `EXIT:1` |
| styles GREEN on the real CSS | `fw3-r31-styles-green.log` | 1 file, 5 passed; `EXIT:0` |
| e2e C4 | `fw3-e2e-typecheck.log`, `fw3-e2e-eslint.log` | `EXIT:0`, `EXIT:0` |
| e2e mutA RED, first attempt | `fw3-e2e-mutA-red.log` | aborted at startup, no test ran; `EXIT:1` (see Risks) |
| clear stale session state | `fw3-stale-state-stop.log`, `-2` to `-6` | each "no running session found"; `EXIT:0` |
| e2e mutA RED (FW2 CSS) | `fw3-e2e-mutA-red-2.log` | 1 failed / 3 passed; `EXIT:1` (above) |
| e2e GREEN after R3-1 | `fw3-e2e-r31-green.log` | flyer-leads 4 passed; `EXIT:0` |
| typecheck before 88a686f5 | `fw3-r31-typecheck.log` | `EXIT:0`, 0 `error TS` |
| styles RED for R3-3 / R3-5 | `fw3-r33-r35-styles-red.log` | 2 failed / 4 passed (no `overflow: hidden`; radius `var(--radius-lg)`); `EXIT:1` |
| Timeline styles + Timeline.test GREEN | `fw3-r33-r35-unit-green.log` | 2 files, 173 passed; `EXIT:0` |
| all eight Timeline test files | `fw3-timeline-files-green.log` | 8 files, 306 passed; `EXIT:0` |
| visual session (lane 12) | `fw3-session.log`, stop `fw3-session-stop.log` | ready line logged; the stop `EXIT:0` (launcher stopped, lane 12 tables dropped, lease released); the launcher's own `EXIT:1` is the stop |
| e2e GREEN, flyer-leads + stream-hidden-label-overflow + contact-detail | `fw3-e2e-green.log` | 13 passed (contact-detail 8, flyer-leads 4, stream-hidden-label-overflow 1), 0 unexpected, 0 flaky; `EXIT:0` |
| typecheck before c0b6b501 | `fw3-r33-typecheck.log` | `EXIT:0`, 0 `error TS` |
| e2e mutB RED (final CSS) | `fw3-e2e-mutB-red.log` | 1 failed / 3 passed; `EXIT:1` (above) |
| e2e mutA RED (final CSS) | `fw3-e2e-mutA-final-red.log` | 1 failed / 3 passed; `EXIT:1` (above) |
| dashboard full suite (`timeout 1200`) | `fw3-dashboard-suite.log` | 265 files, 5391 passed (5389 + the two new pins); `EXIT:0` |
| `npm run issues` | `fw3-issues.log` | 648 total; `EXIT:0` (INDEX.md gitignored, not committed) |
| eslint, FW3's two touched TS files | `fw3-eslint.log` | `EXIT:0`, no errors (Timeline.tsx not touched) |
| final typecheck on 53168bf2 | `fw3-typecheck.log` | `EXIT:0`, 0 `error TS` |
| ASCII / backslash-u | - | 0 non-ASCII bytes in added lines of all six touched files (both issue files fully ASCII); `grep -cF` backslash-u 0 in each, as at HEAD |

No stack left running: no `e2e/.artifacts/session.pid`, lane 12's four ports
free, and no node / cmd process names this worktree except the
orchestrator's transcript tail.

## Deviations from the brief

- The stream check does not call `expectNoHorizontalOverflowIn`
  (`e2e/support/viewport.ts`): it takes a Locator and asserts HARD, while
  the stream has no role, name or test id (selectors.md rule 5) and the
  helper's checks beside it are soft by design (one run reports both
  widths). The same measure (`scrollWidth - clientWidth <= 1`) is taken on
  the box the helper already finds by computed overflow; the comment says
  so.
- The styles pins are a little wider than listed: `NOWRAP` also matches the
  CSS Text 4 spellings, and the height-cap pin also forbids `height` (with
  `overflow: hidden` on `.pill`, either cap hides lines).
- Two e2e mutant runs beyond the one required (mutB, and mutA on the final
  CSS), so each new e2e check is shown RED on the CSS it now guards.
- `npm run e2e:stop` ran before every C3 run and the session, to clear the
  stale `session.pid` each Playwright-managed run leaves (stale branch only:
  it deletes state when the recorded pid is dead and kills nothing).

## Risks and residuals

- HARNESS HAZARD (recommend FILE): the first mutA run died at startup. Battery
  2's dead launcher pid 48356 was still in `e2e/.artifacts/session.pid`;
  `tasklist` showed it dead, but at run time the config's `liveSessionLane()`
  (`e2e/playwright.config.ts:26-42`) found that pid alive ("reusing the live
  e2e:session on lane 12") and `scripts/e2e-session.mjs:717-726` then ran
  `killTree(48356)`; the log ends at "reaping stale session launcher" with no
  test run, which fits Windows having reused the pid inside this run's own
  process tree. The same path can kill an UNRELATED process that reused the
  pid. Nothing in `docs/issues/` names it.
- On the final CSS a label-only overflow no longer scrolls the stream (the
  pin clips it), so the four-side check alone catches mutA there; the stream
  check still guards anything else in the stream that runs wide.
- Pins on the other `Timeline` hosts (tour detail, placement and relay views)
  were not measured; their labels are short fixed strings (as in FW2).
- Not done (not in the list): R3 finding 2's optional stale refs in
  `public-welcome-text-global-cap.md` (`app.ts:165`, `rateLimit.ts:81`).
- Unchanged and not FW3's: OR-26 / OR-26b (Cameron), N3, F5 and P-b
  (accepted), the final completion battery on HEAD.

## Screenshots (W:\tmp\flyer-leads\.playwright-mcp\)

- `fw3-pins-1280.png`, `fw3-pins-360.png` - the long flyer pin and the short
  /join pin, final CSS.
- `fw3-pin-focus-1280.png` - the focused wrapped link pin, device scale.
- `fw3-control-combining-clipped.png`, `fw3-control-combining-unclipped.png`
  - the positive control with and without the clip.
- `fw3-mcp-*` - the MCP's own page snapshots and console logs from this
  session, moved here from the main checkout's `.playwright-mcp\`; the
  screenshots were written here directly.
