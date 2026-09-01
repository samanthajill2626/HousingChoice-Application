# Owed to the founder - tour reminder ladder Phase B

Product questions and disclosures the Phase B build raised and did NOT decide.
None of these is build work; each needs Sam (or Cameron on her behalf) to answer
or acknowledge. Items 1-5 are quoted verbatim from section 15 of
`docs/superpowers/specs/2026-08-31-tour-reminder-ladder-phase-b-design.md`; the
items under "Added during the build" were found while building and are not in
the spec.

1. `en_route`'s quiet-hours exemption changes what her email told her about
   tours at 8am or earlier - they now get a reminder where the email said they
   get none. It also has NO FLOOR: a 4am tour texts at 3am. Tell her both
   (section 6.1).
2. **Her tour and placement intros carry no sender identity**, where the naked
   intro opens "Hey, it's Sam." A relay intro carries no brand and no STOP, so
   on those two variants a stranger's first text from an unknown number says
   nothing about who it is from. Engineering has stated this exposure before and
   she directed it anyway; this is the same class of decision and it is hers.
   Her copy ships as written unless she says otherwise (section 9.1).
   SEQUENCING: because the deploy is a separate human step, she can be asked
   BEFORE the first tour or placement intro ever sends - not after.
3. Confirm that `pm` on a unit roster is what she means by "property manager"
   (section 9.4).
4. The placement intro runs about 370 characters, roughly three SMS segments.
   Phase A spec section 5 rules that a cost note, not a gate. Do not shorten her
   words.
5. Her question "please also confirm {landlord} is wired to tour templates and
   not just to relays" - it is, as `{propertyContactFirstName}` on
   `tour.en_route_landlord_led`.

## Added during the build

6. The `en_route` exemption has a mirror at the TOP of the day that item 1 does
   not mention. Any tour from about 21:00 org-local onwards now gets its
   `en_route` INSIDE the quiet window - a 10pm tour texts at 9pm - where before
   the exemption it got nothing. Same decision and same direction as the 4am
   case, but it was never stated to her in either form.

7. Sam's tour intro composes only when the relay group is opened for a tour that
   ALREADY HAS a scheduled time. The flow she demoed opens the group first and
   negotiates the time inside it, so in practice most tour relays will send the
   naked "Hey, it's Sam" intro, and the tour wording will fire only for relays
   opened AFTER booking. If she wants the tour wording on every tour relay, that
   is a workflow question for her - book, then open - not a code change.

8. The role-less member-added line `Hey, adding {name} to the group.` is the
   COMMON case in production, not the rare one: it renders for a standalone
   group, and for any joiner who is not on the property's roster - a caseworker,
   a family member, a second tenant. She only ever reviewed the role form
   (`... as the landlord.`). Confirm the bare form reads right to her.
