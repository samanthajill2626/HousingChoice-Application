# Intent record - tracker #30 "Needs review to Inactive without choosing a type"

## STATE

- Phase: PLAN. Spec APPROVED (rev 3 @540ae640; Cameron 2026-10-23: "I
  agree with all of these five calls. These look good. The spec looks good,
  so let's continue."). Tracker #30 updated. Compaction gate A taken
  2026-10-23 16:25 (301k -> 30k).
- Plan: `docs/superpowers/plans/2026-10-23-unknown-inactive-plan.md` v4
  FINAL @d80ca08c (planner sections 0-4, rulings AR1-AR24; slices S1-S7
  from six opus drafts). Plan review CLOSED after 3 rounds (2 reviewers in
  round 1, reviewer A continued; 15 + 5 + 3 findings, all accepted or
  noted). Mission block: `mission-block.md` in this folder.
- LAUNCH GATE ANSWERED 2026-10-23 17:52 (Cameron: "auto, 55 minute
  watchdog timer."): AUTO dispatch; planner watchdog checkpoints every 55
  minutes (his pick over the 30-minute default; 55 is the cache ceiling).
  He did not answer the P9/AR21 question, so the default stands: Contacts
  list non-tenant rows keep plain-text status, no new badge.
- Launch mode: AUTO. Gate B taken 2026-10-23 17:53 (manual /compact,
  320k -> 26k); replay re-read in full after it.
- DISPATCHED 2026-10-23 ~17:56: abt:build-orchestrator in the background
  with mission-block.md verbatim. In flight: the orchestrator, a
  55-minute-checkpoint watchdog on .superpowers/sdd/progress.md, and the
  transcript mirror into .superpowers/sdd/live.log. Failure budget: 0 used.
- Worktree: `W:\tmp\unknown-inactive`, branch `feat/unknown-inactive`, cut from
  main @916258ae. Issue `contacts-status-filter-tenants-only` committed @0957ed39.
  No node_modules yet (plan section 0 has the builder run `npm ci`).
- NEXT STEP: supervise. On each watchdog wake: CHECKPOINT -> ledger tail,
  one "**Checkpoint:**" line, re-arm (55 min); QUESTION -> relay to
  Cameron; STALL -> ladder rung 0 (transcript probe). On DONE -> handback
  review (replay in full, own gates on a quiet tree, spec reviewer +
  plan-blind adversarial reviewer, live QA, verdict).
- Spec gate calls Cameron APPROVED: D7 team_member -> Active / unknown -> Needs
  review from Inactive; D8 "Type unknown"; D9 Inactive tag on every type's
  row; AI extraction keeps running for Inactive; same-type PATCH never resets
  status.
- Estimate in the tracker (1-2 hrs provisional) was NOT changed - not asked.

## What Cameron asked for

Source: tracker item #30 (Google Doc 1BZeYHpPJ7Hfa3PTKzaNJPxmS8jpUf0cxdCT3nLNKgTI)
plus the 2026-10-23 scoping conversation.

Tracker #30 (Oct 16 check-in): about eight contacts sit in Needs review on
Today because nobody knows whether they are a tenant, landlord or caseworker.
Sam calls each one daily for about a week; with still no contact, they move to
Inactive. Oct 18 decision (Cameron): a new text or call from an inactive
contact does NOT move it back to Needs review; it shows in the inbox and the
status stays Inactive until staff change it.

Cameron, 2026-10-23 (verbatim where the wording matters):

- "We just need something in order to move them off the list, but keep them in
  the list of contacts rather than just deleting them outright."
- "In my mind, each contact only has one status, not multiple statuses that
  live in different groups."
- "We do need to have some type of inactive status for all types of contact":
  tenant has Inactive; landlord has Parked ("which is fine"); caseworker needs
  Inactive; team member and unknown need Inactive.
- "If we can just delete the active type for unknown contacts, then let's do
  that."
- "Case worker and team members definitely need a header dropdown as well, just
  like tenants and landlords have. We should have one consistent way to move
  people through statuses, no matter what their contact type is."
- "if an unknown contact has the status inactive, I don't want to treat it
  differently than we're treating a different type of contact that has the
  same exact named status."
- Edit contact details: "should show the same choices as the header, since it's
  the same group of choices. Anywhere that we would be able to choose one, we
  need to be able to choose all of them."
- Unknown inbox tab: "it should be ordered by needs review first and then by
  newest message" - and then: "let's not do sorting server- and database-side
  for now ... on the page that we load, it needs to be newest message first ...
  we can do that browser-side."
- Today: "Needs You Now shows unread texts from any unknown contact that needs
  review. If it doesn't need review, meaning we've marked it as inactive, it
  wouldn't show there ... It just shows in the inbox."
- Retype (CHANGED his first answer the same day): "If they're inactive and you
  make them a type, then do what you would normally do to make a tenant
  onboarding or a landlord interested, since those are the first steps ... we
  probably got new information and they're ready to start moving through the
  process."
- Contacts list status filter on Landlords/Caseworkers: "that's a hole that
  needs an issue filed, but let's not add it in this tracked improvement number
  30." (filed: docs/issues/contacts-status-filter-tenants-only.md)
- Approved a read-only dev/prod count of unknown contacts set to Active, and
  approved updating the tracker entry (planner proposed: after spec approval).

Later on 2026-10-23, in the brainstorm:

- Unknown tab rows for Inactive contacts: picked "Small Inactive tag".
- Automatic texts (tour reminders, group rosters, missed-call auto-text,
  placement nudges, hand-picked shares) ignore status for every type today:
  "let's leave them as they are ... we don't want to flag that unnecessarily
  and make it difficult, so let's allow it the way that it's already been and
  not file an issue."

## Why

Sam and her new virtual assistant need Today to be the daily checklist (#30
with #31). Contacts nobody can reach clog Needs review. Labeling one a tenant
just to make it inactive would record a type nobody knows, misleading staff,
the assistant and later the AI.

## Agreed scope (2026-10-23)

1. Status lists: tenant unchanged; landlord unchanged (Parked is its Inactive);
   caseworker (partner) and team member = Needs review, Active, Inactive;
   unknown = Needs review, Inactive (Active removed).
2. One interactive header status dropdown on the contact page for EVERY type;
   the Edit contact details Status field offers exactly the same choices.
3. A type change keeps today's first-step behavior even from Inactive (tenant ->
   Onboarding, landlord -> Interested, caseworker -> Active).
4. Today Needs you now lists an unknown contact's unread text only while that
   contact is Needs review. The only Today change - #31 owns the reorder.
5. Inbox: an Inactive contact's texts/calls show like anyone else's; status
   stays Inactive. Unknown tab: Needs review block first, then Inactive; within
   the loaded rows, newest message first, sorted browser-side.
6. Follow up list (#27): no Inactive contact is chased, whatever its type.

## Facts established

- Read-only count 2026-10-23 (profile housingchoice, account 938565869261):
  unknown/active = 0 on dev and prod; unknown/needs_review = 19 dev (0 deleted),
  22 prod (10 soft-deleted); unknown/inactive = 0 both.
- No #31 branch, worktree or spec exists as of 2026-10-23.
- Inactive tenant today: no blasts (blasts read Onboarding/Searching only), not
  chased on Follow up (listingSendOutcome.ts:112, tenant-only rule), hidden by
  default on the Tenants view, pinned against placement derivation, shows in the
  inbox and in Today's Unreplied (which #31 removes).

## Rejected options

- Server/database-side activity ordering for the Unknown tab (denormalized
  last_activity_at + GSI): not now (Cameron). Existing issue
  denormalize-contact-last-activity-for-ordered-paging stays open.
- Status filters on Landlords/Caseworkers/Unknown views: out of #30, filed.
- Keeping an inactive status on retype (tenant -> Inactive, landlord -> Parked):
  Cameron's first answer, reversed the same day in favor of first steps.
- A Mark-inactive button on Today rows: #31's ground.

## Must-nots

- Never label a contact with a type just to make it inactive.
- Do not reorder Today (#31).
- No infra, no deploy, no tracker edit before spec approval.

## Open questions / assumptions

- Assumption: the server may keep reading a stored unknown/active row safely
  (count is zero), but new writes of Active for unknown are refused.
