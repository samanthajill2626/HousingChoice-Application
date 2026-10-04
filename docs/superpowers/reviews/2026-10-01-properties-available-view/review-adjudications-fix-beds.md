# Review of the voucher-size fallback fix - adjudications

Fix head 8c8c4270 (commits dee9da10, 63e53e8a, 8c8c4270 on top of 71e532fb). The same
adversarial plan-blind reviewer, continued (`code-review-adversarial-fix-beds.md`): 4 LOW
findings, none changing the rule Cameron set. Adjudicated by the planner, 2026-10-04.

| # | Finding | Ruling |
|---|---|---|
| F1 | Two "the note is gone" assertions query `/no voucher size recorded/i`, which can no longer match the new copy, so a note left on screen would pass | ACCEPT: both query `/not counted/i`. |
| F2a | No summary fixture has beds, so the not-counted line's new promise (a beds-only property is counted, not "unrecorded") is untested | ACCEPT: a facet test pins that a beds-only property a size filter leaves out is NOT counted as unrecorded, and that one with neither fact is. |
| F2b | e2e step 6's "recorded size 3 drops out" property also has 3 bedrooms, so it cannot tell "recorded wins" from "beds" | ACCEPT: that property now has 2 bedrooms and a recorded 3 - under 2-BR only "recorded wins" drops it, and step 4's 3-BR keeps it only because of the recorded size. |
| F2c | The function's docblock, the GLOSSARY entry and an AuthoritySummary comment lag the change - the flyer ALREADY derives a size server-side (from beds) | ACCEPT: all three reworded. |
| F3 | A recorded voucher size now overrides beds but can never be cleared (the edit form skips an emptied number, `ListingEditForm.tsx:101`; the API rejects null, `unitFields.ts:165-167`), so a mistaken recorded size permanently hides the bedroom fallback | DEFER to #12 (added to `unit-voucher-size-readers-diverge`): a wrong recorded size can still be CORRECTED to the right number today; only "go back to following the bedrooms" is missing, and #12 rebuilds this field as a multi-select, which needs a clear state anyway. |
| F4 | The property page shows no voucher size for a beds-only property, while the list files it under its bedroom chip | DEFER to #12 (added to the same issue): the page's "Voucher size accepted" row shows what was RECORDED; showing the effective size there (with a "from bedrooms" hint) is a display decision for #12's property-page fields. |
