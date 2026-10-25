# FW5 report - feat/today-checklist (tracker #31), fix wave 5

Implementer: the FW5 child (Claude Opus 5.5), 2026-10-25. Scope: exactly
FW5-1 of `FW5-scope.md` (long names cut at a narrow pane). Base 50058b44.
Commits: 69a01770 (the CSS rule + its e2e pin), then this report. RED first
on the old CSS through `.superpowers/s7/run-spec.sh`, then GREEN. No app,
seed or dependency change.

## The CSS change

`dashboard/src/routes/today/Today.module.css:302-312`, inside the existing
`@container (max-width: 560px)` block, after `.why`:

    .who {
      flex-shrink: 1;
      white-space: normal;
      overflow-wrap: anywhere;
    }

Nothing outside that container query changed. In the wide layout (pane over
560px) the name stays on one line and the reason keeps its ellipsis.

What the rule reaches (every element with `.who`):
- Item rows (`Row`, Today.tsx:119-152): Needs you now, Identify these
  contacts, Tours to book, Placements, and the AI suggestions list. These sit
  in `.row > .main` (a column flex container at this width), which gives
  `.who` a fit-content width, so `white-space: normal` is what makes the name
  wrap.
- Quiet shares person rows (`PersonRow`, QuietShares.tsx:67-93): the same
  structure, the same reason.
- At a glance, Tours today compact rows (`CompactTourRow`, Today.tsx:371-391):
  YES, they had the bug too, and wrapping alone does not fix them.
  `.compactRow` is a ROW flex container that clips nothing, and `.who` was
  `flex: 0 0 auto`, so the name kept its unwrapped width and ran out of the
  card. RED measured it 34.2px past the row, with the routed `<main>`
  scrolling sideways by 10px. `flex-shrink: 1` lets the name shrink to fit
  its line. `overflow-wrap: anywhere` (unlike `break-word`) also lowers the
  min-content size, so the automatic min-width does not block that shrink.
- Also affected, not measured: the relay close-nag card's `.who` (the pool
  phone number) can now wrap in its narrow column; past-tour rows already
  wrap at <= 760px (`.pastRow .who`, which beats this rule on `flex`), so
  they only gain `overflow-wrap: anywhere`.

## The e2e pin (today-checklist.spec.ts)

- New test :594 "phone width: a long name shows in full on a Quiet shares
  row, a Tours to book row and a Tours today row". On the lean world it
  plants one property, a quiet share (sent 6 days ago, no reply) for
  "Maximiliana-Josephine<stamp> Van Der Berghe-Castellanos", a requested
  tour for "Bartholomew-Alexander<stamp> Featherstonehaugh-Montgomery" and
  a tour at noon today (`scheduleTourToday`, :204) for
  "Wilhelmina-Evangeline<stamp> Ashbourne-Delacroix-Whitfield". It then
  sets the viewport to 380 x 800 (`PHONE_380`, :64), opens Today and finds
  each row by role and accessible name.
- Premise first: the Tours to book list's width is > 0 and <= 560, so the
  test fails loudly if the shell ever stops putting a 380px window in the
  narrow layout (the today-past-tours.spec.ts idiom).
- `expectWholeName` (:290-306) makes three soft geometry checks per row, so
  one run reports every row. The name's own box is not cut (scrollWidth -
  clientWidth <= 1). The name's right edge is within 1px of its row's.
  The row's own scrollWidth is within clientWidth + 1. Then the page check,
  `expectNoHorizontalOverflow(page)` (document and routed `<main>`), and the
  viewport goes back to WIDE_RESTORE.
- `e2e/support/followUpFixtures.ts:18-26`: `createTenant` takes an
  optional trailing `lastName` (default `Followtest`), so existing callers
  are unchanged.

## RED (run fw5-red, old CSS, exit 1)

First failing line: today-checklist.spec.ts:304, `a Quiet shares person row
at 380px {"cut":0,"pastRowEdge":117.609375,"rowOverflow":119}: the name runs
past its row's right edge` (Expected <= 1, Received 117.609375). Also
failing, all from the same run:
- :305, the same row: rowOverflow 119;
- :304 / :305, the Tours to book row: pastRowEdge 128.359375, rowOverflow 129;
- :304 / :305, the Tours today row: pastRowEdge 34.203125, rowOverflow 34;
- :641, the page: `Today with long names at 380px: the routed <main> scrolls
  sideways`, Received 10.
"1 failed". The RED run's artifacts are kept at
`.superpowers/s7/fw5-red-artifacts/`.

## GREEN

- Run fw5-green (today-checklist.spec.ts + today-past-tours.spec.ts), before
  the commit: `6 passed (1.0m)`, exit 0. The new test passed in 5.9s.
- Run fw5 (the final confirmation, after commit 69a01770):
  today-checklist.spec.ts + today-past-tours.spec.ts + tours-page.spec.ts:
  `12 passed (1.3m)`, exit 0.

## Gates (after commit 69a01770)

- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `npx vitest run src/routes/today` (from dashboard/): exit 0, Test Files 8
  passed (8), Tests 146 passed (146).
- `npx eslint e2e/support/followUpFixtures.ts
  e2e/tests/dashboard-next/today-checklist.spec.ts`: exit 0, no findings.
  CSS is not linted.
- ASCII: every added line in all three files is ASCII (the check printed 0).
- After the last run: `npm run e2e:stop` exit 0, no session.pid, no
  listener on lane 12 (10201 / 10211 / 10221 / 10231), and no stack process
  from this worktree.

## Divergences from the brief, and why

1. The name's own scrollWidth check never went RED: `cut` read 0 on all
   three rows. On the old CSS `.who` was as wide as its unwrapped text, so
   nothing inside its own box was cut; the whole box ran past the row. The
   self-QA's 464 > 315 figure was the LINK's scrollWidth. So each row also
   checks the row's own scrollWidth (`rowOverflow`), which is exactly what
   the self-QA measured. The `cut` check stays as asked: it catches a
   future `overflow: hidden` on the name that the other two checks would
   miss.
2. The one test pins three rows, not two, because the compact rows the
   scope said to check did have the defect, and their part of the fix
   (`flex-shrink`) needs its own pin.
3. A third file changed: the optional `lastName` on `createTenant`. It is
   the only way to plant a long last name through the shared helper.

## Residual (not fixed - outside FW5's narrow-query scope, not measured)

The wide layout is unchanged by design, so a name wider than the room the
wide row leaves next to its chips can still be cut there. The band to check
is a content pane just over 560px with a very long name. The orchestrator's
live re-measure at 1024 / 1280 / 1440 is the authoritative desktop check.
