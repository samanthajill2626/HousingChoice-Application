# Design review r1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` (rev 1, branch
`feat/matching-blast-rules` @002a34ce, cut from main @a2b3d80d).
Method: every claim about current behavior was checked in the code at the file:line cited
below. Nothing was run. UNVERIFIED marks a claim that needs production data.

Most of section 2 ("Today") checks out against the code: the resolver
(`audienceResolution.ts:123-191`), `storedFilterRefusal` (`broadcasts.ts:547-567`), the
three send paths (`broadcasts.ts:899-1023`), the decline degrade (`:773-782`),
`listByType`'s status option and soft-delete filter (`contactsRepo.ts:1346-1385`),
`listByStatus` with no cap (`toursRepo.ts:436-455`), the auto-close reads
(`tourAutoClose.ts:72-79`, `toursModel.ts:166`), the `byStatus` GSI with ALL
projection (`tables.ts:546-550`, `infra/modules/dynamodb/main.tf:57`), "nothing
rewrites a broadcast" (`orgListRepo.ts:41` has no `audience_filter` field), and the
partner type fence (`audienceResolution.ts:159`). The findings below are where the
design or its inventory goes wrong.

---

## 1. [HIGH] The default prefill silently drops every tenant with no housing authority, and the spec never says so

**What is wrong.** D2 keeps "a tenant with no housing authority matches only the
empty list". D3 makes a non-empty list the DEFAULT for every property that lists an
authority. Together they mean: on a property-scoped blast, every Onboarding/Searching
tenant whose `housingAuthority` is blank (or holds a value that is not exactly a
member) is excluded by default. Unlike status (D1, which gets the D8 caption) and
unlike holds and declines (listed, unchecked, labeled), these tenants are NOT listed,
NOT counted, and NOT mentioned anywhere on the screen. Staff cannot even ask for
"authorities A and B plus tenants with none": the only way to reach them is to
clear the whole list, which drops the authority filter entirely.

Section 4 ("Consequences to know") does not mention this. It says the opposite of
the truth for one population: "A `/join` lead now starts as Onboarding (tracker
#14), so new fair leads are included." The /join form makes the authority optional
and stores none when none is chosen (`app/src/routes/public.ts:18-23`, `:342`,
`:349` "Absent when none was chosen"). Those leads are Onboarding and still
excluded by default from every property that lists an authority. A flyer sign-up
starts `needs_review` and stores no authority at all (`public.ts:342`), so it is
excluded twice.

**Evidence that the shape is common.** The importer writes `housingAuthority` only
when the source row had one (`app/src/lib/import/apply.ts:1213-1216`); how many live
Onboarding/Searching tenants are blank is UNVERIFIED (production data). The repo's
own tests treat a tenant with no authority as the normal shape: every helper that
creates tenants for a property-scoped composer test creates them without one
(`e2e/tests/dashboard-next/broadcasts.spec.ts:44-55`,
`review-recipients-heard-from.spec.ts:33-52`, `a2p-compliance.spec.ts:332-333`) -
see finding 2 for what that does to the suite.

**What it implies.** This is the single largest change to who receives a blast, and
it is unacknowledged. The spec must decide, explicitly: (a) blank-authority tenants
are listed unchecked with a label (the #27 / hold mechanism the spec already
endorses as THE mechanism, section 1), or (b) the filter grows an "include tenants
with no housing authority" member, or (c) they are excluded on purpose - in which
case section 4 must say so, D8's caption must say so, and the /join sentence in
section 4 must be corrected. Without a decision, a builder will "fix" the broken
e2e specs (finding 2) by giving the test tenants an authority and ship the silent
exclusion by accident.

---

## 2. [MEDIUM] Section 7's test inventory misses the specs the PREFILL breaks, misdiagnoses one it names, and one break is order-dependent

**What is wrong.** Section 7 attributes the e2e churn to D1 (status) and the label
rename. D3's prefill breaks more, and differently:

- `e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts` (NOT listed). The
  unit accepts `['Atlanta Housing Authority']` (`:67`); all five tenants are created
  with no authority (`:43-45`, `:131-135`). Under D3 the prefill filters them all
  out, and every row assertion from `:172` on (recent/older/never/declined rows, the
  declined checkbox at `:190`) fails.
- `a2p-compliance.spec.ts` section 8.3 test 1 (`:324-441`, NOT listed; section 7
  names only `:480`). The unit accepts `atlanta_housing` (`:348`), stored as
  `Atlanta Housing Authority` (spelling `Atlanta Housing`,
  `app/src/lib/orgStartingList.ts:18`); both tenants have no authority. The
  no-consent row at `:385` is never listed.
- `broadcasts.spec.ts` test 1 (`:96-229`): section 7 cites `:167-175` and gives the
  cause as "the lean seed's Tasha is `placing`". Lines `:169-170` in that range are
  the test's own tenants `keep` and `drop` (`:119-120`, no authority; the unit
  accepts `atlanta_housing`, `:78`). They fail for a different reason (the
  prefill), and so does everything from `:178` on (uncheck `drop`, send, outbox).
- `broadcasts.spec.ts` "sending a non-Available property warns" (`:231-262`, NOT
  listed). Its tenant `Warnme` has no authority. After the prefill, the default
  audience is whatever Atlanta 2-BR Onboarding/Searching tenants OTHER specs left in
  the lane. Run alone, the list is empty, `Send to N recipients` is disabled, and
  `:247` times out; run after the scenario specs it may pass. That is an
  ORDER-DEPENDENT failure - the class AGENTS.md says must be diagnosed as a
  regression, not re-run.
- `org-lists.spec.ts` "blast composer: the picker has no add step..." (`:321-367`)
  and "Preview waits while ... typed text" (`:450-480`). Section 7 names this file
  only for `draftAuthority` and the label. Both tests' units list the run-unique
  authority (`:332`, `:457`), so the prefill puts it in the first draft, and
  `:355` (`sent.filter(a => a !== undefined)` is `[]` before any pick) fails. Worse,
  in multi mode OrgPicker EXCLUDES chosen names from its options
  (`dashboard/src/routes/orgs/OrgPicker.tsx:239`), so `:347` and `:469` (the
  option for the prefilled name is visible) fail too. These tests pin a contract
  the spec reverses without saying so.
- `e2e/support/selectors.md` (NOT listed) documents the contracts these changes
  break: `:132` and `:133` ("The singular `Housing authority` labels ... the
  composer's filter"; "The composer changes its filter ONLY on a pick or a chip
  removal"), `:134` (the composer note and hint copy) and `:147` (the exact
  checkbox-name forms, see finding 9).
- Dashboard units that pin the truncation copy (finding 5):
  `AudienceFilters.test.tsx:242`, `BroadcastComposer.test.tsx:210`.

**What it implies.** The builder will treat section 7 as the inventory. The misses
show up at gate 4. The order-dependent one can pass in the full-suite order and ship
as a latent flake. How these specs should be fixed also depends on finding 1: if
blank-authority tenants are meant to be listed, the specs need assertions, not new
test data.

---

## 3. [MEDIUM] D5 fails closed on seeds-only previews, where the reads cannot change a single default

**What is wrong.** D5 justifies failing closed with: "both reads now decide who is
checked by default, so serving a list without them would check people the rules
leave out. This applies to every preview, including a seeds-only draft." For a
seeds-only draft that justification is false:

- every row of a seeds-only preview is `seeded: true` (`broadcasts.ts:745-746`,
  `:815`);
- a seeded row is checked whatever its decline flag (`defaultChecked`,
  `dashboard/src/routes/broadcasts/RecipientPreview.tsx:99-101`), and D4 and D7 keep
  that for holds ("a hand-picked tenant ... is never held");
- D6(b) says the seeds-only send path is "UNCHANGED (hand-picks skip the rules)".

So in a seeds-only preview the tours and decline reads affect only labels. Even so,
D5 makes an org-wide tours read (every `scheduled`, `toured` and `no_show` tour plus
two weeks of requests) a hard dependency of the tenant-page send AND the
caseworker-page send. D10 calls the caseworker-page send the ONLY way a caseworker
gets a property.

**What it implies.** One read failure blocks every 1:1 send in the app, though no
outcome depends on that read. Either fail closed only when the draft has filter rows
(`audience_mode !== 'seeds_only'`) and serve seeds-only previews with a
labels-unavailable flag, or state why a 1:1 send must be blocked on a label read and
accept that availability cost explicitly.

---

## 4. [MEDIUM] D6(c) claims "exactly the rows the preview would check by default"; its own mechanism does not deliver that, and the slogan contradicts a test the spec says to keep

**What is wrong.** D6(c) defines the path (c) recipients as "the D1/D2 audience MINUS
held tenants MINUS effective #27 declines, i.e. exactly the rows the preview would
check by default". The preview's default rule (D7, and today
`RecipientPreview.tsx:99-101`) also leaves unchecked (a) rows without consent and
(b) rows already sent this property. The mechanism subtracts neither:

- Already sent: path (c) texts tenants again whom the preview would leave
  unchecked (`priorRecipientKeys`, `broadcasts.ts:766-769`, is not in the D6(c)
  mechanism).
- No consent: if a builder follows the slogan and removes no-consent tenants at
  (c), `a2p-compliance.spec.ts:445-510` breaks - it asserts
  `stats.skipped_no_consent === 1` through exactly this path (`:488-497`). Section 7
  says to keep that spec "as legacy coverage".

D6(c) also says "The truncation and cap refusals are unchanged" without saying
whether the 1000 cap (`broadcastsRepo.ts:75`, `broadcasts.ts:1003`) applies to the
audience before the exclusions or after them.

**What it implies.** Two readings that cannot both hold. Either drop the "exactly"
sentence and keep the mechanism (and say already-sent tenants are re-texted by (c)),
or add the already-sent subtraction and leave consent to the fan-out explicitly.
Also say which count the cap applies to.

---

## 5. [LOW] The truncation advice in the dashboard becomes false; section 7 lists only the server message

**What is wrong.** Under D1 and D2 the page bound counts RAW reads of the
`searching` and `onboarding` partitions. Voucher size and authority are both
in-memory filters applied afterward. So no filter change can clear a truncation.
Today an authority switched the read to the narrow `byHousingAuthority` GSI
(`audienceResolution.ts:127-138`), so that advice was true for the authority.
Two dashboard surfaces still tell staff to narrow:
`AudienceFilters.tsx:191-193` ("narrow the size or housing authority for a complete
audience") and `RecipientPreview.tsx:654` ("Narrow the filter for a complete
list"). Section 7 lists only the server message (`broadcasts.ts:1010-1012`).

**What it implies.** The problem is latent: the bound is 10,000 reads against about
641 tenants. But the copy will be wrong the day the bound bites. Rewrite it, or
remove it, in the same change.

---

## 6. [LOW] D9 also changes the tenant-page and caseworker-page entry, and the spec says only the property-page path is kept

**What is wrong.** The property picker is shared by the bare entry and the
`?contactId=` entry (`BroadcastComposer.tsx:417-491`; the 1:1 send from a tenant or
caseworker page opens it, `e2e/support/selectors.md:37`). D9 keeps a non-Available
property only for `?unitId=` "so that recovery path is unchanged". Today a tenant-page
send to a non-Available property reaches the "Make Available & send" dialog
(`RecipientPreview.tsx:338-361`). After D9 it cannot pick that property at all.
Section 4 does not list this.

**What it implies.** This may be intended, since every send needs Available. If so,
say it in D9 and section 4. If not, keep non-Available properties pickable on the
`?contactId=` entry.

---

## 7. [LOW] Two hold guarantees are not delivered by the mechanism

**What is wrong.**

- D4, last bullet: "A tenant marked Interested on #27 gets a tour request, so they
  are held ... for up to 14 days." Interested creates a tour only when no
  qualifying tour exists for the pair (`app/src/routes/units.ts:1465`, `:1481`).
  `deriveTourSignal` counts any `requested` tour of any age
  (`app/src/lib/listingSendTour.ts:66`), and `requested` tours never auto-close
  (`toursModel.ts:166`). So on a pair with a request older than 14 days, an
  Interested click creates nothing, and the tenant is not held.
- D4 says a request "can never keep a tenant out forever". That is true, but the
  neighboring kind can: `needs_placement` has no expiry, because auto-close skips
  convertible tours (`toursModel.ts:204`). A conversion that is refused for good
  (`contact_not_tenant`, `placements.ts:676-681`) leaves the tenant held for as long
  as the tour stays unconverted. Separately, open tours on a soft-deleted property
  keep holding until auto-close, because unit delete does not touch tours
  (`units.ts:2264-2280`).

**What it implies.** Correct the Interested sentence, or measure a request's hold
from its latest Interested or mark instead of from `createdAt`. State the
`needs_placement` exposure as accepted.

---

## 8. [LOW] "Incomplete read" has no definition, and "kept short by the two-week auto-close" is only partly true

**What is wrong.** D5 says "a page cap hit counts as a failed read" but names no cap,
and `listByStatus` has none (`toursRepo.ts:436-455`). The `toured` partition does
not stay short: a toured tour with a recorded outcome, or a convertible one, is
never auto-closed (`toursModel.ts:203-204`), so those rows stay in the partition.

**What it implies.** If a builder picks a cap, a 503 that blocks every blast's
preview org-wide (finding 3) becomes a matter of time. Name the cap and its basis,
or say the read is unbounded like the sweep's and that only a thrown error counts
as a failed read.

---

## 9. [LOW] The new checkbox name format is unspecified, while e2e pins the exact strings

**What is wrong.** D7 says the name "lists every reason, joined (consent, already
sent, not interested, the tour label)". Today a no-consent row suppresses every other
cue (`RecipientPreview.tsx:105-111`), and the e2e suite and selectors contract use
exact names (`review-recipients-heard-from.spec.ts:190`, `:208`;
`e2e/support/selectors.md:147`). D7 gives no separator, no order and no casing for
the tour label inside the name.

**What it implies.** Two builders will produce two strings. Give the literal format,
for example `<name> - already sent, not interested, tour Oct 20`, and say whether a
no-consent row still suppresses the others.

---

## 10. [LOW] The prefill's dependence on the organization list is unspecified at the edges

**What is wrong.** D3 prefills only names that are EXACT entries on the list. The
composer reads that list once per mount, inside `AudienceFilters`
(`AudienceFilters.tsx:66`). The spec does not say what happens in four cases:

- (a) The list is still loading when the property loads. The first draft is then
  made without an authority and remade later.
- (b) The list failed to load. Either nothing is prefilled and the blast silently
  reaches every authority, or something else happens.
- (c) A 422 removes a stale member. The spec does not say whether that removal
  counts as a staff edit. If it does not, reopening the same property re-adds the
  member, and the server refuses it again.
- (d) A property lists more than 25 on-list authorities. The unit field has no cap
  (`app/src/lib/unitFields.ts:52`), so the prefill can exceed D2's 25-member limit
  and every draft create answers 400.

**What it implies.** Each case decides who gets texted, or whether a draft can be
made at all. Each needs one sentence.

---

## 11. [LOW] The e2e plan needs a backdated tour request that no route can create

**What is wrong.** Section 6 asks for "a 3-day-old tour request". POST `/api/tours`
always stamps `createdAt` now (`app/src/routes/tours.ts:367-373`), and no dev seam
backdates a tour (`app/src/routes/dev.ts:397-485` has only the reminder and
auto-close ticks).

**What it implies.** The plan needs a new hermetic dev seam that section 7 does not
list. Alternatively, use a fresh request, which exercises the same hold.

---

## 12. [LOW] The D8 caption over-promises

**What is wrong.** "Add anyone else by hand when you review recipients." Add a tenant
searches tenants only (`BroadcastComposer.tsx:281`), and section 5 defers caseworker
search.

**What it implies.** Say "any other tenant".

---

## 13. [LOW] Two normalizers for a "ONE normalizer" rule; the wire shape of a legacy filter is not stated

**What is wrong.** D2 says legacy storage is read "everywhere through ONE normalizer"
(server) "and a dashboard twin". It also says the results and list projections
(`broadcasts.ts:393`, `:421`) "read through the normalizer". It does not say whether
the projections send `housing_authorities` on the wire for a legacy row. If they
do, the dashboard twin is dead code. If they do not, the wire carries both shapes
forever.

**What it implies.** Pick one: normalize on the wire and drop the twin, or pass the
stored filter through raw and name the twin as the only dashboard reader.
