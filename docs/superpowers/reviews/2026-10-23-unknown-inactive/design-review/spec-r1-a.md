# Design review r1-a - unknown-inactive spec (adversarial)

Spec: `docs/superpowers/specs/2026-10-23-unknown-inactive-design.md` (DRAFT r1).
Repo read at the worktree `W:/tmp/unknown-inactive` (main @916258ae). Read-only;
no tests or servers run. Every code claim below cites a line read for this
review; anything not read is marked UNVERIFIED.

Severity is consequence-if-shipped-unfixed.

---

## F1. HIGH - D5's Needs-you-now status check sits AFTER Today's 100-slot unread cap; Inactive unknowns starve the board

**What is wrong.** D5 places the new rule ("shows only while that contact's
status is Needs review") at the emit site it cites, `today.ts:784-800`. That
loop runs over `unreadOneToOne`, which was already filled and capped at
`TODAY_UNREAD_CAP` (100, `today.ts:182`) by the collect loop at
`today.ts:704-752`. A row dropped at emit time has already spent a slot.

**Evidence.**
- Collect loop pushes every unread 1:1 thread and breaks at the cap:
  `today.ts:748-752`.
- The emit-time `unknown_1to1` arm: `today.ts:784-800`.
- The deleted-contact filter was MOVED ahead of the cap for exactly this
  failure (adversarial A9): `today.ts:709-745` ("A hundred at the head of the
  index rendered Unreplied and the untriaged block EMPTY, with warnIfCapped
  announcing 'capped' rather than 'filtered to nothing'").
- `getContact` is memoized and already called pre-cap through
  `isDeletedContact` (`today.ts:358`, `378`, `744`), so the status is
  available there at no extra read.

**What it implies.** The population this feature creates is, by Cameron's own
rule, left UNREAD ("It just shows in the inbox"): wrong numbers and spam marked
Inactive that keep texting. Each distinct one holds a cap slot forever. Once
roughly 100 of them are newer than real work, Unreplied and the New unknown
contact rows go empty while `warnIfCapped` reports "capped". The spec must put
the check in the collect loop, before the cap, next to the deleted test - and
say so, because the line it cites is the wrong place.

---

## F2. HIGH - The edit form shows one status and the server writes another on a retype from Inactive (D3 + D7 + the form's dirty check)

**What is wrong.** D3 says the form lists the D1 statuses for the "current or
newly chosen type"; D7 says a type change with no explicit status from
Inactive goes to the new type's first step. The form's existing mechanics make
those two collide, and the spec gives no rule for the form's SELECTION on a
type change.

**Evidence.**
- On a kind change the selection is kept when it is legal for the new type
  (`ContactEditForm.tsx:288-291`). Under D1, `inactive` is legal for tenant and
  partner, so an Inactive unknown retyped to Tenant or Partner keeps
  "Inactive" selected.
- Non-tenant status is sent only when it differs from
  `defaultStatusForType(liveType, stored)` (`ContactEditForm.tsx:345-346`);
  for a stored `inactive` that default IS `inactive`, so nothing is sent.
- Tenant status goes out only when `tenantStatusChanged`
  (`ContactEditForm.tsx:519-521`), which is false for the same reason.
- The server then auto-advances: tenant -> onboarding, partner -> active
  (`contacts.ts:1725-1729`).
- Landlord: `inactive` is illegal, so the select resets to
  `defaultStatusForType('landlord', 'inactive')` = `needs_review`
  (`ContactEditForm.tsx:64-66`) while the server writes `interested`.
- KindPicker offers no `unknown` or `team_member` target
  (`KindPicker.tsx:36-39`, `61-70`), so the UI-reachable retypes are exactly
  the three above.

**What it implies.** Staff see "Inactive" (or "Needs review") in the Status
field, press Save, and get Onboarding / Active / Interested. They also cannot
express "retype and keep Inactive": choosing Inactive is indistinguishable from
not touching the field. D3's "offers exactly the same choices" holds as a list
and fails as a behavior. The spec needs a stated rule: on a type change, the
form re-seeds the selection to the server's D7 outcome (and sends it
explicitly), or the server rule changes. Test 7 must cover it.

---

## F3. MEDIUM - D3 misdescribes today's retype save path, and its "same provenance" guarantee does not hold for retypes

**What is wrong.** D3: "A save that changes the type AND sets a status stays
the plain PATCH (that path already validates status against the NEW type)."

**Evidence.**
- For a TENANT target the plain PATCH never carries status (`isTenant` guard,
  `ContactEditForm.tsx:340-346`); the status goes through a second write,
  `setTenantStatus` (`ContactEditForm.tsx:541-548`), after the PATCH whose
  server side has already auto-advanced to onboarding
  (`contacts.ts:1725-1729`).
- For landlord / partner targets the status does ride the PATCH, which stamps
  no `status_source` and writes `contact_updated`, not `tenant_status_changed`
  (`contacts.ts:2119-2123`; compare `services/statusTransition.ts:163-174`).

**What it implies.** A builder who takes "stays the plain PATCH" literally and
"unifies" the tenant arm onto it drops `status_source: 'manual'` (which pins
the tenant against derivation, `statusModel.ts:289-293`) and the transition
audit. Separately, D3's bullet "both places write the same provenance, the
same audit event and the same timeline entry" is true only for status-only
saves; a retype-plus-status save still writes PATCH provenance. The spec should
describe the tenant two-write path accurately and either accept the retype
asymmetry in words or route the retype's status through the transition route
too.

---

## F4. MEDIUM - Moving status writes onto the transition route removes the only live-refresh signal; Today and Inbox go stale

**What is wrong.** D2 (header, every type) and D3 (form, status-only) put
status changes on `PATCH .../tenant-status`. That route and its service emit
no SSE event. The spec then makes status DRIVE live surfaces (D5 Today row,
D9 `needsTriage`, the Inactive tag, the Unknown-tab sort) without saying how
they learn of the change.

**Evidence.**
- Route: `routes/statusTransition.ts:239-293`; service:
  `services/statusTransition.ts:609-635` - no `events.emit`.
- Today refetches only on placement / conversation / suggestion / tour events
  (`today/useToday.ts:142-152`); Inbox only on `conversation.updated`
  (`inbox/useInbox.ts:563`).
- Today, a status-only PATCH on a NAMED unknown contact does emit
  `conversation.updated` (the denormalize pass runs when
  `displayName !== null`, `contacts.ts:2081-2094`). D3 moves that save off the
  PATCH and loses it.
- The contact page already works around the gap for its own timeline
  ("no SSE event covers it", `ContactDetail.tsx:948-951`).

**What it implies.** Mark an unknown Inactive from its page with the inbox or
Today open in another tab: the "Needs triage" chip, the missing Inactive tag,
the Unknown-tab order and the Today "New unknown contact" row stay wrong until
some unrelated event or a reload. The spec needs a decision (emit a
`conversation.updated` for the contact's linked 1:1 threads, or a contact
event) or an explicit acceptance.

---

## F5. MEDIUM - "Today's Needs review list" names a surface that does not exist

**What is wrong.** Goal 1, D5 bullet 1, test 4 and the e2e in test 8 all say
the contact "leaves Today's Needs review list". Today has no such list.

**Evidence.**
- Today's sections: Needs you now, Tours today, Unreplied, Follow-ups due, AI
  suggestions to review (`today/Today.tsx:38-44`).
- BOTH sources D5 discusses emit the same row into `needs_you_now` with
  `why: 'New unknown contact'`: the unread 1:1 source (`today.ts:790-799`) and
  the (unknown, needs_review) triage pass (`today.ts:932-941`).

**What it implies.** D5 reads as two different surfaces with two rules when it
is one section fed by two sources (with a phone de-dupe between them,
`today.ts:929`). A builder or test author must guess which DOM the e2e asserts
against. Rename to "Needs you now's New unknown contact rows" and state both
sources' rules together.

---

## F6. MEDIUM - "does not put it back on Today" is not what the mechanism delivers: inbound to an Inactive unknown still feeds Today's AI suggestions

**What is wrong.** Test 8 asserts a new inbound to the Inactive contact "does
not put it back on Today", and D5 says the Needs-you-now condition is the ONLY
Today change. AI extraction still runs for unknown contacts of any status and
its suggestions surface on Today.

**Evidence.**
- Extraction skips only landlord / partner / team_member
  (`jobs/extraction.ts:457-462`); an unknown contact is eligible whatever its
  status.
- A type suggestion is proposed for any `type === 'unknown'` contact
  (`services/extraction/apply.ts:575-578`).
- Today's "AI suggestions to review" lists every contact with a pending
  suggestion, no status filter (`today.ts:944-975`).
- `aiExtractionEnabled` defaults to `nodeEnv !== 'production'`
  (`lib/config.ts:813`); whether prod has it on, and whether the hermetic e2e
  lane runs a model, is UNVERIFIED.

**What it implies.** In any environment with extraction on, an Inactive spam
number that texts again reappears on Today under AI suggestions - the
opposite of Cameron's "It just shows in the inbox". If the e2e lane has
extraction off, test 8 passes vacuously. The spec must either exclude Inactive
contacts from extraction / the AI group, or state that the AI group is
intentionally unaffected and narrow test 8's claim to Needs you now.

---

## F7. MEDIUM - Parked is declared the landlord's inactive status, but every D4 / D9 mechanism keys on the literal `inactive`

**What is wrong.** D1: "Parked is its inactive status". Goal 2 counts that as
landlords already having one. D4 then promises "An Inactive contact of any
type is treated exactly as an Inactive tenant is today", but each mechanism is
the string `inactive`: D4.1 (`isEligibleRecipient`), D4.4 (muted colour), D9
(the Inactive tag).

**Evidence.** `listingSendOutcome.ts:101-114` (the rule D4.1 widens tests
`status === 'inactive'` only); `StatusBadge.tsx:115-121` (tone per type).
Whether landlords can be listing-send recipients at all was not traced
(UNVERIFIED).

**What it implies.** A Parked landlord stays chaseable, untagged in the inbox
and not muted - despite being the type's "inactive status". Either D1 drops the
parenthetical and the spec says Parked is out of D4 / D9 on purpose, or D4 / D9
include `parked`. Two decisions that cannot both hold as written.

---

## F8. LOW - D4.5 "the contact's own type" label is undefined on a retype, and a stated ruling already splits it

**What is wrong.** On a retype PATCH, is "the contact's own type" the stored or
the new one? The code and a recorded ruling disagree with each other.

**Evidence.** The PATCH milestone labels by `stored.type`
(`contacts.ts:2129-2131`); the conversion labels by the NEW type and its
comment says the PATCH "keeps labelling by the stored type" (ruling R1-F12,
`caseworkerConversion.ts:410-416`). After D1, an unknown -> landlord
auto-advance still looks `interested` up in the unknown map and falls back to
the raw key (`contacts.ts:2135`). Test 2 covers only the transition route.

**What it implies.** The D4.5 guarantee is unprovable for the PATCH path as
specified. Say "the resulting type" (and that it supersedes R1-F12's PATCH
half) or say stored and accept the raw-key fallback.

---

## F9. LOW - D6 lists two writers that do not refuse with a 400

**Evidence.**
- AI status acceptance: a status accept on a non-tenant is refused 409
  `suggestion_contact_not_tenant` BEFORE the allowlist check
  (`suggestionResolution.ts:814-826`), and the AI only ever proposes
  `searching` for an onboarding tenant (`extraction/apply.ts:534-535`). The
  allowlist branch D6 relies on (`suggestionResolution.ts:297-300`) cannot be
  reached with (unknown, active).
- Import: no 400 at all; an illegal value falls back with a warning
  (`import/apply.ts:975-1000`). D6's own parenthetical says so, contradicting
  its "is a 400 on".

**What it implies.** Test 1 ("refused on every writer in D6") cannot be written
as specified. Restate D6 per writer.

---

## F10. LOW - `needsTriage` is true for team_member rows today; D9's new rule changes them silently

**Evidence.** `roleFromContact` maps every type except tenant / landlord /
partner to `'unknown'` (`inbox.ts:602-609`), and the contact row sets
`needsTriage: role === 'unknown'` (`inbox.ts:1116`). So a team_member row
carries "Needs triage" today. D9 says the chip is "true only for an unknown
contact whose status is Needs review".

**What it implies.** Coded on `type`, team_member rows lose the chip; coded on
`role`, a Needs review team_member keeps it. Either is defensible; the spec
should pick one, since it is a visible change for a type it otherwise leaves
alone.

---

## F11. LOW - D7's team_member / unknown arm is API-only, and the fallback it lives in does not check that the type changed

**Evidence.** KindPicker offers tenant, landlord, partner, PM and Other (base
tenant / landlord) only (`KindPicker.tsx:36-39`, `61-70`); the triage buttons
offer tenant / landlord / partner / caseworker / PM (`UnknownFile.tsx:110-155`).
Nothing in the UI retypes to team_member or unknown. The normalize fallback
fires on `isContactType(newType) && convType === undefined && !status`, with no
`newType !== stored.type` test (`contacts.ts:1746-1760`).

**What it implies.** Coded as "stored status is inactive -> reset", a
same-type API PATCH (`{type:'unknown'}` on an Inactive unknown) would reset it
to Needs review. State that the rule needs a real type change and that it is
reachable only by API.

---

## F12. LOW - D3's "saving an Inactive caseworker would flip it back" is not what the form does; test 7's matching check is vacuous

**Evidence.** The form shows an off-list stored value as Needs review
(`ContactEditForm.tsx:60-68`, `213-215`), but it compares the selection to that
same normalized default before sending (`ContactEditForm.tsx:345-346`), so an
untouched save sends no status and the stored value survives.

**What it implies.** The real defect is the DISPLAY (an Inactive caseworker
opens showing "Needs review"). Test 7's "saving an Inactive caseworker keeps
Inactive" passes against today's form, so it proves nothing. Assert the
initial selection and options instead.

---

## F13. LOW - Unenumerated surfaces

- Writer: `routes/unmatchedEmail.ts:458-461` hardcodes the type-scoped default
  (`tenant -> onboarding, landlord -> interested, else active`) outside
  `statusAllowlistFor`. It cannot create an unknown today (types limited at
  `unmatchedEmail.ts:73`), but it is a status writer missing from section 4,
  which promises "every one is a plan task or a watch item".
- Reader: the client fallback `today/buildToday.ts:286-300` puts every
  `unknown_1to1` conversation in needs_you_now with no status available. It
  runs only when `/api/today` 404s (`buildToday.ts:1-5`), but it is a reader
  that disagrees with D5.
- `statusAllowlistFor` falls through to the non-tenant list for any
  unrecognized or `undefined` type (`statusModel.ts:204-208`). After the split
  the spec does not say which of the two new lists that fallthrough returns.

---

## F14. LOW - Inactive unknowns now accumulate in the unknown partition, making a known-accepted inbox defect reachable

**Evidence.** Before this change, a contact left the (unknown) partition only
by retype or soft-delete (`unknownQueue.ts:63-66`). Now Inactive ones stay
forever. A mid-walk status flip duplicates or skips an Unknown-tab row across
pages (`inbox.ts:2016-2046`); that defect is accepted as LOW only because no
partition exceeds one dashboard page, with an explicit reopen trigger
(`docs/issues/unknown-queue-status-flip-duplicates-across-pages.md`,
frontmatter and first paragraph). The spec turns needs_review -> inactive into
the COMMON flip.

**What it implies.** Not a reason to change the design. It is a watch item the
spec should name next to D9's cursor note.

---

## F15. LOW - D4's "treated exactly as an Inactive tenant is today" overstates

**Evidence.** The Tenants view hides Inactive (and Placed) tenants by default
(`contacts/tenantFacets.ts:68-72`). D4.3 says an Inactive contact is shown on
the Contacts list "as any other contact". Status filters for the other views
are out of scope and filed (`docs/issues/contacts-status-filter-tenants-only.md`).

**What it implies.** The out-of-scope decision is fine. The word "exactly" is
not: drop it, or name the Tenants-view default as the one known difference.

---

## Verified as stated (no finding)

- (unknown, active) create default after the allowlist check:
  `contacts.ts:1007-1008`.
- Header dropdown for tenant and landlord only, badge for the rest and for
  soft-deleted contacts: `ContactDetail.tsx:1003-1028`; no reason prompt:
  `ContactDetail.tsx:935-955`.
- Transition route validates against the stored type's allowlist:
  `routes/statusTransition.ts:265-278`.
- Today's triage pass narrows to (unknown, needs_review): `today.ts:870-871`,
  `902`.
- `isEligibleRecipient` tenant-only status clause and its pinning test:
  `listingSendOutcome.ts:112`, `test/listingSendOutcome.test.ts:195-198`.
- Unknown-tab cursor: a pre-deploy `{b:1, k:{status:'active'}}` cursor is a 400
  through the key/block agreement check (`inbox.ts:489-497`). A bare `{b:1}`
  cursor (no `k`) is accepted and resumes at the new Inactive block. That is
  harmless, since no row can be skipped.
- Dashboard re-sorts every loaded row newest-first: `useInbox.ts:149-153`,
  `718`.
- Inbound capture never overwrites an existing contact's status:
  `contactCapture.ts:23-25`, `104-120`; `/join` and flyer sign-ups never write
  an existing contact (`public.ts:580-583`).
