# Live self-QA - property requirements (orchestrator, 2026-10-21)

Lane 10 (`npm run e2e:session`, hermetic), reseeded with the FULL profile
(`POST /__dev/reseed?profile=full`, the demo landlord Delia Okonkwo and her
property `unit-cast-pm-managed-property`), signed in as `va@example.com`.
`/__dev/ping` reported `appCommit 7c0f2a3e` (after fix wave 2); the FW3
re-measure ran on the same lane after Vite reloaded FW3's CSS and TS.
Driven with the project Playwright MCP (bundled Chromium); every check below
was MEASURED (accessible names, text, request bodies, bounding boxes,
`scrollWidth`), screenshots under `.playwright-mcp/qa-*.png` (gitignored).

## Walked and measured

| Surface | What was checked | Result |
|---|---|---|
| Landlord page, Requirements / Qualifications card (1280) | the eight items in their four groups; blank as the page's marker; actions `Apply to properties`, `Edit requirements` | OK |
| Property page, Requirements card (Delia's property) | D6 rows: equal -> no tag (Credit score); copied + landlord changed -> orange `Landlord updated` + `Landlord now: ...` (Income); set_here -> purple `Set on this property` + `Landlord: ...` (Pets "Cats OK"); never touched + own value -> purple (Deposit $1,850, Touring); property blank + landlord set -> `Landlord: ...` only (Evictions, Qualifications, Application fee) | OK |
| Property details + tour card | rows `Voucher sizes accepted` (2 BR, 3 BR), `Subzone`, `Washer / dryer`; Deposit / Pets / Application fee moved out; tour card empty state `No application process recorded yet.` | OK |
| Property card geometry, 320 / 360 / 768 / 1024 / 1280 / 1440 | every element inside the card box; page `scrollWidth == clientWidth` | DEFECT QA-1 at 320 (below); OK at 360+ |
| New property from the landlord page (D7) | note `Filled in from Delia Okonkwo's requirements. ...`; every requirement field prefilled; `Fixed amount` disabled under One month's rent; `Application fee` 0 disabled under No application fee; tags are DESCRIPTIONS (exact accessible names unchanged, `aria-describedby` = `Staff only` / `On flyer | Tenants see this on the public flyer.`); money inputs `step="any"`; legend lines | OK |
| R2D-5 live | untick No application fee, type `0.50`: value 0.50, enabled, box stays unticked; tick: 0, disabled | OK |
| Create with Credit score cleared | POST body: no `credit_requirements` key, `requirements_snapshot` = every item, every key, null blank, `landlordId`; no form-only key leaked; `voucher_size_accepted [2,3]`; the new property: `requirement_sources` all `copied` except `credit_requirements: set_here`; card: Credit score `-` + `Set on this property` + landlord line, every other item untagged | OK |
| Landlord edit (pet fee) | PATCH body exactly `{ req_pet_fee: '$300 one-time' }`; the copied property then shows `Landlord updated` + `Landlord now: No pets; ...; pet fee $300 one-time` | OK |
| Apply to properties (1280, 360) | re-read on open; left column checked for every non-blank item; Delia's property row unchecked, `Pets (own value)`, `Deposit (own value)`, `Touring (own value)`; unticking Credit score recomputes the new property's row to `Pets` only and checks it; `Update 1 property`; request `units: [{ unitId, ownItems: [] }]`, `expected` keys = the 7 listed items; done: `role="status"` `Updated 1 property`; 360: columns stack, nothing outside the dialog | OK |
| Activity (D13) | `Requirements applied from the landlord` + `Pet fee` | OK |
| Public flyer projection (`GET /public/units/:id/flyer`) after a PATCH of `subzone`, `deposit_notes`, `evictions_notes`, `washer_dryer` | keys: no subzone, notes, screening, tour or requirement_sources; `voucher_sizes [2,3]`, `voucher_size 2`, `no_pets`, `pet_fee`, `deposit_one_month`, `deposit_flexible`, `application_fee 0`, `washer_dryer hookups` | OK |
| Flyer page `/p/:unitId` (360, 1280) | `Fits a 2- or 3-bedroom voucher`; Deposit `One month's rent, flexible / payment plan available`; `No application fee`; Washer / dryer `Hookups`; Pets `No pets (Service animals only.)`; Pet fee row; no staff string on the page; no horizontal scroll | OK |
| Matching composer from the two-size property | chips `2-BR - matches property`, `3-BR - matches property` pressed; note `Pre-filled to the voucher sizes this property takes: 2-BR, 3-BR` | OK |
| Property edit form (320 / 360 / 1280) | nothing outside the dialog; tags beside labels; public-box notes | OK |
| Console / server log | browser console: React DevTools INFO only; `/__dev/logtail?level=warn` (capturing): the two boot-time local-dev warnings only | OK |

## Defects found and fixed (micro-wave FW3, `build/FW3-selfqa.md`)

- QA-1 (round-2 R2D-12 confirmed): at a 320px viewport the property
  Requirements card's Deposit `Set on this property` tag ended 9px past the
  card (`Landlord updated` 1px); 360px and wider were fine. Fixed in
  a34ce83c (tags wrap inside their pill, `max-width: 100%`). Re-measured on
  the lane: 320px - nothing outside the card (the two tags wrap to two lines);
  360 / 768 / 1280 - every tag box identical to before the fix.
- QA-2 (cosmetic): `formatItemValue` printed `Service animals only.; pet fee
  ...`. Fixed in 77abd659 (a part followed by another drops one trailing
  period). Re-checked live: `No pets; Service animals only; pet fee $300
  one-time`.

## Not covered live (by design)

- 409 `property_changed`, 400 / 409 `deposit_conflict`, the Apply batching
  over 100 rows and its stop / failure paths: races and large worlds, pinned
  by unit and route tests (fence suites on DynamoDB Local included).
- The e2e gate runs the new spec `property-requirements.spec.ts` (both
  tests) on every full run.
