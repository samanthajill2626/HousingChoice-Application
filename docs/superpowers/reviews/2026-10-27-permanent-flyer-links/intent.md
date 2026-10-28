# Intent record - permanent flyer links

## STATE (replaced at each gate)

- Phase: BUILD (SUPERVISE) - dispatched 2026-10-28 after compaction gate B.
- Launch mode: AUTO. Cameron 2026-10-28, verbatim: "Go auto with 55 minute
  watchdog timers". Watchdog checkpoints every 55 minutes (3300 s).
- In flight: abt:build-orchestrator (background, mission-block.md verbatim);
  one watchdog on `.superpowers/sdd/progress.md` (3300 s checkpoint, 25 min
  stall); transcript mirror -> `.superpowers/sdd/live.log`. Recoveries so
  far: 0 of budget 2.
- Next step: on each watchdog wake, read the ledger tail, post one
  "**Checkpoint:**" line, re-arm. On STATUS: DONE, run the handback review
  (re-ground in the full replay, gates bare on a quiet tree, spec-conformance
  + plan-blind adversarial opus reviewers, live QA, verdict with a merge
  command). Unregister the compact-resume session when the mission ends.

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

4. Non-Available flyer body (asked after review round 1): "Drop listing link
   only (Recommended)" - leave out the external "See the full listing" link
   when the home is not Available; keep "Same-day tours available".

5. Spec gate (2026-10-27), verbatim: "No new switch should be fine too. We
   don't need to turn this off. And your response about the interested part
   is good. We don't need to hide the buttons on rows for homes that aren't
   available. Might cause confusion if the property wasn't properly moved into
   the right status. With that, I think the spec probably looks good."
   -> spec rev 3 APPROVED.
6. Cameron (2026-10-27), on the Signed up row: OK that a sign-up shows on the
   contact page for a non-Available home - "I just don't want it to create a
   tour or say a tour needs to be created." (Verified: the sign-up writes no
   tour and no follow-up; only a staff Interested click books one.)

7. Launch gate (2026-10-28), verbatim: "Go auto with 55 minute watchdog
   timers" -> AUTO dispatch, 55-minute watchdog.

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

- No new flyer off switch (delete is the only take-down).
- Do not hide the properties-sent row buttons on non-Available homes.
- A flyer sign-up must never create a tour or say one is needed.

- Do not change the broadcast send guard or composer.
- Do not show "no longer available" (or taken/removed) on any public page.

## Assumptions made on Cameron's behalf

- Sam's OK on occupied homes staying public is assumed (Cameron, 2026-10-27).
- The fallback sign-up still sends the route's unitId (server treats it as a
  no-property flyer sign-up), rather than becoming a /join-style sign-up with
  the housing authority question.
- No status field is added to the public payload.
