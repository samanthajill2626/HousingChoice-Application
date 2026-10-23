# Plan review round 2 (reviewer A, continued) - unknown-inactive plan v2

Reviewed: plan v2 @43e971f5 (diff from v1 @3d6e9ec9 read in full, plus the
unchanged sections the changes touch), `adjudications.md` "Plan round 1"
(P1-P15), and reviewer B's `plan-r1-b.md`. Tree: main @916258ae. Read-only;
nothing run. The anchor sweep was re-run on v2: the same 175 blocks, with
the same expected non-matches only (blocks that anchor on text an earlier
task writes). The new anchors (S2.4 Edit E `routes/statusTransition.ts:269`,
S3.4 Step 7 Edit D `inboxFilters.ts:77-80`, S1.2 measure-script comment
`measure-unread-contact-coverage.ts:661-666`) match and are unique in their
files.

Order: new problems first (1-2 were missed by both reviewers in round 1;
3 comes from the round-1 changes), then the review of the changes, then the
adjudications.

---

## F1. [MEDIUM] The live re-read (S2.9) makes an open edit form write a concurrent change back: a lost update of another operator's status or type

What is wrong. `ContactEditForm` keeps every field's draft in state, seeded
once at mount, but diffs it against the live `contact` PROP at save time:
- `ContactEditForm.tsx:334` `if (kind.type !== null && kind.type !== contact.type) patch.type = kind.type;`
- `ContactEditForm.tsx:338` `if (firstName !== str(contact.firstName)) patch.firstName = firstName;`
  (and every other field the same way);
- the v2 status rule compares the `status` state against
  `initialStatus = defaultStatusForType(contact.type, str(contact.status))`
  (plan S4.4 3d) and `typeChanged = kind.type !== contact.type`.

The form is rendered with the page's live contact
(`ContactDetail.tsx:1341-1349`, `contact={contact}`). S2.9 (plan ~4180-4200)
now replaces that contact in place on EVERY `contact.updated` for the open
contact - its stated purpose is "a status or type change made elsewhere (the
edit form, another tab, another operator)". So:
- Operator A opens the edit form on an unknown contact (Needs review).
  Operator B marks it Inactive from the header. A's page re-reads; the form's
  prop now says `inactive` while its `status` state still holds
  `needs_review`. A fixes a typo in the name and saves: `statusTransition`
  (S4.4 3g, non-tenant, no type change) is `needs_review !== inactive`, true
  -> `setTenantStatus(needs_review)`. B's change is silently reverted, with a
  "Status -> Needs review" milestone attributed to A.
- Same shape for a type: B re-types the contact to landlord; A's `kind.type`
  is still `unknown`, now `!== contact.type`, so A's save re-types it back
  (the PATCH's classification fence is read by the server at PATCH time,
  `contacts.ts:1632-1636`, so it does not protect against this).
- Any field B changed is written back to A's stale draft value the same way.

Before this plan only `suggestion.updated` re-read the contact
(`useContact.ts:60-70`), and a filed suggestion does not change the contact's
fields, so the hazard was latent. S2.9 turns every status or type change by
anyone into a prop swap under an open form.

What it implies. The feature's own live-update path produces silent lost
updates in exactly the multi-operator case it exists for. No planned test
covers a prop change under an open form. Fix in the plan: the form diffs
against the contact AS OPENED (snapshot it at mount - a `useRef`/`useState`
of the opening contact - for every comparison and for `initialStatus` /
`typeChanged`), or ContactDetail passes the opening snapshot rather than the
live contact; add a test that re-renders the open form with a changed
`contact` prop and saves an unrelated field.

---

## F2. [MEDIUM] P12 is half-applied: the route's check read is consistent, but setTenantStatus still re-reads eventually and builds the audit and the timeline label from that read

What is wrong. S2.4 Edit E (plan ~3460-3466) makes the route's check read
`{ consistentRead: true }` so the edit form's follow-up write (type-change
PATCH, then `setTenantStatus`, S4.4) sees the new type. But
`setTenantStatus` reads the contact AGAIN, eventually consistent
(`app/src/services/statusTransition.ts:611`, unchanged by S2.3), and
`buildContactStatusTransitionPlan(contact, input)` takes from that second
read:
- the audit payload `from: contact.status` (`statusTransition.ts:167`);
- whether a milestone is written (`contact.status !== toStatus`, `:175`);
- the milestone label `statusLabelFor(contact.type, toStatus)` (S1.4).
The write itself is safe (conditioned on `expectedType = stored.type`, the
consistent read). So on the P12 flow - partner (Inactive) re-typed to tenant
with Searching picked - a stale second read returns (partner, inactive): the
audit records `from: inactive` instead of `onboarding`, and the timeline says
`Status -> searching` (the raw key: the partner map has no `searching`),
which breaks D4.5 ("labelled by the type the contact has AFTER the write")
and the "never a raw key" rule. The harness fake ignores `consistentRead`
(`twilioWebhookHarness.ts:2280-2282`), so no test can see it.

What it implies. Intermittent wrong audit provenance and wrong timeline text
in production, on the exact path P12 was accepted to fix. Fix: make the
service's own read consistent too (one more strongly consistent GetItem), or
hand the route's consistent `stored` into the setter; at minimum label by
`input.expectedType ?? contact.type`.

---

## F3. [LOW] The statusType fix leaves the Status select offering one type's list with another type's value while Other has no base

What is wrong. v2 tracks `statusType` (plan S4.4 3d/3e, ~7313-7356) but the
options still come from `statusOptionsFor(liveType)` (3i, plan ~7487) and
`liveType = kind.type ?? contact.type`. During the Other panel's base-less
step (`KindPicker.tsx:150`, `type: null`), a stored tenant that went through
Landlord shows the TENANT option list with the value `interested`. A
controlled `<select>` whose value is not among its options renders the first
option ("Needs review"), so the field misreports what the form holds. Save is
disabled while the type is null (`ContactEditForm.tsx:582`), and a base pick
re-derives correctly, so nothing is written wrongly. Reviewer B's F1 named
this ("must not let the select show an off-list value while the Other panel
holds type: null"); the P1 ruling does not address it.

What it implies. A transient display lie, not a data defect. Since
`statusType === kind.type` whenever `kind.type` is non-null, the select can
simply use `statusOptionsFor(statusType)` (and 3h's narrow likewise).

---

## F4. [LOW] The D2 "drops the row without a reload" rule rests on one 300 ms-debounced refetch over eventually consistent reads

What is wrong. The open Today page refetches once per `contact.updated`
(`useToday.ts:39` debounce 300 ms). The Needs-you-now row for an unknown
contact comes from the `(unknown, needs_review)` GSI (`today.ts:868-875`,
always eventually consistent) or from the unread pass, whose AR8 skip reads
the contact with a default GetItem (`today.ts:358-362`). If either is stale
at refetch time the row stays, and no further event arrives to correct it.
DynamoDB Local is strongly consistent, so the e2e (spec test 8) cannot see
it. This is the same pattern `conversation.updated` already relies on, so it
is a residual risk, not a new mechanism.

What it implies. Worth one sentence in the S2 report as a known prod-only
race; no change requested here (spec section 3 keeps the plan's choice of
event).

---

## Review of the round-1 changes (no further finding unless stated)

- AR17 restructure (S1.1 1f = former S3.4 Steps 2-5): correct. Every anchor
  in 1f is original main text (re-verified), S1.1 3f no longer touches the
  two docblock lines S3.4 Step 6 Edits C/D rewrite, so those now apply
  cleanly; Edit B's conditional covers the `Taken from` line S1.1 changes.
  `InboxBadRequestError` is already imported in `inboxUnknownTab.test.ts:12`.
  The RED list is right: before S1.1's order change the flipped honest
  cursor (`b:1`, `inactive`) is rejected, the reviewed fixtures are unread,
  and `inbox.integration.test.ts:485` loses its reviewed rows. After it, the
  pre-deploy cursor (`b:1`, `active`) is rejected and the block-start cursor
  resolves. S3.4 is now comment-only and its GREEN run covers the four files
  plus `src/routes/inbox` (for inboxFilters.ts). One leftover: S3
  "Contradictions" item 2 is kept with "SUPERSEDED by AR17" appended
  mid-sentence; it reads correctly, but deleting it would be cleaner.
- statusType (S4.4): sound for the reported paths. `statusType` is changed
  only in `handleKindChange`, which is the only `setKind` caller
  (`ContactEditForm.tsx:288`), so it cannot drift; at save time it always
  equals `kind.type`. The two new tests drive the real Other path
  (`KindPicker.tsx:223-252`: base options are `role="radio"` buttons named by
  their title, so `/Tenant/i` and `/Landlord/i` each match one). Both are RED
  on main (the old reset gives `needs_review`) and RED on the v1 rule. See F3
  for the residual display issue.
- Consistent reads (S2.9, S4.3): correct call shape
  (`endpoints.ts:1474-1486`), and the new assertions use
  `toHaveBeenLastCalledWith(id, undefined, { consistent: true })`, which
  matches. No existing test asserts exact `getContact` arguments on these
  paths. The suggestion.updated re-read becomes consistent too - harmless.
  But see F1: making the re-read correct makes the edit-form hazard
  deterministic rather than intermittent.
- P12 route read (S2.4): the spy test's "first getById of the request is the
  route's" holds (nothing earlier in the request reads contacts), and the
  race test still works (its spy forwards `opts`). See F2 for the missing
  half.
- P5/P6/P7/P8/P10/P11/P13/P15: applied as ruled. P11's reasoning is right:
  the fake hands back the live object (`twilioWebhookHarness.ts:2280-2282`)
  and `update` mutates it, so the old label code already reads the new type.
  The unknown -> partner case stays RED (the tenant map has no `active`), and
  so does the relabelled Inactive tenant -> unknown case.

## Adjudications contested

- P9 (AR21 to Cameron at the launch gate): concede. Deferring to the human is
  the right channel for a narrowing of an approved decision.
- No other ruling contested.
