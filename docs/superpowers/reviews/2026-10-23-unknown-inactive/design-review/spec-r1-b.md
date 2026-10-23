# Spec review r1-b (adversarial) - unknown-inactive design rev 1

Spec: `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` (rev 1).
Repo read at the worktree HEAD (752b9234, cut from main @916258ae). Read-only:
no tests, no servers, no AWS. Every code claim below cites a line I read.
Spec line citations were checked; the ones not listed as wrong below are
accurate (contacts.ts 1006-1008, 1125-1132, 1725-1729, 1746-1760, 2129-2139;
statusTransition.ts 150-154; caseworkerConversion.ts 528-532; today.ts
784-800, 845-902; inbox.ts 1116/1175/1566; useInbox.ts 149-153/718;
UnknownFile.tsx 100; ContactDetail.tsx ~1003-1028; StatusBadge.tsx 117-121;
listingSendOutcome.test.ts 195-198).

UNVERIFIED: the "ZERO (unknown, active) on dev and prod" count (D1, section 6).
I did not and may not read either environment.

---

## 1. [HIGH] D5 puts the Inactive filter AFTER Today's unread cap - Inactive unknowns will starve Needs you now and Unreplied

What is wrong. D5 says the "New unknown contact" row for an unread unknown 1:1
thread "shows only while that contact's status is Needs review" and cites the
EMIT branch, `today.ts:784-800`, as the one condition it changes. That branch
runs over `unreadOneToOne`, which the COLLECT loop has already capped at
`TODAY_UNREAD_CAP` (100) kept rows (`today.ts:182`, `today.ts:751`). A rule
applied in the emit loop drops rows that have already spent cap slots.

Evidence. The file documents this exact failure and its fix twice: "FILTER-THEN-
CAP, explicitly ... Capping the raw stream first would let a burst ... consume
every slot and starve the sections this pass exists to fill" (`today.ts:663-666`),
and the deleted-contact test was MOVED from the emit loop into the collect loop
because "A hundred at the head of the index rendered Unreplied and the
untriaged block EMPTY" (adversarial A9, `today.ts:711-720`, code at 743-747).
The dedupe key also runs ahead of the cap (`today.ts:748-751`).

What it implies. Inactive unknowns are by design never-read threads (spam,
wrong numbers, the very contacts staff mark Inactive instead of opening). D9
keeps them "unread when unread", so they sit at the head of the byUnread
index indefinitely. Built as the spec says, enough of them fill all 100 slots
and Today renders Needs you now and Unreplied short or EMPTY, with
`warnIfCapped('unread', ...)` reporting "capped" - the A9 regression, re-made.
The rule must live in the collect loop beside `isDeletedContact`; the contact
read is already paid there (`getContact` is memoized, `today.ts:358-381`), so
it costs nothing. The spec's "ONE condition in today.ts" and its citation both
point the builder at the wrong loop. Test 4 as written (one thread) cannot
catch this; it needs a cap-pressure case.

## 2. [HIGH] D3 routes landlord status edits through the transition route, which NULLS park_reason

What is wrong. D3: "A status change with NO type change goes through the same
transition route as the header (D2), for every type." Today the edit form
sends a LANDLORD status on the plain PATCH, together with the form's Park
reason field (`ContactEditForm.tsx:345-347`, `:370`, textarea at `:997-1005`);
only tenants use `setTenantStatus` (`:541-548`).

Evidence. The transition plan writes `park_reason = reason ?? null` on every
move to `parked` (`services/statusTransition.ts:164`). The form's save order is
PATCH first, then the status write (`ContactEditForm.tsx:532-548`). The spec
never mentions park_reason, and D2 states the route is used with no reason.

What it implies. Built as written, a staff member who moves a landlord to
Parked in the edit form and types a reason gets the reason saved by the PATCH
and then REMOVED by the transition, with a 200 and no error. Silent data loss
on an existing, working flow. The spec must say the form passes the typed park
reason as `reason` on the transition (or keeps landlord status on the PATCH),
and test 7 must pin "park a landlord with a reason from the form keeps the
reason".

## 3. [HIGH] D4's guarantee "treated exactly as an Inactive tenant is today" is false against current tenant behavior, in three places

What is wrong. D4 opens: "An Inactive contact of any type is treated exactly
as an Inactive tenant is today", and Goal 4 makes same-name-same-meaning the
headline requirement. The current treatment of an Inactive tenant differs from
what the spec builds for the other types:

a. Contacts list. An Inactive tenant is HIDDEN by default: the Tenants view's
   default status selection is "every status except inactive and placed"
   (`dashboard/src/routes/contacts/tenantFacets.ts:68-72`). D4.3 and Goal 1
   say an Inactive contact is "Shown everywhere else as any other contact:
   Contacts list", and test 8 pins an Inactive unknown STAYING on the Unknown
   view. So D4.3 misdescribes the tenant behavior it claims to copy.
b. Today. An Inactive tenant's unread 1:1 text shows on Today in Unreplied
   (`today.ts:806-838`, no status check). D5 removes an Inactive unknown's
   unread text from Today entirely (and an unknown_1to1 thread never reaches
   Unreplied, `today.ts:812-814`). Same name, different treatment.
c. D4.1 says "Placed stays a tenant-only rule" while also saying Inactive is
   the same for everyone - fine - but nothing reconciles (a) and (b).

What it implies. A builder holding D4 literally has two contradictory ways to
"comply": hide Inactive unknowns/caseworkers by default on their views (breaks
Goal 1 and test 8) or show Inactive tenants on Today/Contacts (out of scope,
regresses tenants). And STATUS-MODEL.md is to be written from D4 (section 4,
Docs), so the false sentence becomes the documented meaning of Inactive. The
spec must replace "exactly as an Inactive tenant" with the actual enumerated
rule set and state the known tenant/non-tenant differences as accepted, or
decide them.

## 4. [MEDIUM] "Unknown" in D5 and D9 is keyed on things team_member also matches - Active team members' unread texts would vanish from Today

What is wrong. Both predicates the spec edits are not "contact type is
unknown":
- Today's row fires on `conv.type === 'unknown_1to1'` (`today.ts:784`), and a
  team_member's 1:1 thread IS `unknown_1to1` (`webhooks/twilio.ts:221-232`,
  `lib/voiceMasking.ts:28-39`; `contacts.ts:537-542` never flips it).
- The inbox's `needsTriage` is `role === 'unknown'`, and `roleFromContact`
  falls through to `'unknown'` for team_member (`inbox.ts:602-609`, 1116; the
  class-g note at `unknownQueue.ts:123-129`).

D5 says the row "shows only while that contact's status is Needs review". A
team member's normal status is Active (`lib/import/status.ts:64`; D7 sends
re-typed team members to Active). Applied to the existing branch, every unread
text from an Active team member - shown on Today today as "New unknown
contact" - disappears from Today, and it cannot fall to Unreplied (`today.ts:
812-814`). The spec never mentions it. D9's "true only for an unknown contact
whose status is Needs review" has the same ambiguity for the chip.

What it implies. An unstated behavior change for team_member on both Today
and the inbox. The spec must say whether the predicate is `contact.type ===
'unknown' && status !== 'needs_review'` (team members untouched) or status
alone (team members change), and test 4/5 must cover a team_member thread.

## 5. [MEDIUM] Parked is called the landlord's "inactive status" (D1) but every D4/D9 rule keys on the literal `inactive`

What is wrong. D1's table says landlord needs no change because "Parked is its
inactive status" - that is how Goal 2 ("an inactive-type status for all
types") is met for landlords. But D4.1 drops only `status === 'inactive'`,
D4.4 mutes only Inactive, D7's rule fires only "from an Inactive contact", and
D9's inbox tag shows only for "an Inactive contact of any type". A Parked
landlord gets no Inactive tag, and D7 says nothing about a Parked landlord
re-typed (it happens to normalize because parked is illegal elsewhere,
`contacts.ts:1751-1759`).

What it implies. Either Parked is the landlord's Inactive (then D4/D9 are
incomplete) or it is not (then D1's claim that landlord needs "none" change
under Goal 2 rests on a different status meaning, which is exactly what Goal 4
forbids). The spec must pick one and say it.

## 6. [MEDIUM] Goal 4 is stated universally but only delivered for Inactive - Active and Onboarding already mean different things per type

What is wrong. Goal 4: "A status with the same name means the same thing for
every type." Today, and unchanged by this spec:
- Active: landlord = "a landlord with onboarded properties", tone positive
  (`lib/statusModel.ts:168-170`, `StatusBadge.tsx:39-44`); partner/team_member
  = simply resolved, tone neutral (`StatusBadge.tsx:117-121`,
  `contacts.ts:1715-1719`).
- Onboarding: tenant = lifecycle start after identity; landlord = SIGNED and
  bringing in properties (`statusModel.ts:166-169`).

What it implies. The guarantee is a slogan relative to the mechanism. Either
scope Goal 4 to Inactive (and Needs review) in the text, or the build owes
work the spec never lists. As written a reviewer of the build can fail it on
Goal 4 for Active.

## 7. [MEDIUM] D9's Unknown-tab client sort overturns a recorded 2026-08-26 ruling without saying so

What is wrong. The server comment records: "RULED 2026-08-26: LEAVE IT. The
client keeps re-sorting the accumulation for every filter, this branch
included ... Do NOT 'fix' either side unilaterally ... this one is settled"
(`inbox.ts:2282-2309`). D9 changes exactly that client sort for the Unknown
tab. Cameron's quote may well supersede the ruling, but the spec does not
name the ruling, does not say it is superseded, and section 4 does not list
the comment block (or `inboxFilters.ts:70-84`, whose copy rationale cites the
`active` class f) as surfaces to update.

What it implies. A builder or reviewer who reads the code will find an
explicit "do not do this" and either stall or be told the spec is wrong. State
the supersession and list the comments.

## 8. [MEDIUM] "No backfill: the count is zero" is a snapshot; (unknown, active) is still manufacturable until deploy and a leftover vanishes from the Unknown tab

What is wrong. Section 6 skips a migration because the 2026-10-23 count is
zero (UNVERIFIED). Until deploy, (unknown, active) can still be written from
the UI: the edit form offers Active for every non-tenant
(`ContactEditForm.tsx:132-142`) and the status-only PATCH accepts it
(`contacts.ts:1665-1675` with `statusModel.ts:194-208`; `unknownQueue.ts:
57-69` names this as the UI-reachable manufacturer). The API create default is
also `active` (`contacts.ts:1006-1008`).

What it implies. Once D9 removes the Active block, any such contact is on NO
Unknown-tab block - it silently leaves the queue, the coverage-loss class the
block reader was built to prevent (`unknownQueue.ts:47-53`) - and it carries a
status its own type no longer allows (the header dropdown has no matching
option; the edit form shows Needs review). The rollout needs a re-count
immediately before deploy (human-run, read-only) with a stated action if it is
non-zero, or the plan needs a defensive reader mapping.

## 9. [MEDIUM] "A new inbound text ... does not put it back on Today" is not delivered: AI extraction still runs and its suggestions land on Today

What is wrong. Goal 1 and test 8 promise an Inactive unknown stays off Today
after a new inbound. Extraction eligibility is by type only - unknown is
eligible whatever its status (`jobs/extraction.ts:457-462`) - and an unknown
contact gets type suggestions (`services/extraction/apply.ts:576-580`). Today's
"AI suggestions to review" group lists every contact with a pending
suggestion, filtered only for deletion (`today.ts:947-976`).

What it implies. With AI extraction on (deployed envs), an inbound text from
an Inactive unknown can put a row on Today, contradicting the spec's
guarantee; in the hermetic e2e lane the test will likely pass vacuously. The
spec lists `extraction.ts` only as a status-proposal watch item. Either state
that AI-suggestion rows are an accepted exception, or decide otherwise - and
note it also costs a model run per spam text.

## 10. [LOW] "Today's Needs review list" names a section that does not exist

Both the unread-thread row and the triage-pass row land in `needs_you_now`
with the same `why: 'New unknown contact'` (`today.ts:799-803`, `:935-939`);
Today renders "Needs you now", "Tours today", "Unreplied", "Follow-ups due",
"AI suggestions to review" (`dashboard/src/routes/today/Today.tsx:38-44`).
Goal 1, D5 bullet 1, test 4 and test 8 all say "Needs review list". A builder
writing the e2e from the spec alone will look for a heading that is not
there. Name the real surface (the triage-pass rows inside Needs you now).

## 11. [LOW] D4.5 "the contact's own type" is ambiguous on a type-and-status save

The PATCH milestone picks its label map from `stored.type` - the OLD type
(`contacts.ts:2129-2134`) - while the status was validated against the NEW
type (`contacts.ts:625-631`). D3 keeps type+status saves on that path. The
spec should say the label comes from the RESULTING type, or the builder will
leave the old-type lookup in place.

## 12. [LOW] D3 misdescribes today's form defect

D3 says the form's own list "silently resets any value it does not know to
Needs review, so saving an Inactive caseworker would flip it back". The form
compares the selection against the SAME normalized default
(`ContactEditForm.tsx:345` vs `:60-67`), so an untouched off-list status is
never sent: the save would leave Inactive in place while the form DISPLAYS
Needs review. The fix is still right; the stated mechanism is not, and the
test "saving an Inactive caseworker keeps Inactive" would already pass against
the old list. Pin the display instead (the select shows Inactive).

## 13. [LOW] D7's team_member/unknown arms and D3's "stays the plain PATCH" do not match what the UI can reach

The edit form's KindPicker offers Tenant, Landlord, Partner, Caseworker,
Property Manager, Other - never team_member or unknown
(`KindPicker.tsx:36-56`), and Other's bases are tenant and landlord only
(`:60-71`). So D7's team_member -> Active and unknown -> Needs review arms are
API-only (the normalize fallback, `contacts.ts:1746-1760`). Say so, so the
plan does not build UI for them. Separately, D3's "A save that changes the
type AND sets a status stays the plain PATCH" is not what happens for a tenant
target: the form sends the PATCH and then `setTenantStatus`
(`ContactEditForm.tsx:519-548`).

## 14. [LOW] Unenumerated surfaces

- Writer: `routes/unmatchedEmail.ts:455-466` creates partner contacts with its
  own copy of the "tenant -> onboarding, landlord -> interested, else active"
  default. Unaffected today (unknown is not offered, `:73`), but it is a second
  copy of the rule D6 edits and section 4 does not list it.
- Reader: the dashboard Today fallback `routes/today/buildToday.ts:287-315`
  emits every unread unknown_1to1 thread with no status check. It runs only
  when GET /api/today 404s (`:1-24`), so low consequence, but it is a reader
  that disagrees with D5.
- Test fake: `app/test/helpers/contactsPartitionFake.ts:53-60` states the
  unknown partition's legal statuses as needs_review|active.
- Live refresh: the transition route emits no SSE event
  (`services/statusTransition.ts:609-636`), and the inbox and Today refetch
  only on conversation/placement/suggestion/tour events (`useInbox.ts:563`,
  `useToday.ts:4-6`). Today `needsTriage` changes only with a type change on
  the PATCH, which does emit `conversation.updated` (`contacts.ts:2077-2094`);
  under D9 it and the Inactive tag change on a header status change that
  emits nothing, so an inbox open in another tab stays stale until an
  unrelated event. Mounts refetch (`useInbox.ts:433-466`), so the e2e path is
  fine.

## 15. [LOW] D2 widens an existing check-then-write race to new pairs

The transition route validates `toStatus` against a read of the stored type
(`routes/statusTransition.ts:268-278`), then the service re-reads and writes
with no type guard (`services/statusTransition.ts:609-623`). A concurrent
re-type in that window can store an illegal pair. Pre-existing for tenants;
with every type now on the dropdown it can produce pairs like (landlord,
inactive). Worth one sentence (accepted, or a type expect on the write).
