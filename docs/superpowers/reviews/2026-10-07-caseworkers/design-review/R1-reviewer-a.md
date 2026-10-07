# Design review R1 - reviewer A (adversarial) - branch B (caseworkers)

- Date: 2026-10-07
- Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
  (revision 9), branch B only: D16-D21, the "(B)" lines of D6/D10/5.2/6/9,
  section 10, the B items of section 12.
- Tree: `W:/tmp/caseworkers` (`feat/caseworkers`, c1530f9d). Read-only; nothing run.
- Method: every claim about current behavior was checked in code and is cited
  `file:line`. Paths are relative to the repo root.

Summary: 15 findings - 0 BLOCKING, 2 HIGH, 4 MEDIUM, 9 LOW.

---

## F1 [HIGH] Three paths make a "caseworker"; only Make caseworker converts the record

**What is wrong.** B creates three ways to reach `type: partner, role: Caseworker`:

1. the KindPicker "Caseworker" choice (D16), in the create and edit forms;
2. the Unknown card's "Mark as Caseworker" (D16);
3. Make caseworker (D19).

Only path 3 is specified to:
- fill `organization` from agency or housing authority;
- REMOVE `housingAuthority` and `housingAuthority_source`;
- supersede a pending housing-authority suggestion;
- clear `agency`;
- stamp `type_source: manual` on a role-less partner.

D16 says the Caseworker choice "applies D19's refusals ... the choice is a
conversion, not a relabel". It gives the choice the REFUSALS but none of the
CONVERSION. Mark as Caseworker gets neither.

**Evidence.**
- Spec D16, D19 and section 9: both paths are listed as writers, with different
  behavior.
- The importer writes `housingAuthority` for every imported contact, unknown and
  partner included. Spec 1.2 says so, and the lean partner holds one
  (`app/src/lib/seed/lean.ts:170-176`).
- So the records these paths act on carry a housing authority today.
- After B, two places stop showing that value:
  - The header shows housing authority only when `type` is `tenant` (D21).
    Today the header (`dashboard/src/routes/contact/ContactDetail.tsx:1321-1333`)
    is the only place a partner's value shows.
  - The edit form mounts the org pickers for tenants only
    (`dashboard/src/routes/contact/ContactEditForm.tsx:592`, per the R2 re-check).
- Extraction skips partners (`app/src/jobs/extraction.ts:457`), so a pending
  housing-authority suggestion on a contact converted by path 1 can never
  resolve. D19 states this exact problem as its reason to supersede.
- Importer protection also differs. On a role-less partner:
  - The Caseworker choice is not a type change, so no `type_source` is stamped
    (D21 stamps only on a type change).
  - Make caseworker stamps it.
  - The importer SETs `type` and `status` on every run when there is no stamp
    (`app/src/lib/import/apply.ts:1079-1080`, :1144-1149).

**What it implies.**
- One "caseworker" ends up with a hidden, uneditable housing authority, no
  organization and a suggestion pending forever.
- Another, identical to the eye, is clean.
- The Caseworkers tab's organization filter then depends on which button staff
  pressed.

The spec must pick one:
- every path into partner + Caseworker runs the same conversion (D19's field
  moves, shared server code); or
- state that the Caseworker choice and Mark as Caseworker are relabels only, and
  drop the "conversion" sentence.

## F2 [HIGH] D21 changes what the unguarded type change does, so "keeps today's unguarded behavior" is false

**What is wrong.** D16 and section 12 say the generic edit-form type change
"keeps today's unguarded behavior (pre-existing)". D21 then adds a new effect to
that same unguarded path: on any staff type change between tenant, landlord and
partner, it re-types every old-type thread.

- Today the PATCH flips ONLY `unknown_1to1` threads (`app/src/routes/contacts.ts:1876-1888`, flipType :1880).
- So a tenant re-typed by mistake keeps its `tenant_1to1` thread today.

**Evidence.** These readers find a tenant's thread BY TYPE:
- tour reminders (`app/src/jobs/tourReminders.ts:1091-1099` - no match is
  `unresolvable: 'no_conversation'`);
- the tour-reminders route (`app/src/routes/tourReminders.ts:1027`);
- placement nudges (`app/src/jobs/placementNudges.ts:517-519`);
- the timeline (`app/src/routes/contactTimeline.ts:947`);
- manual extraction eligibility (`app/src/routes/contacts.ts:2397`).

D19's own refusals (`caseworker_open_tour`, `caseworker_open_placement`) exist
because a conversion breaks exactly these. Yet B leaves the Partner and Landlord
choices unguarded, and D21 makes them re-type the thread.

**What it implies.** After B, re-typing a tenant with a scheduled tour to
Landlord or Partner is no longer cosmetic: their reminders stop with
`no_conversation`. Section 12's filed follow-up ("a tenant ... can be re-typed
today") understates B's own contribution.

The spec must either:
- apply D19's refusals (or a confirm that names them) to every type change away
  from tenant; or
- limit D21's old-type re-type to Make caseworker and the Caseworker choice, and
  leave the generic change flipping only `unknown_1to1`, as today.

## F3 [MEDIUM] The Caseworker-choice refusals have no server rule, a self-contradictory scope, and an obvious bypass

**What is wrong.**

(a) **No server trigger.** The choice is a dashboard button. On the wire it is a
contacts PATCH `{type: 'partner', role: 'Caseworker'}`: the edit form sends
`type` only on change and `role` only on change
(`dashboard/src/routes/contact/ContactEditForm.tsx:276-278`).
- The spec never says what the SERVER refuses.
- Section 6's PATCH line lists no `caseworker_*` 409.
- A builder may implement the refusals client-side only.

(b) **Scope contradiction.** D16 scopes the refusals to "a contact that is a
tenant today", but lists "landlord of record", which only a landlord can be.
- D19's third bullet makes landlord-based "caseworkers" a target population.
- Those landlords, converted with the Caseworker choice, skip the
  landlord-of-record refusal.
- Unit `landlordId` would then point at a partner.

(c) **Two-click bypass.** Pick Partner (unguarded, F2), save, then pick
Caseworker. The second save is partner to partner, so no refusal applies.

(d) **The refused state comes back anyway.**
- Tour reopen has no contact-type check (`app/src/routes/tours.ts:1641-1680`).
- Tour create checks no contact at all (`app/src/routes/tours.ts:310-360`).
- Placement create checks only that the contact exists
  (`app/src/routes/placements.ts:565-580`).
- So a converted caseworker can hold an "open tour as the tenant" one click
  after Make caseworker refused it.

**What it implies.** The "conversion, not a relabel" guarantee is a UX gate at
two of five doors, not an invariant. The spec must:
- state the server rule: stored `type` is tenant or landlord AND the patched
  result is partner + Caseworker;
- name the 409 codes on the PATCH;
- fix the scope sentence;
- say plainly that reopen and create can recreate the state, or extend the
  guard.

## F4 [MEDIUM] D21's "a thread typed for some other identity is left alone" is decided by type alone

**What is wrong.** D21 re-types threads on EVERY phone and email in the contact
(today only the scalar primary phone, `app/src/routes/contacts.ts:1866-1871`).
It protects other people's threads only by thread TYPE.

- Two contacts on one phone share one 1:1 thread
  (`app/src/jobs/broadcastFanOut.ts:1313-1318`).
- A same-type shared thread (two tenants on a household phone) passes the type
  test and is re-typed when ONE of them is converted.

**Evidence.** A thread already records whose it is: `participants[0].contactId`
(`app/src/routes/today.ts:1102-1105`; set by `setParticipantsIfAbsent`,
`app/src/routes/public.ts:286`). The spec's mechanism ignores it.

**What it implies.**
- Converting one household member to a caseworker re-types the other tenant's
  thread.
- That breaks the other tenant's reminders (F2's readers).
- Widening from primary phone to every phone raises the exposure.

Re-type only threads whose linked participant is this contact (or that have no
linked participant).

## F5 [MEDIUM] D19 supersedes only the housing-authority suggestion; its own reason covers every pending tenant-profile suggestion

**What is wrong.** D19 supersedes a pending housing-authority suggestion
"(a partner is never extracted again, so it would never resolve)". The same is
true of every other pending suggestion on a converted tenant: `firstName`,
`lastName`, `voucherSize`, `pets`, `evictions`, `tenure`, `porting`, `address`
(`app/src/services/extraction/schema.ts:24-40`).

**Evidence.**
- The PATCH supersedes only suggestions keyed by CHANGED field names
  (`app/src/routes/contacts.ts:1630-1641`, :1678-1710).
- An open issue already names this and proposes deleting all pending
  suggestions on a type change: `docs/issues/stale-suggestions-survive-contact-retype.md`.

**What it implies.**
- The AI run log keeps those verdicts `pending` forever, skewing the accuracy
  record the extraction feature exists to produce.
- The accept routes stay open for them on a partner.

B builds the type-change hook (D21). It should adopt option (b) of that issue
for every staff type change, or cite the issue and say why not.

## F6 [MEDIUM] Make caseworker's write path is described two incompatible ways

**What is wrong.**
- D19: Make caseworker writes "in one write through the classification fence
  (`contactsRepo.update`...)", a REPO call.
- Section 9: both the caseworker-review route and the Caseworker choice go
  "through the contacts PATCH's classification fence", the ROUTE.

**Evidence.** Much of what makes a type change correct lives in the PATCH
route, not the repo:
- the type-suggestion drain and AI verdicts (`app/src/routes/contacts.ts:1712-1794`);
- provenance clears (:1621-1628);
- thread re-type and `conversation.updated` events (:1872-1888);
- the `contact_updated` audit (:1913-1917);
- the `contact_status_changed` milestone (:1923-1935);
- the `suggestion.updated` event (:1797-1799).

**What it implies.**
- A dedicated route that calls the repo must re-implement all of this, and will
  drift.
- If the route instead reuses the PATCH path, the spec should say so.

Name the one server function both the PATCH and Make caseworker call, and list
the side effects Make caseworker must produce: audit, SSE, milestone, drain.

## F7 [LOW] The caseworker-review route's input domain is unspecified

**What is wrong.** `POST /api/contacts/:contactId/caseworker-review` does not say
what happens for:
- an `unknown` or `team_member` contact. Stamping `type_source: manual` on an
  unknown contradicts D21's "triage of an unknown contact does not stamp it".
- a deleted contact.
- a contact that is already a caseworker (idempotent, or 409?).
- `dismiss` on a caseworker.

The refusal checks (placements, tours, a full unit scan) and the write are
separate steps, and the race is not stated as accepted.

## F8 [LOW] Make caseworker throws away off-list values, and "exactly a list name" is ambiguous

**What is wrong.**
- Make caseworker REMOVEs `housingAuthority` and clears `agency` even when
  neither was copied to `organization`.
- An off-list agency such as "Hope Atl." is the only employer hint on the
  record. It is discarded, and silently leaves "Not on the list" without staff
  ever settling it.
- "When it is exactly a list name" is ambiguous for an agency name sitting in
  the housing authority field:
  - it is NOT on the list for that field (D3);
  - but it IS a valid `organization` value (`KINDS_FOR_FIELD.organization` takes
    both kinds).

**What it implies.** State whether an other-kind name in the housing authority
field fills `organization`. Then either keep off-list values (refuse or prompt)
or state the loss as accepted.

## F9 [LOW] The "partners" usage column and organization off partners

**What is wrong.**
- D17 says the server accepts `organization` on any contact.
- D21 is silent on `organization` when a caseworker is re-typed back to tenant
  or landlord.
- So organization holders can be non-partners. They are then counted under a
  "partners" label, shown on no page, and absent from the Caseworkers tab.
- "A record holding one name in two fields counts once per entry" does not say
  which column carries that record when the two fields map to different columns
  (`otherContacts` for `housingAuthority` vs `partners` for `organization`).

## F10 [LOW] Dropping the "Case worker" placeholder does not stop tenant-based caseworkers

**What is wrong.** The Other role input also offers a datalist built from the
role vocabulary (`dashboard/src/routes/contact/ContactCreateForm.tsx:258`).
- The PATCH adds every written role to that vocabulary
  (`app/src/routes/contacts.ts:1943-1958`).
- So B's own Caseworker choice writes "Caseworker" into the list.
- Historical "Case worker" roles are already in it.

Other + "Caseworker" + base Tenant stays one autocomplete away. Either map a
caseworker role typed in Other to the preset, or keep caseworker roles out of
the suggestions.

## F11 [LOW] Gaps in the Possible caseworkers criteria

**What is wrong.**
- **Deleted contacts:** in or out of the list is unspecified.
- **Relationship signal:** it can only see rows held by tenant, landlord and
  partner contacts, because only those three partitions are read. Rows held by
  unknown or team_member contacts are missed.
- **Asymmetric criteria:**
  - a tenant's role "mentions caseworker or case manager" (bullet 1);
  - a landlord's role must "say caseworker" (bullet 3), so a landlord-based
    "Case manager" is missed.
- **Partners with a non-caseworker role** (for example "Case Manager" set through
  the API) are in neither the tab nor the Possible list.

## F12 [LOW] Type changes made by the importer never re-type threads

**What is wrong.** D21's title promises threads stay consistent with type
changes, and I2 says "a partner's share never mints a `tenant_1to1` thread".

- The importer still SETs `type` on every contact without `type_source`
  (`app/src/lib/import/apply.ts:1079-1080`). A "Caseworker" review note makes
  that `partner` (`app/src/lib/import/reviewNotes.ts:123-125`).
- It does this with no thread re-type.
- A share then lands in the old `tenant_1to1` thread, because
  `createOrGetByParticipantPhone` returns any open thread whatever its type
  (`app/src/jobs/broadcastFanOut.ts:871`).

This is pre-existing, but I2 should say it covers staff changes only.

## F13 [LOW] The A2P position on property shares to partners is unstated

**What is wrong.**
- The registered campaign describes listing texts to voucher holders
  (`docs/a2p/campaign-resubmission.md:51-58`, :113-116).
- D20 sends the same listing text to caseworkers and any partner.
- D20's "every existing gate applies unchanged" covers consent and opt-out, not
  the declared use case.

The non-goal excludes editing the campaign documents, not deciding whether the
use case covers this. One sentence stating the position (covered, or an accepted
risk) is owed.

## F14 [LOW] Preview rows show a partner's housing authority as voucher facts

**What is wrong.**
- A seed resolves with `voucherSize` and `housingAuthority`
  (`app/src/routes/broadcasts.ts:442-447`).
- D20 puts no type on preview rows.
- So a partner seed that still holds a housing authority shows it as if it were
  a tenant's voucher authority. That covers Renee, imported caseworkers, and
  contacts converted by path 1 of F1.

Either drop these fields for non-tenant rows, or accept and say so.

## F15 [LOW] The header rule also hides housing authority on unknown contacts

**What is wrong.** D21 keys the header facts on `type === 'tenant'`. Today they
show for every non-landlord (`dashboard/src/routes/contact/ContactDetail.tsx:1321-1333`).

- Imported `unknown` contacts carry an imported housing authority.
- That value is a triage hint ("this is a tenant").
- After B it disappears from the Unknown page header.

State the consequence or include `unknown`.
