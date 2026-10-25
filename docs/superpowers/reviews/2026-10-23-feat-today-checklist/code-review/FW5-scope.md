# FW5 scope - a self-QA finding (tracker #31)

Found by the orchestrator's live self-QA (S7.16, Phase 5) on a hermetic lane
(lane 12, booted at 9913c552, 2026-10-25 ~14:55Z), measured in a real
browser, not from a review. Adjudicated by the orchestrator.

## The defect

At a narrow content pane (the Today rows' `@container (max-width: 560px)`
layout - phones and the narrow pane), a long contact NAME is clipped with no
wrap and no ellipsis:

- `.who` is `white-space: nowrap` and `flex: 0 0 auto`
  (dashboard/src/routes/today/Today.module.css ~128-133), and `.row` is
  `overflow: hidden` (~61-69); the narrow container query lets `.why` wrap
  (~297-301) but not `.who`.
- Measured at 380 x 800 with worst-case names: a Tours to book row
  "Bartholomew-Alexander069604 Featherstonehaugh-Montgomery" (link
  scrollWidth 464 > clientWidth 315, the name cut at "Featherston") and a
  Quiet shares person row "Maximiliana-Josephine069604 Van Der
  Berghe-Castellanos" (416 > 277, cut at "Van Der"). Page and main show no
  horizontal overflow (0 / 0); the text is simply cut inside the card.
- Pre-existing CSS (main has the same `.who`), but this mission adds the
  rows most likely to carry long names (Quiet shares people, Tours to book
  tenants) and makes Today the VA's checklist. Desktop (1024-1440) is fine:
  the name shows in full and the reason truncates with an ellipsis by
  design.

## The fix (FW5-1)

- Under the narrow container query only, let the name wrap instead of being
  clipped (`.who` `white-space: normal` plus a break rule for one very long
  token, e.g. `overflow-wrap: anywhere`), for every Today row that uses
  `.who`: the item rows, the Quiet shares person rows, and the At a glance
  compact rows if they clip the same way. Desktop layout unchanged.
- Pin it with an e2e GEOMETRY assertion (unit tests run css:false and cannot
  see it): in e2e/tests/dashboard-next/today-checklist.spec.ts, at a 380 px
  wide viewport, a quiet-share person row and a Tours to book row whose
  names are long show the whole name - the name element's scrollWidth is at
  most its clientWidth + 1 and its right edge sits inside its row - and the
  page still has no horizontal overflow. RED first on the current CSS.
- Verification after the fix: the orchestrator re-measures live at 380,
  1024, 1280 and 1440 (the authoritative check for a layout change; a code
  reviewer cannot see layout), and the final full gate battery runs at S8.
