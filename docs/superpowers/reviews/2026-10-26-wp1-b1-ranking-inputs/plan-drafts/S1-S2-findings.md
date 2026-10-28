# WP1 B1 plan drafts S1-S2 - findings (code vs spec)

Drafter: S1/S2 section drafter, 2026-10-26. Findings only; the plan text is
in `.superpowers/sdd/plan-draft-S1-S2.md` (S1 Contradictions C2, C3, C5).
Each item changes what gets built; the draft takes the stated resolution
unless the planner rules otherwise.

## F1 - `_source` keys on the dashboard write types (spec D2 "API types")

Spec D2 says `Contact`, `ContactPatch` and `CreateContactInput` all gain the
four keys "and their `_source` keys". Code: there is no
`CreateContactInput`; the create body type is `ContactCreate`
(dashboard/src/api/types.ts:2289). No write path accepts a client
`_source`: `parseTriageBody` and `parseCreateBody` never copy one
(app/src/routes/contacts.ts:574-858, :866-1050), so the "unless the patch
carries the provenance" branch (contacts.ts:1940-1947) only sees
server-built keys, and today's write types carry no `_source` key either
(types.ts:2459-2540 `ContactPatch`, :2289 `ContactCreate`; only `Contact`
declares them, :2442-2449).

Draft resolution: `Contact` gains the four value keys and the four
`_source` keys; `ContactPatch` and `ContactCreate` gain the four value keys
only. Planner: confirm, or rule that the write types carry `_source` too
(it would type a field the server silently ignores).

## F2 - which seed tenant is "the fully filled seed tenant" (spec 4 "Seeds", PR3)

Neither the spec nor PR3 names the tenant, and app/src/lib/seed/cast.ts has
no tenant described as fully filled. Candidates: persona 3 "Parked No-RTA
Tenant" (cast.ts:309-336, `on_hold`, complete intake) and persona 4
"Searching Tenant" Monique Everett (cast.ts:418-457, `searching`, two
listing_sends, a legacy `preferences_notes` describing area, stairs and a
bed size).

Draft resolution: persona 4 (`contact-cast-searching-tenant`) - the
profile B2 ranks and the one with properties sent (S5's PROPERTIES SENT
block). Planner: confirm, or switch to persona 3 (S1.6's seed edit and the
test's `HOLDER` change; nothing else depends on the choice).

## F3 - the portion control cannot carry native min / max / step (spec D2)

Spec D2: the portion control is "a number input" AND "the client-side
message for a bad portion matches the server's". A number input with
`min` / `max` / a whole-number `step` makes the browser refuse 12.5, -5 and
20001 in its own words before form code runs; jsdom does the same
(HTMLFormElement `requestSubmit` calls `reportValidity`, relied on by
dashboard/src/routes/listing/UnitCreateForm.test.tsx's "does not create the
property when a numeric field is invalid"). The voucher size input
(dashboard/src/routes/contact/ContactEditForm.tsx:737-748) follows that
native-first pattern, so its JS message is unreachable.

Draft resolution: the portion input is `type="number"` with `step="any"`
and no `min` / `max`, so every bad value reaches the shared helper and
shows the server's copy (the drift test pins the two copies equal).
Planner: confirm, or accept native validation and drop the
"message matches" requirement for this control.
