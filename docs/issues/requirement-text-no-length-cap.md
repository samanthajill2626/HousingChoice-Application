---
id: requirement-text-no-length-cap
title: Landlord and property requirement text has no length cap, so repeated saves can push a contact or unit item toward DynamoDB's 400 KB limit
type: improvement
severity: low
status: open
area: app/requirements
created: 2026-10-21
refs: app/src/lib/requirements.ts:226-256, app/src/lib/requirements.ts:263-278, app/src/app.ts:140, app/src/lib/unitFields.ts
---

**Problem.** The property requirements feature (spec
`docs/superpowers/specs/2026-10-20-property-requirements-design.md`, D1 / D2)
stores 15 requirement attributes on every landlord contact (the `req_` keys)
and the same 15 on every unit (property):

| Item | Unit key | Landlord key | Kind |
|---|---|---|---|
| Evictions | `no_evictions_on_program` | `req_no_evictions_on_program` | checkbox |
| Evictions | `evictions_notes` | `req_evictions_notes` | text |
| Credit score | `credit_requirements` | `req_credit_requirements` | text |
| Income requirements | `income_requirements` | `req_income_requirements` | text |
| Qualifications | `qualifications` | `req_qualifications` | long text |
| Pets | `no_pets` | `req_no_pets` | checkbox |
| Pets | `pets` | `req_pets` | text |
| Pets | `pet_fee` | `req_pet_fee` | text |
| Deposit | `deposit_one_month` | `req_deposit_one_month` | checkbox |
| Deposit | `deposit` | `req_deposit` | money |
| Deposit | `deposit_flexible` | `req_deposit_flexible` | checkbox |
| Deposit | `deposit_notes` | `req_deposit_notes` | text |
| Application fee | `application_fee` | `req_application_fee` | money |
| Touring | `tour_type` | `req_tour_type` | tour type (enum) |
| Touring | `tour_process` | `req_tour_process` | text |

The eight text / long-text keys of each record are uncapped:
`normalizeRequirementValue` (app/src/lib/requirements.ts:226-256) accepts a
string of any length (it only trims), for the contacts PATCH (`req_` keys,
`parseLandlordRequirementPatch`) and for the unit validator alike. The other
seven are bounded by their kind (booleans, finite numbers, a three-value enum).

The only limit is the request body: `express.json` runs with its default
**100 KB** body limit (app/src/app.ts:140), so ONE save can add up to about
100 KB, and successive saves of DIFFERENT fields accumulate on the same item.
A DynamoDB item may not exceed **400 KB**. Past that, every later UpdateItem
on the item fails with a ValidationException - including writes other than a
requirements save (inbound-message bookkeeping and opt-out flags on a
landlord contact; Apply to properties and status changes on a unit) - so the
failure surfaces far from its cause.

The class predates the branch (contact `notes` and `staff_notes` are uncapped
strings too); the feature adds eight such attributes to each of two hot item
types. Found by the planner's adversarial code review (PA-5) and deferred by
the planner: a cap is new validation and new user-facing copy, so it is its
own change.

**A second, smaller limit: the Apply to properties body** (planner review
round 2, PA2-2). `POST /api/contacts/:contactId/requirements/apply` re-sends
requirement text in its body: `expected` carries every key of every checked
item (the landlord's text), and each property row adds `seen` with the full
text of its own-value items (planner ruling PR-1). The dialog batches rows by
COUNT (100 per request, `applyRequirementsModel.ts` `chunk`), not by size. So
long text reaches the 100 KB body limit far below the 400 KB item limit: two
landlord items of about 55 KB each make every Apply a 413, and a batch of
hand-checked own rows with long Qualifications can do the same. The dialog
shows the generic "Couldn't update the properties. Review the list and press
Update again." and every retry sends the same body - a dead end with no
named cause. Size any cap against this body (eight items plus the `seen` of
a full batch), not only against the item limit; batching by serialized size
or a 413-specific sentence are alternatives.

**Suggested fix.** Cap requirement text in `normalizeRequirementValue` (for
example 2,000 characters, Qualifications 10,000) with a 400, mirror the cap as
`maxLength` on the shared Requirements fields (dashboard
`routes/listing/RequirementsFields.tsx`), and decide the error copy. Consider
the same for `notes` / `staff_notes` in the same change or a sibling issue.
