# S3 plan research - findings (code vs spec rev 6)

Slice S3 (app reads). Findings only; the draft's handling is named per item.
Line numbers are against the branch at f204106f.

## F1 - the Activity `reason` key is already taken by free text (spec 8 / C11)

- Spec 8 (and plan C11): "The Activity projection whitelist
  (`routes/units.ts:217-248`) gains `reason`".
- Code: `listing_status_changed` rows on the same `units#<unitId>` trail
  already carry a FREE-TEXT `reason` - `app/src/services/statusTransition.ts:646-652`
  appends `...(reason !== undefined && { reason })`, fed by
  `PATCH /api/units/:unitId/listing-status { toStatus, source, reason? }`
  (`app/src/routes/statusTransition.ts:7`, `:308-318`). The projection
  (`app/src/routes/units.ts:244-274`) has never served it; its docblock says a
  payload field must not leak through.
- A blanket whitelist would start serving that staff free text on the property
  Activity card - a behavior change the spec did not intend.
- Draft (S3.4, CI-5): `reason` is projected for `unit_primary_contact_assigned`
  ONLY, with a pin that the listing-status text stays off the wire. Ruling
  requested.

## F2 - the unit restore response also carries the enriched roster (spec 7.5)

- Spec 7.5 lists the responses that gain the flags and the block: GET
  `/api/units/:id` and the two roster writes.
- Code: the restore route also answers with the enriched roster,
  `app/src/routes/units.ts:1892`
  (`contacts: await enrichRoster(restored)`). The spec is silent on it.
- Draft (CI-6): `enrichRoster` keeps its name and today's best-effort output,
  so the restore response carries no flags and no block; spec 7.5 already has
  the page REFETCH after either restore, which is where S4 must read them.

## F3 - "the UNIT read fails" does not cover a missing unit (spec 5.1)

- Spec 5.1 names two owner cases ("fails (or returns nothing)") but only one
  unit case ("When the UNIT read fails").
- Code: the unit read can also return nothing or not happen at all -
  `app/src/jobs/relayFanOut.ts:505-510` (`deps.unitsRepo` is optional per
  `RelayComposeDeps`, `:370-378`, and `getById` may resolve `undefined`). The
  same holds for settings: `:555-556` treats an empty settings answer like a
  failure.
- Draft (design notes D1, D2): a missing unit or no units repo takes the
  unit-failure rule (`lookup_failed` + tour reasons); an empty settings answer
  is `lookup_failed`, like a thrown one.
