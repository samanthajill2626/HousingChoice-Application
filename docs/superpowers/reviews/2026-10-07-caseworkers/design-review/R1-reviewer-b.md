# R1 - adversarial design review, branch B (caseworkers) - reviewer B

Date: 2026-10-07. Spec: `docs/superpowers/specs/2026-10-06-clean-org-names-and-caseworkers-design.md`
(revision 9). Tree: `W:/tmp/caseworkers` (`feat/caseworkers`, c1530f9d). Scope: B only
(D16-D21, the (B) lines of D6/D10/5.2/6/9, section 10, the B items of 12). Read-only;
nothing was run. Code is cited by file:line as read in this tree.

Severity is consequence-if-shipped. 4 HIGH, 4 MEDIUM, 5 LOW. No BLOCKING: every finding
can be fixed in the spec before the plan is written.

---

## F1. [HIGH] The "notes mention caseworker" signal lists real tenants, and Make caseworker on one is a one-click, unrecoverable conversion

**What is wrong.** D19's first bullet lists tenants "whose notes carry the AI's
'Identified as a caseworker' line or those words (match the words ...)". "Those words"
(caseworker / case manager) are exactly what a TENANT's notes say about the tenant's OWN
caseworker. The AI is explicitly taught that a tenant mentioning their caseworker is not
a caseworker, and its note lines are "secondary facts about the client" - a tenant's
caseworker is such a fact. Staff notes on tenants do the same. So the list fills with
genuine tenants, each carrying a "Make caseworker" button open to every signed-in user
(D19, planner default).

Make caseworker on a tenant with no open placement or open tour (onboarding, searching,
no tour yet - the common case) is NOT refused, and it: retypes to partner, REMOVEs
`housingAuthority` and its source stamp, clears `agency`, retypes the threads, stamps
`type_source: manual` (so a re-import can no longer repair type, status or the removed
authority). The old values are not recoverable from the audit: `contact_updated` records
field NAMES only.

**Evidence.**
- AI rule: a mentioned caseworker is not the contact - `app/src/services/extraction/prompt.ts:94`;
  note lines are client facts - `prompt.ts:99-101`; the caseworker example `prompt.ts:93`.
- Audit payload is `fields: parsed.changedFields` (names only) - `app/src/routes/contacts.ts:1913-1917`.
- The importer's fill-only authority write is the only automatic repair path, and D21's
  guard switches it off for `type_source: manual` - `app/src/lib/import/apply.ts:1128-1136`.
- The spec does not say WHICH notes field (`notes` or `staff_notes`) is matched.

**Implies.** Either match only the AI's own line ("Identified as a caseworker", which
the prompt mints only for a self-identified caseworker, `prompt.ts:86-93`) and drop "those
words", or keep the word match as a weak signal that does not offer Make caseworker
directly on a tenant row (a confirm naming the tenant facts that will be removed, or
admin-only for tenant-typed rows). Name the notes field. Have Make caseworker record the
removed housingAuthority/agency values in its audit event so a mistaken conversion can be
undone.

---

## F2. [HIGH] Three ways to make a caseworker, three different records; the Caseworker-choice guard is a slogan

**What is wrong.** B creates a caseworker by (a) the KindPicker "Caseworker" choice
(PATCH `{type: partner, role: Caseworker}`), (b) "Mark as Caseworker" on the Unknown card
(the same PATCH), (c) Make caseworker (the new route). Only (c) does D19's writes: REMOVE
housingAuthority + `housingAuthority_source`, supersede the pending housing-authority
suggestion, clear agency, derive `organization`. (a) and (b) leave the tenant facts in
place. After (a) on a tenant: the header hides the authority (D21); the edit form shows
no housing authority or agency picker for a non-tenant (`dashboard/src/routes/contact/ContactEditForm.tsx:559-600`,
gated on `isTenant`), so the stale value is invisible and uneditable; the pending
housing-authority chip can never resolve (a partner is extraction-ineligible,
`app/src/jobs/extraction.ts:457`); the contact stays in the `byHousingAuthority` GSI and
in Settings usage as an "other contact" user of the name; and no `organization` is
derived even when the agency is a list name.

D16 says the Caseworker choice "applies D19's refusals ... the choice is a conversion,
not a relabel". The mechanism cannot deliver that:
- The choice saves through the same PATCH as the generic type change, which D16 keeps
  unguarded. The server can only key the refusal on the body (`type: partner` AND
  `role: Caseworker` on a stored tenant). Saving "Partner" first (unguarded, role `''`)
  and then "Caseworker" (partner -> partner, no tenant left to guard) bypasses it in two
  saves; the second save is not a type change, so it also gets no `type_source` stamp and
  none of D19's writes.
- The refusal is scoped to "a contact that is a tenant today". A LANDLORD of record or
  roster member picked as Caseworker in the edit form is unguarded, though D19 refuses
  exactly those (`caseworker_landlord_of_record`, `caseworker_on_roster`) for Make
  caseworker.
- The spec does not say what the PATCH answers on a refusal (the 409 codes are defined
  for the caseworker-review route only, section 6).

**Evidence.** The edit form sends `type` only when it changes and `role` only when it
changes - `ContactEditForm.tsx:276-278`; the PATCH's generic type handling -
`contacts.ts:1473-1546`; D16, D19, section 9 ("both through the contacts PATCH's
classification fence").

**Implies.** One conversion, every entry point routed to it: the Caseworker choice on a
tenant or landlord should run Make caseworker (same refusals, same writes), and on an
existing partner should run Make caseworker's writes too (or the spec says why not). Say
what Mark as Caseworker does with an imported authority/agency on an unknown contact. If
the guard stays PATCH-side, state the two-step bypass as accepted.

---

## F3. [HIGH] D21 makes the "unguarded" generic type change break tour reminders - the spec says it keeps today's behavior

**What is wrong.** D16 and section 12: "The generic edit-form type change keeps today's
unguarded behavior (pre-existing)". D21 changes that behavior: a staff type change now
RE-TYPES the contact's old-type threads. Today the PATCH flips ONLY `unknown_1to1`
(`contacts.ts:1876-1884`), so a tenant with an open tour who is re-typed through the
unguarded path keeps a `tenant_1to1` thread and the tour machinery still finds it. After
B that thread becomes `landlord_1to1` / `partner_1to1`, and every reader that finds the
tenant's thread by type stops finding it:
- tour reminders: `app/src/jobs/tourReminders.ts:1092-1099` -> `unresolvable: 'no_conversation'`;
- scheduled-send suppression for a tour: `app/src/routes/tourReminders.ts:1027`;
- the contact timeline's tenant thread for placement nudge items: `app/src/routes/contactTimeline.ts:947`;
- placement nudges' tenant-rung lookup: `app/src/jobs/placementNudges.ts:518-519` (it
  falls through to mint, where `createOrGetByParticipantPhone` returns the re-typed thread:
  it sends, into a thread typed for another identity).

**Implies.** Either apply D21's re-type only on the guarded paths (Caseworker choice,
Make caseworker, Unknown triage) and leave the generic path's thread behavior as today,
or guard the generic path with the same open-tour / open-placement refusals. The spec
cannot both re-type on the generic path and call that path unchanged.

---

## F4. [HIGH] Existing partners' threads are never re-typed, so shares to imported caseworkers land in `unknown_1to1` threads

**What is wrong.** D21's re-type triggers on "a contact's type change between tenant,
landlord and partner". The largest population D19 serves is role-less PARTNERS - every
imported caseworker. Every imported one-to-one thread is written `unknown_1to1`
(`app/src/lib/import/apply.ts:1208`) and the importer typed these people `partner`
directly, so no triage ever flipped their threads. Make caseworker and the Caseworker
choice on such a partner are partner -> partner: not a type change, so by D21's trigger
nothing is re-typed (the edit form does not even send `type`, `ContactEditForm.tsx:276`;
the PATCH flip needs `type` in the body, `contacts.ts:1473-1474`). D19 nonetheless says
Make caseworker "re-types the contact's open one-to-one threads (D21)" - the two
statements disagree for exactly this population.

Consequence for D20: a share to that caseworker does not mint `partner_1to1`;
`createOrGetByParticipantPhone` returns the existing open thread whatever its type
(`app/src/repos/conversationsRepo.ts:1252-1264`), so the share posts into the
`unknown_1to1` thread, and every reply surfaces on Today as "New unknown contact" in
needs-you-now (`app/src/routes/today.ts:784-806`, keyed on the THREAD type, not the
contact type). I2 ("a partner's share never mints a tenant_1to1 thread") holds but does
not guarantee the thread a share USES is typed for a partner. The same holds for partners
converted from tenant before B (the old PATCH left their `tenant_1to1` threads alone).
Section 11: "Branch B: deploy only. No script" - nothing backfills.

**Implies.** Make caseworker and the Caseworker choice re-type the contact's
`unknown_1to1` (and old-type) threads whether or not `type` changed; or the D20 send
re-types a typed partner's `unknown_1to1` thread before posting; or B ships a backfill.
State which, and widen I2 to the thread a share uses, not only one it mints.

---

## F5. [MEDIUM] Make caseworker supersedes only the housing-authority suggestion; every other pending tenant suggestion is stranded on Today

**What is wrong.** D19's reason for superseding the pending housing-authority
suggestion - "a partner is never extracted again, so it would never resolve" - applies
equally to every other pending suggestion a tenant can carry (voucherSize, address,
pets, firstName/lastName, ...). Those survive the conversion. The partner page renders no
suggestion chips (none in `dashboard/src/routes/contact/PartnerFile.tsx`; the header name
chips are tenant/unknown only, `ContactDetail.tsx:593`), yet Today's "AI suggestions"
group lists every contact with pending suggestions (`app/src/routes/today.ts:955-975`)
and links to that page: a permanent Today row whose target offers no action. The class is
pre-existing (`docs/issues/stale-suggestions-survive-contact-retype.md`); B makes it
reachable by design.

**Implies.** Make caseworker supersedes ALL of the contact's pending suggestions (with
verdict stamps), not only housingAuthority - or the spec states the leftover rows as
accepted and cites the issue.

---

## F6. [MEDIUM] Make caseworker destroys the caseworker's employer when it is not yet a list name

**What is wrong.** Make caseworker derives `organization` only when agency or
housingAuthority is "exactly a list name", then REMOVEs housingAuthority and clears
agency unconditionally. For a caseworker whose employer sits there as an off-list value
(an agency not yet on the list, a spelling the cleanup left for Settings), the only
recorded clue to the organization is deleted and `organization` is left absent "for staff
to pick" with nothing left to pick from. It also silently drops that value out of
Settings' "Not on the list" section, which is where A said such values get settled. The
audit keeps field names only (`contacts.ts:1913-1917`).

**Implies.** When neither value is a list name: keep the source fields, or carry the old
text into the response / the audit payload / a note so staff can add it through "Is this
really new?", or refuse with a prompt to settle the value first. State which.

---

## F7. [MEDIUM] Make caseworker's mechanism is contradictory and its side effects are unenumerated

**What is wrong.** Section 9 says the caseworker-review route and the Caseworker choice
go "through the contacts PATCH's classification fence". D19 says Make caseworker is "one
write through the classification fence (`contactsRepo.update`, so
`classification_revision` bumps)" in a separate route. Those differ: the repo bumps the
revision, but the PATCH ROUTE owns the side effects - provenance clear and suggestion
supersession with AI verdict stamps (`contacts.ts:1600-1710`), the `suggestion.updated`
event (`:1793-1795`), the thread re-type with `conversation.updated` events and the
display-name denorm (`:1843-1888`), the `contact_updated` audit (`:1913`), the
`contact_status_changed` milestone (`:1923-1935`), and the role vocabulary write
(`:1941-1960`). D19 names some (status, provenance, the housing-authority suggestion,
threads) and is silent on the rest. And it is not "one write": a contact write, N thread
writes and a suggestion write, with no stated order or partial-failure rule (the refusal
reads also race a tour or placement created between check and write).

**Implies.** Say whether the route reuses the PATCH handler's logic or composes its own,
list each side effect it must produce (audit, milestone, events, vocabulary - or
deliberately not), and state the order and what a partial failure leaves.

---

## F8. [MEDIUM] Dropping "Case worker" from the Other placeholder does not stop the picker suggesting it - B's own writes add it

**What is wrong.** D16 removes "Case worker" from the Other role placeholder because
tenant/landlord-based caseworkers are "exactly the records D19 exists to clean up". But
the Other role input's datalist comes from the role VOCABULARY
(`roleSuggestions={vocab.roles}`, `ContactEditForm.tsx:531`, `ContactCreateForm.tsx:258`;
datalist `KindPicker.tsx:153-171`), and every PATCH and POST that writes a role adds it
to that vocabulary (`contacts.ts:1118`, `:1941-1960`). Existing "Case worker" roles are
already in it, and every Caseworker choice (and Make caseworker, if it goes through the
PATCH) adds "Caseworker". The Other box on a Tenant or Landlord base keeps offering the
caseworker role.

**Implies.** Filter `isCaseworkerRole` roles out of the Other suggestions, or make Other +
a caseworker role resolve to the Caseworker preset, or keep the preset role out of the
vocabulary. The placeholder edit alone changes nothing.

---

## F9. [LOW] "Neutral everywhere" wording list misses tenant-worded share surfaces

D20 says recipient wording goes neutral "everywhere it is tenant-only today", then
enumerates surfaces. Not in the list:
- the landlord's contact timeline milestone, server-side, "Sent to N tenant(s)" -
  `app/src/routes/contactTimeline.ts:760-764`;
- the composer's unresolved-seed note "added tenant(s) can't receive texts" -
  `dashboard/src/routes/broadcasts/RecipientPreview.tsx:393-394` (a dropped partner seed
  is called a tenant);
- the Broadcasts list subtitle "a curated set of tenants" -
  `dashboard/src/routes/broadcasts/BroadcastsList.tsx:91`;
- the property card action "Send this property to tenants" -
  `dashboard/src/routes/listing/ListingDetail.tsx:1027`.
The plan derives its pin list from the spec's list, so name these.

## F10. [LOW] Usage and kind-change text not reconciled with D17

- Section 6 (A text, not amended): `kind` is "refused 409 org_in_use while anything uses
  the entry"; D10: "kind change likewise". D17 says organization holders do NOT block a
  kind change. Amend one; as written they conflict.
- D10's columns are "tenants and other contacts, properties, (B) partners holding it as
  their organization". "Other contacts" already includes partners, so a partner holding a
  name in housingAuthority AND organization lands in two columns; "counts once per entry"
  does not say which column, and the Delete refusal sums columns.

## F11. [LOW] D16 misdescribes the Unknown card; the create form's Organization is unstated

- The Unknown card has FOUR actions today, including Mark as Property Manager
  (`dashboard/src/routes/contact/UnknownFile.tsx:98-131`); D16 says "beside Mark as Tenant
  / Landlord / Partner". Say where Caseworker goes in the order.
- New contact with the Caseworker choice: POST ignores org fields (section 9) and the spec
  does not say whether the create form offers Organization (POST then applies D5) or the
  caseworker gets one only by a later edit.

## F12. [LOW] D19 criteria edges

- Deleted contacts: the partitions hold soft-deleted contacts; the spec does not say
  whether they are listed (Make caseworker on a deleted record is meaningless).
- The relationship signal is read only from the tenant, landlord and partner partitions;
  a relationship row on an unknown or team_member contact pointing at a tenant caseworker
  is never seen.
- A partner with a non-caseworker role such as "Case Manager" is in neither list, while a
  TENANT with "case manager" is a possible caseworker. Near-zero population today (no path
  gives a partner a role); state it rather than fix it.

## F13. [LOW] D21's header rule also hides the authority on UNKNOWN contacts

Today the header facts show voucher size and housing authority for every non-landlord
(`dashboard/src/routes/contact/ContactDetail.tsx:1322-1335`), unknowns included, and the
importer writes the authority onto any type (`app/src/lib/import/apply.ts:1128-1136`).
D21's "only when `contact.type` is `tenant`" removes that triage clue from the Unknown
page. Probably right, but it is an unstated behavior change.
