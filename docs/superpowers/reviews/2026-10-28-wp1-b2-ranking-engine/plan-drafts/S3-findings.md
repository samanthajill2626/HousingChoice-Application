# S3 plan-draft findings (pool and cards)

Draft: `.superpowers/sdd/plan-draft-S3.md` (plan section 7). Each finding
changes what gets built; the draft is written to the choice stated, pending
a planner ruling.

## F1. A soft-deleted anchor, and a tenant-kind anchor that is not a tenant

Spec D1 says any record can be the anchor and ranking is never refused for
the anchor's state; D12 answers 404 for "anchor not found". Neither names a
soft-deleted record or a `tenant`-kind anchor id whose contact is a landlord
or partner. `getById` returns soft-deleted records
(app/src/repos/contactsRepo.ts:1393, app/src/repos/unitsRepo.ts:1284);
deletion is defined by `isDeleted` (contactsRepo.ts:433, unitsRepo.ts:598)
and hides the record from every list, so nobody reaches its Rank button
except by URL.

Draft's choice: all three (missing, soft-deleted, wrong contact type) are
`anchor_not_found` (S3.5, `computePool`), so S6 answers 404.

Ruling needed: confirm, or rank a soft-deleted anchor with a new anchor note
(`deleted`) - which would also widen `AnchorNote` (PR3) and the read's
banner text.

## F2. The label of a seen home whose address yields no label

Spec D2.3 gives a placeholder label only for a unit a complete read shows
missing ("a property no longer on file"). `propertyLabel`
(app/src/lib/propertyLabel.ts:58-66) also answers undefined when line 1 or
the city is empty, including every legacy plain-string address - every seed
unit stores one (app/src/lib/seed/lean.ts:225, :248;
app/src/lib/seed/cast.ts:483) and older dev data may too. Such a home still
belongs on the card (its sends, decline and tours are facts).

Draft's choice: list it under the new text "a property with no address on
file" (`NO_ADDRESS_LABEL`, seenSet.ts, S3.2). The attach step matches only a
REAL label, so no Notes line ever attaches to either placeholder. The text
reaches the model (card and `homesSeen`) and the Rankings page, and enters
the tenant fingerprint through the label of an outcome home.

Ruling needed: confirm the text, or name another.

## F3. Landlord defaults and the property `pets` completeness gap

Spec D3 marks property `pets` missing when "none of `no_pets`, `pets`,
`pet_fee`" is recorded; D2.1 says that with `RANKING_LANDLORD_CARD` on, a
requirement recorded only as a landlord default "counts as recorded on that
property" for the cap. D3 is silent on the defaults. Both read the same
card: with the switch on, the defaults are on it under `landlordDefaults`.

Draft's choice: with the switch on, a landlord-default Pets item closes the
`pets` gap (completeness.ts `propertyMissing`, S3.8); switch off (the
default) nothing changes. No other D3 key has a landlord twin.

Ruling needed: confirm, or keep `pets` missing until the property records
its own value (the model would then see both the default and the gap).
