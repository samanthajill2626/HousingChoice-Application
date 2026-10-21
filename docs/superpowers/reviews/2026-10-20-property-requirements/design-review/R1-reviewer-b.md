# Design review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`
(DRAFT revision 1, commit 53757846 on `feat/property-requirements`).
Method: read the spec cold, then checked every claim and every mutation
surface against the code at that commit. Read only; nothing run. Line
numbers are from this worktree. Anything not proven from code is marked
UNVERIFIED.

Spot-checked and CONFIRMED (no finding): the section 2 claims about
`WRITABLE_FIELDS` kinds (`app/src/lib/unitFields.ts:46-117,162-212`),
`acceptedVoucherSizes` (`:336-341`), `toUnitFlyer` (`:343-371`), the `[2, 3]`
seed (`app/src/lib/seed/cast.ts:1358`), create/PATCH audits
(`app/src/routes/units.ts:821-833,2249-2252`), the importer's ownership rule and
field set (`app/src/lib/import/apply.ts:1456-1621`), FlyerPage rendering,
ListingDetail rows, the contacts AI-provenance clear
(`app/src/routes/contacts.ts:1760-1764`, `services/extraction/schema.ts:24-40`),
the audience filter shape and exact match
(`app/src/routes/broadcasts.ts:210-217`, `app/src/services/audienceResolution.ts:187`),
the `tour_type_required` 409 (`units.ts:1468-1471`), and every listed reader of
`voucher_size_accepted` / `acceptedVoucherSizes` (Goal 4's list is complete).

---

## F1 [HIGH] The string-set provenance attributes do not survive the JSON API, and the specified ADD/DELETE mechanism cannot express a mixed write

What is wrong. D5 stores `requirements_copied` / `requirements_set_here` as
DynamoDB string sets, and section 7 asks for "string-set ADD/DELETE support in
update". Three properties of that representation break the design:

1. A string set unmarshals to a JS `Set` (the repo says so:
   `app/src/repos/contactVocabularyRepo.ts:42-52` "a JS Set after
   unmarshalling"; `conversationsRepo.ts:294` types `ever_member_phones` as
   `Set<string> | string[]`). Every unit route answers with the raw stored
   item - `GET /api/units` (`units.ts:761-765`, `page.items`), `GET
   /api/units/:id` ("every stored field ... preserved"), POST (`:834`), PATCH
   (`:2257`), restore, photos, roster routes. There is no Express json
   replacer anywhere in `app/src` (grepped). `JSON.stringify(new Set(['a']))`
   is `{}`. So the dashboard receives `requirements_copied: {}`: every
   property reads as "never touched", the orange **Landlord updated** tag can
   never render, out-of-date copies read as exceptions, and the Apply dialog's
   "Has its own value" defaults (D8) are computed from nothing. The feature's
   core distinction (Goal 3) silently collapses, with no error.
2. DynamoDB rejects an empty string set. Create (`unitsRepo.create` is a
   `PutCommand` of the whole item, `unitsRepo.ts:1020-1047`) must omit an
   empty set; D5's "empties both sets" must be REMOVE, not an empty set. The
   spec never says so.
3. A PATCH that classifies two items in opposite directions (item A now
   equal to the landlord, item B now different) needs `ADD copied {A}`,
   `DELETE copied {B}`, `ADD set_here {B}`, `DELETE set_here {A}` in one
   UpdateExpression. DynamoDB refuses an expression in which two actions name
   the same attribute path ("Two document paths overlap"). This is the normal
   shape of an edit that touches two requirements. UNVERIFIED against
   DynamoDB Local here (read-only review); it is DynamoDB's documented
   path-overlap rule.

Evidence: spec D5 ("two string-set attributes"), section 7 ("string-set
ADD/DELETE support in update"); code cited above.

What it implies. Either store the provenance as something JSON-safe (a map
item -> 'copied' | 'set_here', or two lists written whole), or mandate a
Set -> sorted array conversion on EVERY unit-returning route plus a
read-compute-SET write for classification. Whichever is chosen, the spec must
state it, and the tests must assert the provenance on the HTTP response, not
on the repo return value (which is where a Set looks fine).

---

## F2 [MEDIUM] Landlord changes happen through restore and the roster, not PATCH; D5's "landlord change empties both sets" covers only the path no dashboard flow uses

What is wrong. D5: "A PATCH that CHANGES the property's landlord
(`landlordId`) empties both sets." The other writers of `landlordId` are not
enumerated:

- `POST /api/units/:unitId/restore` with `{ landlordId: <id> | null }` ->
  `unitsRepo.restoreWithLandlord`, which "sets landlordId to `next.contactId`
  (or REMOVEs it for `next` null)" (`unitsRepo.ts:792-826`, implemented at `:1618`;
  route `units.ts:2284-2420`). The dashboard drives it from
  `dashboard/src/routes/listing/RestoreLandlordDialog.tsx:77-81`.
- `POST /api/units/:unitId/contacts` with role `landlord` on an ownerless
  unit "claims `landlordId` in the same conditional write"
  (`unitsRepo.ts:666-668,1324`). Ownerless units are real: the importer
  leaves `landlordId` unset on an ambiguous name (`apply.ts:1583-1597`), and
  restore can make one (`ListingDetail.tsx:377-381`).
- The edit form has no landlord field at all (no `landlordId` in
  `ListingEditForm.tsx`), so the PATCH path D5 handles is reachable only
  from a raw API call.

Consequence. A property restored onto landlord B keeps its sets from
landlord A: an item copied from A now differs from B and shows **Landlord
updated** ("Landlord now: <B's value>") and its Apply row starts CHECKED,
where D5's own rule says it should be "never touched" (purple, unchecked). A
claimed ownerless property keeps items classified "set here" against no
landlord. In addition `useListing` loads the landlord once from
`unit.landlordId` at page load (`useListing.ts:131-143,212`), so after a
roster claim the D6 tags compare against no landlord until a reload.

What it implies. Define "landlord change" as a server rule applied by every
writer of `landlordId` (PATCH, `restoreWithLandlord`, `addContact` claim),
list all three in section 7, and test each.

---

## F3 [MEDIUM] D13's Activity line is unreachable: the unit activity projection drops `reason` for `unit_updated` on purpose, and section 7 does not list it

What is wrong. D13: an Apply writes `unit_updated` with `reason:
'requirements_applied'` and "the Activity feed shows 'Requirements applied
from the landlord'". The Activity route projects audit rows through
`toUnitActivityEvent` (`app/src/routes/units.ts:340-376`), which lifts
`reason` ONLY for `unit_primary_contact_assigned`, with a comment that
`listing_status_changed` stores free text under the same key and the
projection "must not start serving" it (`:369-374`). The dashboard labels
`unit_updated` as "Property updated" + humanized field names
(`dashboard/src/routes/listing/listingFormat.ts:225-228`) and never sees a
reason. Section 7 lists `units.ts` only for "create and PATCH classification;
landlord change" and `listingFormat.ts` for an "Activity label".

What it implies. The build needs an explicit, type-scoped change to the
projection (lift `reason` for `unit_updated` only, and only the enumerated
value), plus the dashboard type. Without it the e2e step "the property pages
show ... the Activity line" fails, or a builder lifts `reason` for every type
and starts serving the free-text status reasons the comment forbids.

---

## F4 [MEDIUM] "One month's rent" keeps a hidden fixed amount, which makes item equality, Apply and the public flyer disagree with what staff see

What is wrong. D10: checking "One month's rent" disables the fixed deposit
amount and "the stored fixed amount is kept, not cleared". D1: the Deposit
item is equal "only when all four of its keys are equal". So:

- Property {one_month: true, deposit: 1500 (hidden)} vs landlord {one_month:
  true} both DISPLAY "One month's rent", yet compare DIFFERENT: D6 shows a
  tag whose two sides print the same text, and D8 lists Deposit as a change
  on that row.
- Apply "SETs or REMOVEs the item's keys to the landlord's values" - it
  copies the landlord's own hidden amount onto properties, and REMOVEs a
  property's hidden amount.
- D1 marks `deposit` "On flyer" and the projection is a per-key allowlist
  (`unitFields.ts:368`), so the stale hidden amount is published in the
  public JSON at `/public/units/:id/flyer`; a cached older flyer bundle
  (which the spec explicitly designs for in D11) renders it as "$1500".
- "No application fee" is the sibling alternative and does the opposite (it
  records 0, destroying the amount) - two alternatives, two rules.

What it implies. Pick one rule: either "One month's rent" clears the fixed
amount (as "No application fee" does), or equality, Apply and the flyer
projection all ignore `deposit` while `deposit_one_month` is set. Say which.

---

## F5 [MEDIUM] Create classification is undefined for items absent from the body, and the create form omits blanks - a deliberately cleared prefill becomes an Apply default overwrite

What is wrong. D5: "POST create, and PATCH (any key of the item in the
body): equal -> copied; different -> set_here." Whether create classifies
ALL twelve items or only those whose keys are in the body is not stated.
Today's create form sends only non-empty values (`addStr` skips blanks,
`addNumber` returns early on '', `tourType` omitted when unset -
`UnitCreateForm.tsx:173-222`). If create classifies only body items, then
staff who clear a prefilled landlord value on the New form (D7 invites
exactly that) produce an item that is "never touched"; D6 renders it
"blank + Landlord: <value>, no tag", and D8 starts that row CHECKED - the
next Apply overwrites the deliberate exception. That is Goal 3 failing on the
spec's own headline flow.

Related: the create form swallows a failed landlord read silently
(`UnitCreateForm.tsx:150-153`, "Non-fatal: the picker stays empty"). D7 says
a landlord with no requirements starts blank, which is indistinguishable from
a failed read. If create classifies all items, every blank item is then
recorded as an exception against the landlord's real values.

What it implies. State that create classifies every item (absent = blank),
or require the form to send explicit blanks; and define the create form's
behavior when the landlord read fails (say so, and do not save as if the
landlord had no requirements).

---

## F6 [MEDIUM] "The tag comes from the same allowlist as the flyer projection, so the form cannot claim Staff only for a published field" is a slogan; the mechanism mislabels voucher sizes

What is wrong. D10 promises the form "cannot" mislabel a field because the
tag "comes from the same allowlist as the flyer projection". The projection
lives in the app (`toUnitFlyer`, `unitFields.ts:343-371`) and the dashboard
cannot import it ("no cross-workspace import exists", `unitFields.ts:303-304,
332-334`), so any dashboard tag table is a hand mirror, which can drift.
Worse, the projection is keyed by OUTPUT field and publishes derived values:
the KEY `voucher_size_accepted` is on the never-public list
(`unitFields.ts:243-245`) while its VALUE ships as `voucher_size`
(`:255-258,356`), and `beds` ships both directly and as the voucher-size
fallback. A tag table keyed by form-field name derived "from the allowlist"
would tag "Voucher sizes accepted" as Staff only while the flyer prints
"Fits a 2- or 3-bedroom voucher". The dashboard's own type comment already
makes that mistake: `voucher_size_accepted` "Internal (not on the public
flyer)" (`dashboard/src/api/types.ts:2545-2548`). The fields outside the
twelve items (utilities, accessibility, lease terms, listing link, video,
same-day RTA, address, rent, beds, authorities) are not in the D1 registry
at all, so "the same allowlist" for them is unspecified.

What it implies. Make the per-field flyer visibility an explicit table in the
spec (form field -> On flyer / Staff only, including derived publications),
and add an app-side test that fails when `toUnitFlyer` emits a value derived
from a field the table calls Staff only. Drop the "cannot" wording unless a
test enforces it.

---

## F7 [MEDIUM] Goal 3's protection is void on the first Apply, which section 4 tells staff to bypass with Select all; rows cannot separate an exception from an out-of-date item

What is wrong. Goal 3: "Apply never overwrites an exception by accident."
Mechanism (D8): a row with any changing set-here item starts UNCHECKED. But
D6 treats every existing non-blank value as set here, nothing is backfilled,
and section 4 says "the first Apply on a landlord starts most rows UNCHECKED
... Select all is the shortcut". On the first Apply - exactly when legacy
deposit, pets, tour type and tour process values are most exposed - the
defaults carry no information and the recommended action overwrites them
all. Separately, D8 applies the same left-column items to every checked row:
a property with one out-of-date copy (wanted) and one exception (not
wanted) can only be updated by unchecking the exception item for ALL rows,
or by two passes. The demo and lean seeds hold the free-text "No pets" on
the property (`app/src/lib/seed/lean.ts:229`, `cast.ts:226,481,689,...`), so
a landlord with the new "No pets" checkbox differs on BOTH pets items from
every such property.

What it implies. Either soften the Goal 3 wording to what the mechanism
delivers (defaults plus a visible per-row list), or add per-row item control,
and do not recommend Select all in the same document that promises
protection.

---

## F8 [MEDIUM] Whole-map replace on every landlord save, with no concurrency guard, lets a stale edit form revert another person's requirements

What is wrong. D2: the PATCH body's `requirements` "REPLACES the stored map
as a whole (the form always sends the whole section)". `ContactEditForm`
today dirty-tracks every field and sends only what changed, precisely so the
server's SET-merge never overwrites untouched data
(`dashboard/src/routes/contact/ContactEditForm.tsx:330-350`). A contact has
no `updated_at` (spec section 2), and the PATCH applies a guard only for
classification and staff notes (`contacts.ts:1795-1806`). So staff B, whose
landlord edit form was opened before staff A changed the requirements, fixes
a typo in Company and silently reverts all of A's requirements, and the
audit records a `requirements` change neither intended. Every landlord save
also writes `requirements` into `contact_updated` fields (D13), so the
landlord's history cannot tell a real requirements edit from any other save.

What it implies. Send `requirements` only when the section changed (the
form's existing convention), or guard the whole-map write with an expected
value, as the staff-notes guard does.

---

## F9 [LOW] The in-memory FakeWorld units repo is a mutation surface the spec does not list

`app/test/helpers/twilioWebhookHarness.ts:2857-2925` implements `UnitsRepo`
by hand (`update` SETs/deletes keys; no set semantics, no conditions beyond
existence). Route tests that use it will need the provenance write and the
new Apply conditional write (landlord still this contact, not deleted)
mirrored, or they will pass against behavior DynamoDB does not have (the
repo already has a parity suite for this class,
`app/test/caseworkerRepoParity.integration.test.ts`). Section 7 should list
the fake.

## F10 [LOW] Item identifiers are never named, yet they become stored data and an API contract

The sets store "items", `POST .../requirements/apply` takes `items:
string[]` and `expected: { <item>: ... }` (D8), but D1 names only keys and
labels. The Deposit item has four keys and no id. Whatever string the
builder picks is written into production unit records and becomes the
wire contract between two hand-mirrored registries. Name the twelve ids, and
the wire shape of `expected` for the Deposit group.

## F11 [LOW] "One conditional write" per unit cannot report the skip reason or the changed fields

D8 wants per-unit skip reasons (`not_found`, `deleted`, `landlord_changed`)
and an audit of "the changed field names". A single conditional UpdateItem
failing gives one `ConditionalCheckFailedException` for all three causes, and
knowing which fields changed needs the prior item. Today's repo update only
conditions on `attribute_exists(unitId)` and returns ALL_NEW
(`unitsRepo.ts:1101-1147`). The spec should say how (ReturnValuesOnCondition
CheckFailure / ALL_OLD, or a consistent pre-read) - a pre-read also changes
the race story in D8's last paragraph.

## F12 [LOW] Section 4 understates the audience widening, and the 4+ issue is not closed

D12 reads a stored `bedroomSize: n` as `[min(n, 4)]`. Section 4 names only
`bedroomSize: 4`, but section 2 itself says the composer pre-fills 5 for a
5-bedroom property (`BroadcastComposer.tsx:205,213`), so stored drafts with
5..12 exist by construction (production UNVERIFIED); those change from
"exactly 5" to "4 or more", which adds 4-bedroom holders. Also
`docs/issues/broadcast-4plus-exact-match-underreach.md` (status open) is the
bug D12 fixes and is missing from the docs list in section 7.

## F13 [LOW] The stale-bundle policy is applied to one field only

D11 keeps `voucher_size` "for a cached older flyer bundle", but an older
flyer bundle also renders the new data wrongly: the hidden fixed deposit
(F4), "$0" for "No application fee" (`FlyerPage.tsx:304-308`), and pets
details without the new "No pets" flag (`petsLabel`, `:110-115`). In the
other direction D12's wire returns `bedroomSizes` "for every record", so an
older open dashboard bundle reading `filter.bedroomSize`
(`broadcastFormat.ts:68`, `AudienceFilters.tsx:175`) loses the size on every
list, results and resumed draft. Decide a policy once and apply it to every
changed public or wire field, or drop the `voucher_size` carve-out.

## F14 [LOW] "Booleans become recordable as No" contradicts "true or REMOVE", and the existing boolean is left ambiguous

D10: "Booleans become recordable as 'No': every checkbox writes `true` or
REMOVE ... so there is no 'unanswered' versus 'No' ambiguity". With
true-or-absent there is no way to record either "No" or "unanswered" - the
two are merged, not disambiguated. The sentence also sits in the property
forms section, which contains the existing Same-day RTA checkbox; today the
form writes `same_day_rta: false` (`ListingEditForm.tsx:159`), the kind is
`'boolean'` (null is a 400, `unitFields.ts:186-188`), and the property page
renders three states Yes / No / - (`ListingDetail.tsx:969-972`). Say whether
same-day RTA changes kind.

## F15 [LOW] Making Qualifications staff only reverses documented intent that the spec says it closes

`docs/issues/unit-onboarding-fields.md` says "qualifications are meant to be
on the shareable listing", and the onboarding sequence lists
"qualifications" in the generated listing link
(`documentation/landlord-onboarding-sequence.mermaid:82`). D1 makes
`qualifications` Staff only and section 7 closes "the ... qualifications
parts" of that issue, without saying the intent was reversed or updating the
diagram. The same docs list misses two GLOSSARY lines this spec contradicts:
"Landlord preferences + expected rent live on the UNIT ... The landlord
CONTACT no longer models them (... pet_policy ...)" and "`lease_terms` is
internal-only (never on the flyer projections)" (`documentation/GLOSSARY.md:176-186`;
the second is already false today, `unitFields.ts:369`).

## F16 [LOW] The `pets` kind is stated three ways, and copy for "flexible" differs

D1's table gives `pets` kind "text"; the values list says it "keeps
accepting a bare boolean on WRITE"; D2 says the landlord map holds "the same
keys with the same kinds". Read together, the landlord map accepts a boolean
`pets`, and Apply (D8) would copy a boolean onto properties. State that the
boolean is accepted on the UNIT write only. Also D1 labels the checkbox
"Flexible / payment terms available" while D11's flyer copy is "flexible /
payment plan available".

## F17 [LOW] PATCH classification needs the stored unit, not only the landlord, and is unfenced

D5 says PATCH "reads [the landlord] when the body touches an item". To find
the landlord and to compute the item's RESULTING value it must also read the
stored unit: its `landlordId`, the other keys of a multi-key item (a body
carrying only `deposit_flexible` touches the Deposit item), and the legacy
`pets` boolean that D1 says implies `no_pets`. Today PATCH reads the unit only
for `accepted_authorities`, `landlordId` or `media` (`units.ts:2152-2229`),
and the write has no version condition (`unitsRepo.ts:1139`), so a
concurrent edit between the read and the write can land a classification
computed from values that are no longer there. Name the read and accept or
fence the race explicitly, as D8 does for Apply.

## F18 [LOW] D4's new 0..12 integer rule meets stored values the old rule allowed

Today `voucher_size_accepted` accepts any finite number >= 0
(`unitFields.ts:175-185`). D4 narrows writes to integers 0..12 and the picker
offers only those chips. A stored 2.5 or 14 (possible through the API;
production UNVERIFIED) renders no chip, and the next Save from picker B
silently drops it. Say what the picker shows for an off-chip stored value.
