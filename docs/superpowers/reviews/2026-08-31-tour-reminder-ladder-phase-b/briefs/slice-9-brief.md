# Slice 9 - Task 15 (docs closure + founder-handback-items.md)

Common brief (READ FIRST): `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\implementer-brief-common.md`
Report path: `W:\tmp\tour-reminder-ladder-phase-b\.superpowers\sdd\reports\slice-9.md`
Research: report D section 6 (issue frontmatter shape, the four issue files' current state,
the single `TODO(tour-reminder-ladder-phase-b)` marker at `app/src/messages/tourCopy.ts:172-175`,
`npm run issues`). Spec sections 12 (nine-item disposition table) and 15 (founder items).

Scope: plan Task 15 steps 1-3, plus the additions below. Docs only - no code beyond the
one TODO marker line. ONE commit: `docs(issues): discharge the Phase B unpause ledger`.

Deliverables:
1. `app/src/messages/tourCopy.ts` ~`:172`: `TODO(tour-reminder-ladder-phase-b)` ->
   `TODO(tour-copy-where-token-declared-not-passed)` (spec 12 item 9). Comment text otherwise
   unchanged. Then `cd .../app && npx vitest run test/tourCopy.test.ts` + `npm run typecheck`.
2. `docs/issues/tour-reminder-ladder-phase-b.md`: frontmatter `status: resolved`, add
   `resolved: 2026-08-31` between `created:` and `refs:`; append the Phase B spec + plan paths
   to `refs:`; append a `**Resolution (2026-08-31).**` paragraph followed by a NINE-row list,
   one line per ledger item, citing the spec section that discharged / re-deferred it - copy
   spec section 12's table dispositions (item 8: ASSESSED, NOT FIXED, DROPPED - not filed;
   item 9: RE-DEFERRED, TODO re-pointed). Do not rewrite the historical body above it.
3. `docs/issues/placement-nudge-overdue-invisible-on-card.md` (STAYS OPEN): append a dated
   paragraph recording the two surfaces Phase B spec 8.2 EXCLUDES from the tour `overdue` flag
   and assigns to this item's scope: `routes/contactTimeline.ts` (upcoming bucket,
   `TimelineScheduled`) and `routes/relayGroups.ts` (GET `/api/conversations/:id/scheduled`),
   both rendering through `dashboard/src/routes/contact/ScheduledCard.tsx` whose
   `fireTimeLabel` still says "sending shortly" for a past dueAt. (Ruling R3 in
   `.superpowers/sdd/worklist.md` - the spec claimed this record already existed; it did not.)
4. `docs/superpowers/reviews/2026-08-31-tour-reminder-ladder-phase-b/founder-handback-items.md`
   (NEW, committed): spec section 15's five items VERBATIM (including item 2's SEQUENCING line),
   then a `## Added during the build` section with these three, each 2-4 lines, plain and
   specific:
   a. (slice 6) The `en_route` exemption has a mirror at the TOP of the day: any tour from
      about 21:00 org-local onwards now gets its `en_route` inside the quiet window (a 10pm
      tour texts at 9pm) where it previously got nothing. Same decision as the 04:00 case,
      same direction, never stated to her.
   b. (slice 8) Sam's tour intro composes only when the relay group is opened for a tour
      that already HAS a scheduled time. Today's demoed flow opens the group first and
      negotiates the time inside it, so in practice most tour relays will send the naked
      "Hey, it's Sam" intro; the tour wording fires for relays opened AFTER booking. If she
      wants the tour wording on every tour relay, that is a workflow question (book, then open).
   c. (slice 8) The role-less member-added line `Hey, adding {name} to the group.` is the
      COMMON case in production: a standalone group, or any joiner not on the property's
      roster (a caseworker, a family member). She only ever reviewed the role form
      (`... as the landlord.`); confirm the bare form reads right to her.
   Add a one-line pointer that items 1-5 are quoted from spec section 15. ASCII only.
5. `npm run issues` from the worktree root (regenerates the gitignored INDEX - do NOT commit
   `docs/issues/INDEX.md`; confirm `git status` shows it untracked/ignored).

Verify: `git status` shows exactly the four intended files + the TODO line; `npx eslint
app/src/messages/tourCopy.ts` (baseline attribution if anything fires); ASCII check on added lines.
