# Intent record - tracker #31, Today as the daily checklist

## STATE (replace on every move)

- Phase: DESIGN. Spec gate PASSED 2026-10-24 (spec r5 @28d33501). Design review
  closed after round 3; a round 4 review of the added backfill section (7.5)
  is in flight (reviewer A continued, writing `design-review/spec-r4-reviewer-a.md`).
- Worktree `W:\tmp\today-checklist`, branch `feat/today-checklist`, cut from
  main @970a29b9. Nothing built; docs only.
- Launch mode: not chosen yet.
- NEXT STEP: adjudicate round 4 (fold into 7.5, commit), then compaction gate
  A, then write the implementation plan at
  `docs/superpowers/plans/2026-10-24-today-checklist.md` and run its
  adversarial review (2 opus reviewers round 1), then the mission block and
  launch gate.

## What Cameron asked for (verbatim, with dates)

Intake, 2026-10-23:
> Tracker item #31 (Today page as the daily checklist) ... Read the item in
> full, including the Oct 16 and Oct 18 decisions; those are the requirements.

> Decided Oct 23 (Cameron) ...: a tenant who replied to a share and then went
> quiet shows on Today after 2 days; a tenant who never replied shows after 5
> days; both are listed by name, grouped by property. A tenant drops off when
> staff mark them Interested or Not interested, when a tour is created, or when
> any new message is sent either way, which restarts the clock. Shares past the
> #27 14-day window drop off as they do today.

> A separate mission for #30 ... changes who appears in Today's Needs review
> list. Check that branch's plan for overlap before you build.
(Checked 2026-10-23: #30 feat/unknown-inactive is MERGED to main, including the
Today Inactive skip; no overlap left.)

2026-10-23, the business bar:
> make sure that we're only putting on this page things that definitely need
> to happen (not just FYIs or things that you can probably not deal with
> today), as well as making sure that anything in that list is actually on
> here.

> What I do want to make sure of is that that is definitely minimal on the
> page, where it doesn't seem like it's just a huge scrolled page where the
> Worth a Look section is the largest physical part of that page.

2026-10-23, the new signal:
> We don't want our message outbound to a tenant to restart that clock. We
> still want to know, "Hey, we haven't heard from them in a couple days." We
> just don't want it to show up on the Today page. Basically, we need a new
> signal ... which is different than Last Heard From At.

> only messages and calls staff send themselves in any thread. Restart the
> clock ... not the automated messages (as in a tour reminder), but an actual
> outbound message that looks like it would be sent from staff but is sent
> from an agent. That will count in the future when it gets built, but that's
> not now.

> Anything that is on the follow-up tab should be shown in Today. We don't
> just limit it to tenants.

> The follow-up tab itself is left alone.

2026-10-23, layout:
> all caught up should be everything other than could use a look ... the
> tours today, which is basically just informational, should live in that
> section as well.

> "Identify these contacts" is probably a subsection because, honestly, having
> the "needs you now" section that has a whole bunch of different items that
> need completely different actions is difficult context switching for the
> user.

> Past tours should show 5 + See all 23 ... we should probably introduce that
> concept into all of these sections. That way, none of them are longer than X.

> I agree to change the sort order for past tours and your other setup.

2026-10-23: "Let's just put a "Today" section, updated the way that you've got
it, but under the Quiet Shares section, let's just put a TBD placeholder" -
then Sam picked option C (relayed by Cameron 2026-10-23: "We're going to go
with option C that you created.").

2026-10-24, spec gate:
> That looks good, except I think we should run a quick backfill for hte last
> reached out time.

## Why

Sam rarely opened Today (Oct 16 check-in). She and her new VA need a start-
and end-of-day checklist where clearing the page means the day's follow-ups
are done. Priority order: (1) nothing must-do is missing, (2) nothing non-
urgent clutters it, (3) the reference bits stay small.

## Decisions taken in the brainstorm (Cameron, 2026-10-23 unless noted)

- Page: Needs you now; Identify these contacts; Past tours (oldest first);
  Tours to book (new); Quiet shares (option C); Relay groups to close;
  Placements; then "At a glance" (Tours today, AI suggestions one line).
- Unreplied removed; unmatched email stays off (both have badges).
- 5 rows per section, "Show all N" in place; heading count = full count.
- Quiet-share rows: no Interested / Not interested buttons; the row opens the
  contact page.
- Option C details as mocked: properties longest-wait first, first one open,
  replied-then-quiet first inside, limit counts property lines, heading count
  = people, a person on two properties under both.
- A staff call counts on ANY attempt (to the contact: once the contact's leg is
  dialed). A staff relay post counts for EVERY member it reaches. Field name
  `last_reached_out_at`.
- Spec review: shares and broadcasts do NOT restart the clock (each share has
  its own clock); Identify lists only contacts whose type is Unknown.
- Spec gate 2026-10-24: one-time backfill (7.5); no live event from Not
  interested.

## Preferences and taste

- Rows, not chips or badges ("All of those badges look terrible").
- No jump row of section links ("looks like a filter setup").
- Mockups shared with Sam: https://claude.ai/artifact/673Q7i9fjQ7zWAH1XydJ5v.
- Third-person tracker voice; American English; ASCII in docs.

## Rejected options

- Option A (one list) and B (split by action) for quiet shares - Sam picked C.
- A combined "last communication" field - outbound-only field instead (the two
  fields together give "latest either way").
- Tours today kept at the top - moved to At a glance "for now, if we need to
  move it back up, we can".
- An age limit on Tours to book (review finding) - rejected: an unbooked
  request is must-do work however old; prod has 13.

## Explicit NOs

- Staff outbound must NOT move `last_heard_from_at`.
- The Follow up tab's rules and wire stay unchanged.
- No buttons on Today quiet-share rows.
- Agents never run the backfill against dev or prod; Cameron does.
- No infra, deploys or prod writes without Cameron's explicit ask.

## Open questions / assumptions

- The VA uses a normal staff login (assumed, not contradicted).
- Tracker #31 text is updated with these decisions at the end of the build.
