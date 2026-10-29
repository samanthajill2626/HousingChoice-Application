# S8 plan-draft findings (WP1 B2a, plan section 12)

Findings that need a planner ruling. Draft: `.superpowers/sdd/plan-draft-S8.md`.

## S8-F1. The two controls run in both directions (the spec names no direction for them)

- Spec D17 item 2: "BOTH directions: every swap is scored with the tenant
  as a candidate (a property anchor) and with the tenant as the anchor";
  the controls (an assistance-animal tenant against No pets; a "no kids"
  property) are listed separately, with "at least two of three runs" and
  "never capped", and no direction.
- A flag is per candidate (charter 7.4), so both controls can be raised in
  either direction; a model that flags the "no kids" text only when the
  property is the anchor (or only when it is a candidate) would pass a
  one-direction control.
- Draft's choice (draft C2, S8.3 plan, S8.4 tests): each control runs three
  times in EACH direction (12 calls in all) and must pass in each; the
  record and the verdict name the direction of any miss.
- Ruling needed: keep both directions (stricter, 6 more calls), or one
  direction (which: the property as the anchor is the composer's "send
  this property" case).

## S8-F2. What sits beside the subject in each call: the same two fixed fillers

- Spec D17: "Each base and its variant are scored in otherwise identical
  batches (a twin never sits beside its twin), three times each", "about
  400 small calls". It does not say what else a batch holds.
- Draft's choice (draft C3; records.ts `fillerTenantsFor` /
  `fillerUnitsFor`): every call is the subject at `c1` plus the SAME two
  synthetic fillers of that pair - two filler tenants (property anchor) or
  two filler properties (tenant anchor), built for the base tenant's
  voucher size and authority so they are plausible pool members, identical
  across the base, group B and every variant. A one-candidate batch was
  the alternative; it is cheaper but is never what production sends (a
  listwise call over one candidate), and the rubric's "absolute, never
  relative" rule is only exercised with neighbours present.
- Ruling needed: keep the two fillers, or score the subject alone.
