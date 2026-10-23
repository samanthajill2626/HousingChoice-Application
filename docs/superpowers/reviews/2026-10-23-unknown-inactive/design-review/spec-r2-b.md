# Spec review r2-b (adversarial, continued reviewer) - unknown-inactive rev 2

Spec: `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` rev 2
(2c8a125c). Inputs also read: `adjudications.md`, `spec-r1-a.md`. Repo read
only; no tests, servers or git writes. Code cited by file:line as read.

Order: new defects first (most of them in the rev-2 text itself), then the
adjudication contests, then a note on which fixes hold.

---

## 1. [HIGH] D3's "on a type change the field moves to the new type's first step, and what it shows is saved" silently demotes contacts on a role-only change or a change-and-back

What is wrong. The new D3 bullet resets the Status field on "a type change"
and then makes the reset value a WRITE ("Whatever the field shows is what is
saved"). It never says what "a type change" is measured against. The form's
only hook is `handleKindChange` (`ContactEditForm.tsx:287-295`), which fires on
EVERY KindPicker change, base type or role. Two everyday paths:

- Role-only. A landlord at `active` is switched to the Property Manager preset,
  which is `{type:'landlord', role: PM_ROLE}` (`KindPicker.tsx:76-78`): the kind
  changed, the type did not. If the reset keys on the kind change, the field
  becomes Interested. Then, because `kind.type === contact.type`, no type is
  sent (`ContactEditForm.tsx:334`), and the landlord status rides the PATCH
  whenever it differs from the stored value (`:345-347`). The onboarded
  landlord is saved as Interested.
- Change and back. A tenant at `searching` clicks Landlord (field moves to
  Interested) and then Tenant again (field moves to Onboarding, "the NEW
  type's first step"). The type is back to the stored one, so there is no type
  change, but `tenantStatusChanged` is true (`:519-521`) and
  `setTenantStatus('onboarding')` runs (`:541-548`). The Searching tenant is
  demoted.

What it implies. Before rev 2 a Status reset only happened when the old value
was illegal for the new type (`:290`), so neither path could write. Rev 2 adds
a silent write on both. The rule must be stated against the STORED base type:
reset only when the live base type differs from `contact.type`, and restore
the stored status when the user returns to it. Test 7 must cover the PM
preset on an Active landlord and a change-and-back on a Searching tenant.

## 2. [MEDIUM] D3's "the form sends it as an explicit status, which the server honors" is false for a tenant target: one save, two status writes, two timeline entries

What is wrong. For a tenant target the PATCH never carries `status` (the
`!isTenant` guard, `ContactEditForm.tsx:345`). The server therefore
auto-advances to `onboarding` (`contacts.ts:1723-1729`) and writes the
"Status -> Onboarding" milestone (`contacts.ts:2129-2139`). Only after that
does the form's `setTenantStatus` apply the field value (`:541-548`). D3's
tenant arm says exactly that ("followed by the existing setTenantStatus
call"), which contradicts the bullet above it.

What it implies. Under the new default, almost every retype to tenant makes
the second write. The cases:
- The field shows Onboarding. The second write is redundant: an audit row from
  onboarding to onboarding, `status_source: 'manual'` stamped where the
  auto-advance deliberately leaves it unset (`contacts.ts:1719-1722`), and,
  after D2, a notify.
- The field is set to Inactive or Searching. The contact passes through
  Onboarding: one save leaves two timeline milestones, with a window in
  between where it is an Onboarding tenant (the blast audience,
  `blastAudienceRules.ts:22`).
- With the old form, a retype to tenant left a legal stored status selected,
  so it made one write.

The spec should pick a rule: either the tenant-target PATCH carries the
explicit status (it already validates it against the new type,
`contacts.ts:625-631`), or the form skips `setTenantStatus` when the field
equals the server's auto-advance. Either way, drop the false sentence.

## 3. [MEDIUM] D2's notify is specified "the same way a contact PATCH does today", and today that mechanism sends nothing for exactly the contacts this feature targets

What is wrong. The PATCH emits `conversation.updated` only for a contact that
has linked threads AND either flipped its type or has a resolved name
(`contacts.ts:2077-2094`: the outer
`convType !== undefined || displayName !== null` test, and
`if (!flipType && displayName === null) continue`). A status-only change on an
UNNAMED unknown - the usual wrong number or spam caller - emits nothing. A
contact with no linked thread can emit nothing at all through this event. The
triage pass still lists such a contact on Today (`today.ts:845-941` reads the
contact partition, not threads), and after D6 every API-created unknown is
one.

What it implies. "The plan picks the event" plus "the same way a contact PATCH
does" points the builder at a mechanism that misses the main case. The
observable rule (an open Today drops the row, an open Inbox shows the
tag/chip) is right, but the stated precedent cannot meet it. Say "for every
status change, regardless of name or type", and either emit per linked thread
with no name gate, or use an event Today and Inbox subscribe to that is not
thread-bound (today they listen to `conversation.updated` and its siblings
only: `useToday.ts:4-6`, `useInbox.ts:563`). Test 2's "notifies open
Today/Inbox" must use an unnamed unknown.

## 4. [MEDIUM] D5's collect-loop skip is not scoped to `unknown_1to1`; built as written it also removes Inactive tenants and caseworkers from Unreplied, contradicting D4

What is wrong. Moving the skip into the collect loop (correct, per round 1)
also moves it to a loop that feeds BOTH sections: `unreadOneToOne` supplies
the unknown_1to1 Needs you now rows and the tenant/landlord/partner Unreplied
rows (`today.ts:704-752`, emit split at `:784` and `:806-814`). D5 says "It
SKIPS a thread whose contact's status is inactive", with no thread-type
condition. D4's "Two differences remain" says an Inactive tenant's unread text
STILL shows in Unreplied, and so would an Inactive caseworker's
(partner_1to1).

What it implies. The natural build - one `if (inactive) continue` beside
`isDeletedContact` - quietly widens the change to every type and breaks D4's
own stated difference. Test 4 does not catch it. The skip must be conditioned
on `conv.type === 'unknown_1to1'`. Test 4 needs: "an Inactive tenant's unread
thread is still in Unreplied", and the same for an Inactive caseworker.
Related: an Inactive team_member (new under D1) is unknown_1to1, so it IS
skipped. D4's list of differences should name that too.

## 5. [MEDIUM] D7's new guarantee "a same-type PATCH never resets a status" is false: the auto-advance branch has no same-type guard

What is wrong. Rev 2 adds `newType !== stored.type` to the normalize fallback
only. The branch just above it fires on
`convType !== undefined && !('status' in parsed.patch)`
(`contacts.ts:1723-1729`) and never compares against the stored type. Of the
nearby guards, only the type-change refusal and D21 test
`newType !== stored.type` (`contacts.ts:1789`, `:1805-1806`). So
`PATCH {type:'tenant'}` on a Searching tenant writes Onboarding, and
`{type:'partner'}` on an Inactive caseworker writes Active.

What it implies. The rev-2 sentence states a guarantee the mechanism does not
give. It is reachable beyond raw API calls: the edit form sends `type`
whenever `kind.type !== contact.type` against the form's possibly STALE
contact prop (`ContactEditForm.tsx:334`). With a colleague's retype landing
first, the "change" becomes a same-type PATCH. Either guard the auto-advance
the same way, or narrow the sentence to the fallback. Test 3's "Same-type
PATCH: status unchanged" fails against the current auto-advance unless it
does one or the other.

## 6. [LOW] D5's fallback rule cannot be implemented as written

"The dashboard's Today fallback (`buildToday.ts:287`) applies the same rule if
it builds that row." The fallback builds rows from `ConversationSummary`,
which carries no contact status (`dashboard/src/api/types.ts:561-580`), and it
runs only when `/api/today` 404s (`buildToday.ts:1-24`). Say "accepted: the
fallback cannot see status", or add the field. Do not leave a rule a builder
cannot meet.

## 7. [LOW] D5's team_member citation does not show what it claims

"team_member threads are also `unknown_1to1` (`contacts.ts:537-543`)". Those
lines show only that a retype to team_member propagates NO thread type. What
creates the `unknown_1to1` thread for a team member is
`webhooks/twilio.ts:221-232` and `lib/voiceMasking.ts:28-39`. Cite those.

## 8. [LOW] The seed ladder for an Inactive non-tenant is unspecified, and the obvious edit puts Active into an unknown contact's history

Section 4 says `history.ts` `OTHER_LINEAR` and the non-tenant ladder change so
that "an Inactive non-tenant gets a trail". One ladder serves partner,
team_member AND unknown (`history.ts:215-220`, `:455-465`). Appending
`inactive` to `needs_review -> active` gives an unknown contact a seeded
needs_review -> active -> inactive trail, through a status D1 makes illegal
for it. State that inactive is a branch from needs_review (an override, like
landlord Parked at `history.ts:205`) or a per-type ladder.

## 9. [LOW] Goal 3 still holds for four of five types: landlord header and form write differently

D3 keeps the landlord form on the plain PATCH (park reason, accepted from
round 1). The landlord header uses the transition route
(`ContactDetail.tsx:935-955`), which stamps `status_source: 'manual'` and
writes `tenant_status_changed`. The PATCH stamps neither and writes
`contact_updated` (`contacts.ts:2119-2123`). D3's "both places write the same
`status_source`, audit event and timeline entry" is said of partner,
team_member and unknown only. Goal 3 should say landlord is the accepted
exception. The alternative is to pass the typed park reason as `reason` on
the transition (`services/statusTransition.ts:164`), which would make Goal 3
true for every type.

---

## Adjudication contests

- M9 (extraction not suppressed): CONCEDE. A type suggestion for a returning
  contact is a defensible product call, and the spec now narrows the promise
  to Needs you now. One residue: "Suppressing AI extraction or AI suggestions
  for Inactive contacts" is out of scope by the PLANNER's call. No Cameron
  quote supports it (intent.md is the record). It reaches Today (the AI group,
  `today.ts:947-976`) and costs a model run per spam text. It belongs on the
  planner's list of calls for Cameron at the spec gate, next to D7/D8/D9.
- M19 (status-flip watch item): CONCEDE, for a stronger reason than the one
  given. "Duplicates nothing on screen" is only half true: `appendPage` keeps
  the ALREADY-LOADED copy and drops the fresh one (`inboxListMerge.ts:
  145-147`), so a flipped row would show stale. But D2's notify now triggers a
  head read on every open inbox, and a complete page one replaces the head
  while keeping only tail rows not in it (`inboxListMerge.ts:130`). That heals
  a page-one flip at once. One fact for the watch item: Inactive unknowns now
  never leave the partition, so the issue's reopen trigger ("the live
  partition exceeds one page", issue body paragraph 1) is a matter of time,
  not a hypothetical.

## Fixes checked and holding

- M1: the collect-loop placement is correct, and the memoized read is real
  (`today.ts:358-381`, `:743-747`). Only the scoping in finding 4 is missing.
- M2: tenant and landlord save paths are unchanged, so the park reason is
  safe (`services/statusTransition.ts:164`).
- M4 / D9 chip: "today's rule except false when inactive" keeps team_member
  behavior and needs only the contact already in hand (`inbox.ts:1036`,
  `:1116`).
- M18: the conditional write is feasible with the repo's existing `expect`
  option (`contactsRepo.ts:732`, `:849`).
- M7: the supersession is now named. M16 and M10 are now accurate.
