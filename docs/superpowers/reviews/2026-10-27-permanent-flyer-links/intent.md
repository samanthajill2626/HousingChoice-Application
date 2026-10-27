# Intent record - permanent flyer links

## STATE (replaced at each gate)

- Phase: DESIGN - spec rev 1 written, design review round 1 next.
- Launch mode: not chosen yet.
- In flight: nothing (no orchestrator, watchdog or mirror).
- Next step: dispatch two opus spec reviewers on
  `docs/superpowers/specs/2026-10-27-permanent-flyer-links-design.md`,
  adjudicate into `design-review/adjudications.md`, then Cameron's spec gate.

## What Cameron asked for

Sam's email (2026-10-27), forwarded by Cameron, quoted verbatim:

> is it possible to have all links forever live on even if a property is no
> longer available? For example, I don't want the property to no longer be
> available for Unit A but then the property is actually still available.
> Additionally, if people do share the links and let's say a single family
> home is no longer available it would be great to have them visit that link
> and then fill it out/reach out to me directly. I'd prefer that links live on
> forever for right now as a marketing method. I'd prefer for people to not see
> the 'this is no longer available' though I understand that is how other PM
> companies do things.

Cameron (2026-10-27): "I agree with her that we should be able to show them."
"We just need to not close them off once they've been filled, right?"

Cameron (2026-10-27): "For this one, yes, we're not talking about broadcasts,
just the page itself. I understand about the occupied home staying public."

Cameron (2026-10-27): sent Sam a line asking her OK on occupied homes staying
public, and "I'm going to assume that she said she's okay with that."
Called it a "small feature mission"; start with the spec package.

## Why

Flyer links are Sam's marketing. Today a link dies (404 -> "This home is no
longer available") the moment a property leaves Available - including the
automatic flip to Under application when someone applies, even if that
application falls through. Shared links should keep pulling in leads.

## Decisions (brainstorm 2026-10-27, AskUserQuestion answers)

1. Statuses that serve the flyer: "All but Setup (Recommended)". Setup keeps
   the fallback; the property page shows View flyer / Copy public link for
   every status except Setup.
2. Fallback for deleted / setup / made-up ids: "Inline sign-up (Recommended)" -
   neutral heading, the sign-up form on the page itself, no "no longer
   available" wording, all cases identical.
3. Sign-ups from a non-available flyer: "Full credit + status (Recommended)" -
   capture source flyer, home of interest, pin, properties-sent entry; the pin
   names the status when it is not Available.

## Preferences / taste

- No status wording anywhere on the public page (Sam).
- Broadcasts untouched (Cameron).

## Rejected options

- Every non-deleted status including Setup: a half-built property reachable by
  its link.
- Fallback that only links to /join: one extra step for the visitor.
- Attribution without status in the pin; attribution without the
  properties-sent entry.

## Explicit NOs

- Do not change the broadcast send guard or composer.
- Do not show "no longer available" (or taken/removed) on any public page.

## Assumptions made on Cameron's behalf

- Sam's OK on occupied homes staying public is assumed (Cameron, 2026-10-27).
- The fallback sign-up still sends the route's unitId (server treats it as a
  no-property flyer sign-up), rather than becoming a /join-style sign-up with
  the housing authority question.
- No status field is added to the public payload.
