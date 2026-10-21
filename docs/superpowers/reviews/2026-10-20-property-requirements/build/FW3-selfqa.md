# FW3 (self-QA) - micro fix wave from live self-QA: QA-1 (Requirements card tags past the card at 320px), QA-2 (".;" in a joined requirement value)

- Unit: FW3, implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `7c0f2a3e` (the FW2 report commit).
- Brief: the orchestrator's FW3 dispatch (two defects measured on the
  hermetic self-QA lane). Binding process: `.superpowers/sdd/IMPLEMENTER-RULES.md`.
- STOP items: none. The e2e session lane in this worktree was left alone: no
  e2e / Playwright command was run, ports 5174 / 8080 untouched, and no mutant
  was ever written to a file the lane serves (see Divergences).

## Per item

| Item | Result | Commit |
|---|---|---|
| QA-1 - at 320px the Deposit row's "Set on this property" tag ended 9px past the card, "Landlord updated" 1px | FIXED (CSS, property card only) | `a34ce83c` |
| QA-2 - "No pets; Service animals only.; pet fee $300" | FIXED (formatItemValue join) | `77abd659` |

### QA-1 - the tags shrink and wrap inside the card

- Cause (confirmed): `PropertyRequirementsCard.module.css` `.itemLabel`
  (`:32`) is `flex: 0 0 auto; min-width: 120px`, and the tags were
  `white-space: nowrap`. A nowrap tag's minimum width is its whole text, so
  in a value column narrower than the tag it could not shrink and ran past
  the card.
- Change: `dashboard/src/routes/listing/PropertyRequirementsCard.module.css:52`-`:69`
  (the shared `.tagSetHere, .tagLandlordUpdated` rule): `max-width: 100%`
  (`:60`), `white-space: normal` (`:67`, was `nowrap`), `overflow-wrap:
  anywhere` (`:68`, the same last resort `.value` `:49` and `.landlordLine`
  `:86` already carry), `text-align: center` (`:66`, so a wrapped tag's two
  lines sit clear of the pill's round ends). Comment `:52`-`:56`.
- Breakpoint chosen: NONE, on purpose. The dashboard's @media widths are
  860px (most dialogs, two-pane shell, ListingDetail columns), 820px,
  768 / 767.98px (AppFrame mobile, ListingDetail header), 599px (Modal,
  KindPicker, ImageViewer), 520px and 480px (OrgSettings); its @container
  widths are 768 / 767.98 / 560px. The smallest is 480px, so stacking the
  label above the value under ANY existing breakpoint would restack the
  360-479px layout the brief keeps exactly as today, and a sub-360 one would
  be an invented breakpoint. The fix is therefore intrinsic: inert wherever a
  tag fits on one line, active only where it cannot.
- Evidence (no unit test exists for CSS: jsdom runs with css:false). A
  static harness in the scratchpad (not committed) rendered the card's rows
  twice - the CSS at HEAD~1 and the new CSS, with `tokens.css` and the
  `index.css` body font - in headless Edge (Chromium, Segoe UI as on the
  lane), and measured every label, value, tag and landlord line at every card
  content width from 140 to 720px. Rows: Deposit with each tag, Application
  fee, Income requirements (the longest label) with each tag, a single-item
  group (Pets), a long unbroken Credit score value.
  - Card content width = viewport - 48px (`.content` padding) - 26px (card
    border + padding) - the vertical scrollbar when classic scrollbars show
    (0-15px): 320px -> 231-246px; 360px -> 271-286px.
  - Old CSS: something past the content edge at every card width up to
    254px. At 231px the Deposit "Set on this property" tag ended 21.5px past
    the content edge = 8.5px past the card's border, the lane's 9px.
  - New CSS: nothing past the content edge, and no text overflowing a tag's
    own box, at any card width from 149px up (a screen of about 225px). At
    231px every tag is the column's width and two lines (103 x 38.4px).
    Below 149px only the "Income requirements" rows' tags (a one-character
    minimum plus padding beside the unshrinkable label) overflow.
  - Old and new give IDENTICAL boxes (every element within 0.01px) at every
    card width from 255px up - every viewport from about 344px, 360px
    included - and differ only at 140-254px, exactly the widths where the
    old CSS overflowed.
  - A screenshot at the 320px-equivalent width (old beside new) showed the
    old tags crossing the card border and the new ones wrapped, centered,
    inside the value column.
- Same pattern elsewhere - checked, not present, unchanged:
  - Landlord card (`dashboard/src/routes/contact/LandlordRequirementsCard.module.css`):
    no tag and no `nowrap` anywhere; its `.value` (min-width 0,
    `overflow-wrap: anywhere`) wraps beside the same 120px label, as the
    harness's long-Credit-score row shows for the identical rule.
  - Apply dialog rows (`ApplyRequirementsDialog.module.css` `.row`): a
    WRAPPING flex row with no fixed label column; `.check` and `.detail`
    wrap anywhere. The only nowrap element is the `StatusBadge`
    (`ui/StatusBadge.module.css:16`; its longest listing label, "Under
    application", is about 120px), which drops to its own line inside a
    column of about 239-254px at 320px (Modal backdrop and body padding).
- For the orchestrator's re-measure: at 320px every tag's right edge is
  inside the card (a tag that does not fit beside its label wraps to two
  lines); at 360px and wider nothing moved.

### QA-2 - a part followed by another drops one trailing period

- Change: `dashboard/src/routes/listing/requirements.ts:400`-`:405`
  (formatItemValue's return): blank parts still return 'blank' (`:400`);
  each part before the last (`:401`) drops ONE trailing '.'; a part left
  empty by that (it was only '.') is filtered out (`:404`), so the new rule
  never prints "; ;"; then the '; ' join (`:405`). Docstring `:333`-`:344`
  states the rule. Signature unchanged (`:345`).
- Reaches every surface the brief names, all of which call formatItemValue:
  the property card value (`PropertyRequirementsCard.tsx:64`) and its
  landlord lines (requirementDisplay `:422`), the landlord card (`LandlordRequirementsCard.tsx:92`) and the Apply
  dialog's left column (`ApplyRequirementsDialog.tsx:336`).
- Tests, `dashboard/src/routes/listing/requirements.display.test.ts:211`-`:245`:
  - `:214` the QA case ("No pets; Service animals only; pet fee $300"), the
    brief's case ("Cats OK. Dogs ask first; pet fee $300" - the inner period
    stays), and the property card's landlord line through requirementDisplay;
  - `:227` (PIN) the last part keeps its period: pets with no fee, deposit
    notes, tour process, a one-part item;
  - `:238` only ONE period goes: "Ask first..." + a fee -> "Ask first..; pet fee $300";
  - `:242` a part that was only '.' leaves no "; ;".
- RED: 3 failed / 26 - received "No pets; Service animals only.; pet fee
  $300", "Ask first...; pet fee $300", "No pets; .; pet fee $300". The PIN
  (`:227`) was green on the unchanged code by design.
- GREEN: 26 / 26.
- Asserted strings this changes: none. No ".;" occurs in `e2e/tests`,
  `e2e/support` or `dashboard/src`; every joined requirement string asserted
  elsewhere (ApplyRequirementsDialog.test.tsx:142 and :341,
  LandlordRequirementsCard.test.tsx:36-38, PropertyRequirementsCard.test.tsx:51
  and :61-75, e2e/tests/dashboard-next/property-requirements.spec.ts:269, :330,
  :448) has no part ending with '.' before another part. The seeds'
  period-ending values are final parts (tour processes; the full cast's
  `req_pets` "Service animals only." has no fee, `app/src/lib/seed/cast.ts:1337`),
  so they read as before. Nothing was updated.

## Verification

| Run | Result |
|---|---|
| `dashboard`: `npx vitest run src/routes/listing/requirements.display.test.ts` (RED) | 3 failed / 26 |
| same (GREEN) | 26 / 26, exit 0 |
| `dashboard`: `npx vitest run src/routes/listing src/routes/contact` | 101 files, 2438 / 2438, exit 0 |
| `dashboard`: `npx vitest run` (whole suite, once) | 263 files, 5340 / 5340, exit 0 |
| `npm run typecheck` (app, dashboard, e2e, fake-twilio, fake-twilio-web) | exit 0 |
| `npx eslint dashboard/src/routes/listing/requirements.ts dashboard/src/routes/listing/requirements.display.test.ts` | exit 0, no findings |
| ASCII check, added lines of the 3 touched files | 0 non-ASCII bytes each; no `\u` |

The CSS file is not linted: the eslint config covers `.ts` / `.tsx` only.

## Mutant check

TS mutants: each applied to a sibling copy (`requirements.fw3mut.ts`, tested
by a copy of the display test importing it), run, then the copy restored;
both copies deleted after, `git status --short` and `git diff --stat` empty.
The unmutated copy passed 26 / 26. CSS mutants: applied to the harness's
copy of the new CSS and measured as above.

| # | Mutant | Where | Test run | Result |
|---|---|---|---|---|
| M1 | `i < last` -> `i <= last` (the last part loses its period too) | `requirements.ts:403` | display test, 1 failed / 26 (`:227` PIN) | KILLED |
| M2 | `i < last` -> `i < last - 1` (off by one) | `:403` | 3 failed / 26 (`:214`, `:238`, `:242`) | KILLED |
| M3 | drop ONE period -> drop every trailing period | `:403` | 1 failed / 26 (`:238`) | KILLED |
| M4 | drop the trailing period -> remove every period | `:403` | 2 failed / 26 (`:214`, `:238`) | KILLED |
| M5 | no filter of a part left empty | `:404` | 1 failed / 26 (`:242`) | KILLED |
| M6 | the 'blank' guard skipped | `:400` | 2 failed / 26 ('blank' cases) | KILLED |
| C1 | `white-space: normal` -> `nowrap` (max-width kept) | `PropertyRequirementsCard.module.css:67` | harness: text overflows its pill at 107 card widths up to 246px (the 320px screen) | KILLED |
| C2 | drop `max-width: 100%` | `:60` | harness: box overflow at card 140-155px instead of 140-148px | KILLED below a 156px card only; at every phone width equivalent (flex-shrink already shrinks the tag) - no follow-up |
| C3 | drop the tag's `overflow-wrap: anywhere` | `:68` | harness: text overflow at card 140-187px (one word no longer fits beside the long label) | KILLED below a 188px card only; equivalent from there up - no follow-up |
| C4 | drop `text-align: center` | `:66` | harness: no box changes | SURVIVED - equivalent for every box; it only centers a wrapped tag's two lines (visual, seen in the screenshot) |

No survivor is a defect at a supported width, so no follow-up test (jsdom
cannot test CSS in any case).

## Divergences from the rules / brief text

- Mutants were not applied with the Edit tool to the real files: the live
  e2e lane serves this worktree's dashboard source through Vite, so a mutant
  in `requirements.ts` or the CSS module would have hot-reloaded into the
  orchestrator's browser. Sibling copies (TS) and the harness copy (CSS) kept
  the served files at the committed code throughout.
- QA-1 uses no breakpoint (see "Breakpoint chosen"): the brief's two
  constraints - an existing breakpoint and an unchanged 360px+ layout - cannot
  both hold for a stacking rule, and its "and/or" allows the shrink-and-wrap
  alone.

## Contract shipped

- `formatItemValue(id, value): string` - same signature; output differs only
  where a part before the last ends with '.' (one dropped; a part that was
  only '.' omitted). The last part, inner periods and 'blank' are unchanged.
- `.tagSetHere` / `.tagLandlordUpdated` - same class names and colors; they
  now wrap inside the pill only when they cannot fit on one line.

## For the orchestrator

- Re-measure QA-1 live at 320px and 360px (the harness is a strong proxy,
  not the lane).
- QA-2 follows the brief literally: an ellipsis before another part ends as
  ".." ("Ask first..; pet fee $300", pinned at `requirements.display.test.ts:238`).
  If two dots read worse than the rule's precision, the change is the one
  expression at `requirements.ts:403` plus that test.
