# Intent record - Matching blasts follow the audience rules (tracker #6)

The acceptance brief the planner reviews the handback against. Written from
the conversation (planner session fae5af0e-a5b0-45e3-929e-26d7ae4d94c0,
2026-10-14). Quotes are Cameron's words, verbatim. Append at later gates;
never rewrite earlier entries away.

KNOWN REPLAY GAP: `conversation-replay.mjs` does NOT capture two of
Cameron's inputs - a message sent mid-turn (item R2 below) and an
AskUserQuestion answer (item N1 below). Both are quoted here so the
handback review does not depend on the replay for them.

## Gate B entry (2026-10-14, before AUTO dispatch)

### What Cameron asked for

- Sam's improvement #6 (Improvements Tracker): "matching blasts follow the
  decided audience rules (status, tours, available properties, housing
  authority from the property)." Decided rules (tracker #6, restated in the
  intake):
  - Blasts reach tenants in Onboarding or Searching only (Sep 30).
  - A tenant is left out while they have an upcoming tour; a past tour with
    no outcome recorded yet (no-shows included) until it closes (#18
    two-week auto-close); "an open tour request with no date (Cameron, Oct
    14), for at most 14 days from the request. After that the tenant is
    eligible again even if the request is still unbooked".
  - "Once a tour has an outcome (for example Not a fit), the tenant can
    receive new properties right away."
  - "A tenant added by hand always gets the property; hand-picks skip these
    rules (Sep 29)."
  - "Only available properties can be picked for a blast."
  - "The housing authority filter pre-fills from the property, and a
    property can accept several housing authorities."
  - "#27 already leaves out tenants marked Not interested in that property
    ... Add these rules beside it rather than as a second mechanism."
- Rulings at intake (2026-10-14 14:21), verbatim where it matters:
  - R1 (tour holds, decision 3a): "the spirit is supposed to be 'a tenant
    with a tour setup stays searching, and NOTHING STOPS YOU FROM SENDING A
    PROPERTY TO THEM, including by clicking send property on their contact
    page, but they shouldn't be automatically added to a BLAST that started
    from the matching page.'" -> listed UNCHECKED with a reason label, never
    hidden; one click includes them.
  - Decisions 1 and 2 (tour-held tenants shown unchecked with a reason like
    "Tour scheduled Oct 20"; status-excluded tenants not listed; rules
    computed server-side; preview and send agree): "I agree with you".
  - 3b (#27 Interested creates a tour request, so the tenant is held from
    other blasts up to 14 days): "yes that's intended."
  - Caseworkers: "Caseworkers Should not be included directly in a blast,
    lets change that decision now. Just because they're caseworkers. They
    should be manually added, or sent properties directly."
  - Move forward without a placement ("Needs placement"): "I agree with you
    on tour marked move forward. Count that as a placement for this purpose
    and hold them out."
- 2026-10-14 17:32: "Leave out add a tenant to find caseworkers. it should,
  but we can leave it out of #6 for now since we can direct send to them
  which is the most relevant use case." (filed:
  `docs/issues/matching-add-recipient-search-caseworkers.md`).
- R2 (2026-10-14, mid-turn message, NOT in the replay): "For your rev 1 last
  bullet point, I think the Reaches N recipients count should match the
  number checked." -> the reach count equals the rows that start checked.
- N1 (2026-10-14, AskUserQuestion answer, NOT in the replay) on tenants with
  no housing authority once the property's authorities prefill: picked
  "Leave out, say so" (the options were: list unchecked + label; leave out
  and say so in the caption; include them checked).
- 2026-10-14 18:32 (spec approval): "Lets leave the housing authority lookup
  table/items for now instead of getting rid of them in case we want them
  later. Other than that the spec looks good."
- 2026-10-14 19:30: "Once this is done, run in auto mode with 55 minute
  timers please."
- 2026-10-14 19:40: reread the updated skill, give the pre-GO handback,
  compact, read the handback, then run AUTO with 55-minute timers.

### Why

- Sam stopped using the Matching page because blasts ignored status and
  housing authority; she matches from the Tenants tab by hand with browser
  tabs and a sticky note (Oct 6 workflow review). The blast must reach the
  people she would actually send to, and nobody she would not.
- Order of priorities: (1) the right default audience (status, tours,
  authority from the property), (2) never silently hide a tenant who
  otherwise matches - Cameron's #27 ruling "hiding a tenant looks like a
  bug" - except where Cameron chose to (status-excluded; no-authority
  tenants, with a caption), (3) nothing stops a deliberate send.
- #6 is Before-WP1 item 5; Work Package 1's matching reuses these rules.
  #23 (evictions) starts after this hands back. Estimate 3-5 hrs of
  Cameron's time.

### Preferences and taste calls (not all in the spec)

- One mechanism with #27: unchecked + a reason label, never a second way.
- Copy is plain and short; dates as "Oct 20" (browser-local, like every
  other tour date).
- Third-person tracker voice; at handback a 2-3 sentence #6 note with no
  "you". Do not edit the Improvements Tracker.
- The Sep 30 "AHA found zero tenants" case: Cameron re-ran it 2026-10-14
  and it finds recipients now ("only 1 on a Studio voucher, likely because
  only 1 person has a studio voucher") - #2's name cleanup fixed it; this
  change still adds the multi-authority prefill.

### Rejected options (do not re-propose)

- Listing tenants with no housing authority unchecked, or including them
  checked (N1: leave out, say so).
- Removing the `byHousingAuthority` GSI / `listByHousingAuthority`, or
  filing an issue to remove them (Cameron 18:32: keep them).
- Add a tenant finding caseworkers in #6 (deferred, filed).
- Voucher size as a list (tracker #12).
- Planner-rejected during review (reviewers conceded): measuring a request's
  hold from the latest Interested click; reading units or active placements
  in the hold; a separate reach endpoint.

### Explicit NOs and must-nots

- Caseworkers are never added to a blast automatically.
- A tour never blocks a deliberate send (hand-pick, re-check, direct send).
- Never merge, deploy, run infra, restart the shared DynamoDB Local, or
  touch the live stack (:5174 / :8080). Cleanup only on Cameron's go.
- Do not edit the Improvements Tracker.

### Planner decisions taken on Cameron's behalf (flagged at the spec gate,
### spec approved with them)

- Changing the property empties both filters and re-prefills, no confirm.
- Hand picks (added or promoted) stay checked through Select all.
- Direct sends are never blocked by a failed rules read (labels-off notice);
  filter blasts fail closed (503 + Try again), replacing #27's degrade.
- The reach count recomputes on every draft recreate (message edits
  included); seeds-only creates skip the reads.
- No cap on the open-tours read (like the auto-close sweep).
- Available-only on every picker entry incl. tenant/caseworker pages;
  `?unitId=` keeps the Make Available dialog.
- The resolver reads only Onboarding/Searching partitions (closes the
  truncation-order issue).

### Open questions / assumptions

- The tour-label dates are browser-local (same as all tour dates; the time
  zone issue is filed separately and out of scope).
- Launch mode is pre-chosen: AUTO, watchdog checkpoint 55 min (3300 s).

## State at Gate B (2026-10-14, plan closed, before compaction)

- Spec APPROVED rev 5 (@33251384); spec review 3 rounds closed.
- PLAN v2 FINAL (@09598963): plan review 3 rounds closed, 26 findings, 0
  blocking/high, 0 rejected; rulings AR1-AR42 in plan section 4.
- Mission block (final): `docs/superpowers/reviews/2026-10-14-matching-blast-rules/mission-block.md`
  - dispatch it VERBATIM as the build-orchestrator prompt.
- Launch: AUTO, chosen by Cameron in advance (19:30, 19:40) - no launch-gate
  question. Agent type: the namespaced `abt:build-orchestrator` (the bare
  `build-orchestrator` left the roster this session). Watchdog CHECKPOINT
  3300 s (55 min), stall 1500 s; mirror via transcript-tail.mjs from the
  skill's CURRENT base dir (`W:\AI Projects\claude-plugins\abt\skills\feature-mission`)
  into `<worktree>/.superpowers/sdd/live.log`.
- npm ci done in the worktree. No other mission is building.
- At handback: replay the WHOLE conversation first, then read this file
  (the replay misses the two inputs quoted above as R2 and N1).
