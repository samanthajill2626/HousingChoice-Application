# R5 findings - seeds, e2e harness, existing e2e specs (branch B)

Plan researcher R5, 2026-10-07, worktree W:\tmp\caseworkers @ 97ac55ee,
spec revision 13. Read-only; no suite run. Reference material (lean-world
state, every pin, new-spec contract, seed recommendation) is in the
gitignored `.superpowers/sdd/plan-research/R5-reference.md`; this file holds
findings only.

Severity: H = the plan must decide or a gate will fail; M = builder would
guess; L = precision.

## Spec statements about the test world

F1 (M) - D16's Unknown-card order is misstated. The spec lists today's four
actions as "Mark as Tenant, Landlord, Property Manager, Partner"; the card
renders Tenant, Landlord, Partner, Property Manager
(dashboard/src/routes/contact/UnknownFile.tsx:105,113,121,129). "After
Partner" therefore means BETWEEN Partner and Property Manager, not last. The
plan should pin the position.

F2 (L) - D19 "the lean world's Renee Carter is one" (a role-less partner) is
correct by `role`, but her seed row carries `role_title: 'HCV Program
Specialist'` (app/src/lib/seed/lean.ts:176), a field no code reads (the only
hit in app/ and dashboard/ is that line). A builder can mistake it for the
role and drop her from the list. The plan should say that only `role` counts
and that B leaves `role_title` alone.

F3 (L) - D18 says "no path has ever given a partner one [a role]". The
contacts PATCH accepts `role` on any type today (app/src/routes/contacts.ts:675-679).
D19 itself concedes that "Case Manager" can be set through the API. The
statement holds for the UI and for every seed, not for the API. It is
harmless, but the tab-empty claim is about seeds, not paths.

## Gaps the builder would have to guess

F4 (H) - The D20 neutral-wording list misses three tenant-only labels, all of
them pinned by e2e:
- the property kebab menuitem "Send to tenants"
  (dashboard/src/routes/listing/ListingActionsMenu.tsx:107; pinned at
  e2e/tests/dashboard-next/broadcasts.spec.ts:143 and e2e/scenarios/steps.ts:1054);
- the zero-reach label "No tenants reached" on the property Activity and the
  landlord timeline (dashboard/src/routes/listing/listingFormat.ts:181,
  app/src/routes/contactTimeline.ts:696; pinned at
  e2e/tests/dashboard-next/share-sent-outcome.spec.ts:621,671);
- the Matching empty state, which quotes the kebab label
  (dashboard/src/routes/broadcasts/BroadcastsList.tsx:132).

D20 claims "one rule ... the plan lists every unit and e2e pin that changes".
The plan has to say whether these three change too. A partner share can make
all three wrong.

F5 (M) - The landlord timeline picks out share pins for its read-time relabel
by `label.startsWith('Sent to ')` (app/src/routes/contactTimeline.ts:1467).
Any neutral wording that drops the "Sent to " prefix silently disables the
D5 reached-count relabel, and the timeline keeps stale stored words. The
regression shows only in landlord-activity.spec.ts:122 and
contactTimeline.test.ts:1234-1290. The plan should keep the prefix or move
the predicate off the label.

F6 (H) - Two different role rules are both called "caseworker roles". D16
removes from the KindPicker role datalist only the roles that satisfy
`isCaseworkerRole`, which is an exact match after normalizing. Its stated
purpose, "those are exactly the records D19 exists to clean up", is D19's
looser "mentions" rule. Under the exact rule, "Case worker 2", "Senior
Caseworker" or "Caseworker - DFCS" are still offered on a tenant base, and
each one then shows up in the Possible list. The e2e suite feeds exactly
this: contact-create.spec.ts:24-81 writes the role `Case worker ${stamp}`
into the vocabulary on every run. The plan has to choose which rule filters
the datalist.

F7 (H) - The matcher for D19's AI-note signal is undefined. `notes` is the
field extraction writes, as `[Auto - <Mon> <D>] <line>`
(app/src/services/extraction/apply.ts:144-148,742). The edit form's "Notes"
box writes the same field (dashboard/src/routes/contact/ContactEditForm.tsx:181,878).
The spec says "the AI's own line, not the bare words" but never says whether
the `[Auto - ...]` prefix is required, so a staff-typed "Identified as a
caseworker" may or may not count. This decides how an e2e plants the signal:
contacts POST `notes`, or the EXTRACT path.

F8 (M) - D19's relationship signal does not define the row's role test.
"Linked as another contact's caseworker relationship" leaves open whether the
relationship row's free-text role (app/src/lib/contactProfile.ts:10-18) must
satisfy the mentions rule, `isCaseworkerRole`, or nothing at all. The
existing spec contact-create.spec.ts:186-200 links with the role
"Caseworker", the most likely real shape, but its target is a landlord, so it
is excluded either way.

F9 (L) - D18 adds a nav sub-link but does not say whether the Contacts
page's own "Filter contacts" tabs gain Caseworkers. Those tabs deliberately
mirror the nav routes (dashboard/src/routes/contacts/ContactsList.tsx:44-53).
Related details are also open:
- the `ContactsFilter` / `HEADING` records (ContactsList.tsx:34-40);
- the nav `dot` union, which is tenant | landlord | unknown only
  (dashboard/src/app/nav.ts:32);
- the IMPLEMENTED set (dashboard/src/App.tsx:64-67). Missing it fails
  e2e/performance/routes.test.ts:360.

F10 (M) - The spec does not say where the contact page's "Make caseworker"
action sits. If it renders as visible text it collides with page-wide
`getByText` reads (see F11). A More actions menuitem avoids that, and
contact-detail.spec.ts:32-36 asserts only presence there, never a count.

## Existing e2e and harness traps the plan must schedule

F11 (H) - contact-create.spec.ts:201 runs an unscoped, non-exact
`getByText('Caseworker')`. Once B adds the always-visible "Caseworkers" nav
link (and any visible "Make caseworker" text), this is a strict-mode
violation and gate 4 fails. Scope it to the relationship card, or make it
exact.

F12 (H) - org-lists.spec.ts:557-562 compares the usage wire with `toEqual`,
which fails on the new `organization` key. Bump it in the same task as the
usage change.

F13 (M) - Three things move together for the dev seam's `organization`
field (D17 stated exception), and none of them is named in the spec:
- app/src/routes/dev.ts:1226-1229 refuses every contact field except
  housingAuthority and agency, with a message pinned at
  app/test/devOrgFixture.test.ts:101-105;
- the e2e `OrgRecordField` / `OrgUsageWire` types (e2e/fixtures/orgFixture.ts:24,54-57);
- e2e/README.md:598-602 and the matching selectors.md row.

F14 (M) - The perf choice has hidden pins whichever way it goes. Either:
- **Exclude** the route: add '/contacts/caseworkers' to routes.test.ts's
  local `excluded` set (:378-391), with a filed
  `perf-pages-contacts-caseworkers-surface` issue, following the
  `/tours/past` and `/settings/organizations` precedent; or
- **Profile** it: one more ROUTES row and the three "31" pins at
  routes.test.ts:287-289, plus EXPECTED_KEYS, CONTACT shapes, both
  CONTRACT_SOURCE_LEDGER maps (routes.ts:733-737,787-791), EXPECTED_WARM
  and the README count.

The GET it would measure, the possible-caseworkers three-partition scan, is
the scale-bearing read section 12 already worries about. That argues for
profiling, or at least for naming it in the exclusion issue. Either way, the
mutation catalog count pin (e2e/performance/mutationCatalog.test.ts:378,
118 today) rises by one for each new dashboard POST function.

F15 (H) - Shared lane state (playwright.config.ts:140-141, one worker, files
in path order) means no spec may assert the Possible list's length or
emptiness, or the Caseworkers tab's row count:
- contact-create.spec.ts:24-81 adds a "Case worker <stamp>" tenant on every
  run and never reseeds;
- conversation-fact-extraction.spec.ts:315-353 adds a role-less partner.

The only exact-content statement that holds is "right after a reseed, Renee
is the one row".

B specs must never convert or dismiss a seeded contact:
- dismissing Renee hides her until the next reseed;
- converting Dario re-types conv-0002, which share-skip-fix.spec.ts:26-35
  depends on.

Tasha and Marcus are refused (open placement, landlord of record), so they
make deterministic read-only fixtures for the dialog's preview.

F16 (M) - An e2e that proves "a share mints `partner_1to1`" (I2) passes
vacuously if it calls POST /api/contacts/:id/conversation before the share.
That route (ensureContactConversation) creates the thread by contact type
itself, and the existing helper does exactly this
(conversation-fact-extraction.spec.ts:87-91). Two related constraints:
- Renee has no consent (lean.ts:153-154), so a share to her is JIT-refused.
  A partner-share e2e needs a fresh partner with consent recorded.
- fake-twilio's persona roles have no 'partner' (e2e/fixtures/fakeTwilio.ts:222;
  fake-twilio/src/engine/registry.ts:17 types Renee as 'pm').

F17 (H) - The hermetic harness cannot express four of D19/D21's write
contracts as built. B has to extend both the real repo and the fake, and add
parity tests (idiom: app/test/orgRecordWriters.integration.test.ts:1-7,121-130):
- contactsRepo.update's `expect` guards ONE string attribute (real
  app/src/repos/contactsRepo.ts:625-627,1389-1398; fake
  app/test/helpers/twilioWebhookHarness.ts:2314-2357), but D19 needs a
  four-part guard including the numeric `classification_revision`;
- conversation `setType` / `applyTriage` are unconditional in the fake
  (twilioWebhookHarness.ts:817-831) and condition only on existence in the
  real repo (conversationsRepo.ts:1500,1516-1554). D21 needs a re-type
  conditional on the type the route read;
- no all-holders byPhone / byEmail read exists, and the fake's findByPhone is
  deterministic first-match where the real one is arbitrary;
- the fake unitsRepo.list caps at 50 and never pages
  (twilioWebhookHarness.ts:2916-2921), so the roster-refusal scan's
  pagination is untestable in the fake.

Two further hazards for the tests themselves:
- the fake's frozen listByType (twilioWebhookHarness.ts:2214-2221) diverges
  from the sparse byTypeStatus index; the possible-caseworkers tests must use
  app/test/helpers/contactsPartitionFake.ts;
- fake getById / update return live objects, which can mask a stale-read
  bug in a read-then-conditional-write test.

D21's "household phone left alone" case is unit/integration only: contacts
POST refuses a held phone with 409 (app/src/routes/contacts.ts:1059-1085),
so e2e cannot build it.

## No seed change needed

F18 (L, informational) - With no seed change, a fresh lean reseed gives
exactly what the spec says: an empty Caseworkers tab and a Possible list of
Renee alone. No seed (lean, cast, matrix, live, performance) writes a contact
`role`, `notes`, `relationships`, `agency` or `organization`. A lean-seed
caseworker would be mutated by the first conversion spec and leak down the
lane. Any FULL-profile demo caseworker must extend
app/test/seedOrgNames.test.ts:51-81 to check `organization`, because seeds
bypass D5.
