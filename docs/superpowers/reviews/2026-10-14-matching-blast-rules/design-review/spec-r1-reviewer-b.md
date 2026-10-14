# Matching blast rules - spec review round 1, reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-10-14-matching-blast-rules-design.md` (DRAFT rev 1)
Repo state read: worktree `W:\tmp\matching-blast-rules` @002a34ce (main @a2b3d80d + the spec commit).
Method: every claim about current behavior below cites a file:line read in this
worktree. Nothing was run. Items I could not verify are marked UNVERIFIED.

Verified as stated (no finding): the section 2 descriptions of
`parseAudienceFilter`, POST create's `checkScalar`, `storedFilterRefusal`, the
resolver's GSI choice and fences, the three send paths, the decline degrade,
`listByStatus` (no cap, no range condition), the auto-close partitions and
exemptions, the Not a fit close living only in the dashboard
(`TourDetail.tsx:597-601`), the dashboard prefill/422/draft-key code,
`OrgPicker multiple`, `listByHousingAuthority` having one runtime caller, and
the matrix seed filters.

---

## 1. [HIGH] D3 prefill silently drops every tenant with no (or an off-list) housing authority from property blasts; the spec calls this "unchanged"

What is wrong. D2 says "A tenant with no housing authority matches only the
empty list (unchanged)". The MATCH rule is unchanged; the REACH is not. Today
the composer never prefills the authority (`BroadcastComposer.tsx:261-272`
prefills voucher size only; spec section 2 says so), so the default blast is
"every authority" and includes tenants with a blank `housingAuthority`. Under
D3 the default for any property that lists accepted authorities is a non-empty
list, so those tenants are out of every default blast of that property.

They are also invisible at review: the preview lists only filter matches plus
seeds (`broadcasts.ts:744-754`), so staff never see who the authority filter
cut, unlike holds and declines, which D4/D7 deliberately list.

Who has no authority (evidence, counts UNVERIFIED):
- the importer writes `housingAuthority` only when it resolves to a list name
  (`app/src/lib/import/apply.ts:1208-1216`);
- a `/join` with a unitId stores no authority (`app/src/routes/public.ts:336-342`);
- `clean-org-names` leaves unresolvable values as they are
  (`app/scripts/clean-org-names.ts:15-18`), and such a tenant's off-list text
  matches no prefilled member either.

Section 4 "Consequences" lists the status and count consequences but not this
one.

Implies. This is a silent cut in reach for real tenants, and the spec's own
wording points the builder away from it. Before the build it needs a ruling
(include blank-authority tenants? list them unchecked with a label, as D4 does
for holds? or accept the cut), and the ruling goes in section 4 either way.

## 2. [MEDIUM] D5 fail-closed covers seeds-only previews, where neither read decides anything; it contradicts the spec's own rationale and goal

What is wrong. D5 removes the decline degrade because "both reads now decide
who is checked by default". It then applies the 503 to "every preview,
including a seeds-only draft". For a seeded row, the default is checked
whatever the reads return: D7 `hasConsent && (seeded || ...)`, the same as
today's `RecipientPreview.tsx:99-101`. A seeds-only draft holds only seeded
rows (`broadcasts.ts:744-747`). So on a seeds-only preview the two reads only
produce labels, and failing closed protects nothing.

Mechanism vs promise:
- Section 1: "A tenant picked by hand always gets the property". With a
  throttled tours query, a hand-picked 1:1 send from a tenant page cannot be
  previewed, and the dashboard cannot send without a preview (it always uses
  path (a) after the review step).
- D10 makes the caseworker page the ONLY way a caseworker gets a property.
  That path is now blocked by a tours read that cannot change its outcome.
- The page-cap rule ("a page cap hit counts as a failed read") names no cap
  value and no escape. If the open-tours read ever passes the cap, every
  preview fails permanently, 1:1 sends included, and "Try again" never helps.

Implies. Either limit the 503 to previews that have filter-resolved rows (and
serve seeds-only previews with an "unavailable" label flag), or justify
blocking hand-picks in section 1 and drop "always". Also state the cap value
and what staff do when it is hit.

## 3. [MEDIUM] D6(c)'s "exactly the rows the preview would check by default" contradicts D6(c)'s own mechanism and an e2e the spec says to keep

What is wrong. D6(c) defines path (c) as "the D1/D2 audience MINUS held
tenants MINUS effective #27 declines, i.e. exactly the rows the preview would
check by default". Those are two different sets:
- The preview default also unchecks ALREADY-SENT rows and NO-CONSENT rows
  (D7 row default; `RecipientPreview.tsx:99-101`).
- Path (c) excludes neither. The fan-out has no already-sent fence (no match in
  `app/src/jobs/broadcastFanOut.ts`) and counts no-consent recipients as
  `skipped_no_consent` (`broadcastFanOut.ts:276-280`).

Section 7 says to keep `a2p-compliance.spec.ts:480` as legacy coverage. That
test drives path (c) and asserts `skipped_no_consent === 1`
(`e2e/tests/dashboard-next/a2p-compliance.spec.ts:445-500`, the assert at `:488-497`). It passes only if
the no-consent tenant stays IN the path (c) recipients. A builder who
implements the "i.e." clause literally breaks that gate. The mechanism as
written also re-sends to already-sent tenants, which the preview would never
do by default.

Implies. Delete the "i.e." slogan and state the set explicitly. If path (c)
should also skip already-sent tenants, say so and name the read it needs
(`priorRecipientKeys`).

## 4. [MEDIUM] The D3 authority prefill depends on an org list the composer does not hold; loading, failure and all-off-list behavior are unspecified and fail open

What is wrong.
- The org list lives in `AudienceFilters` (`AudienceFilters.tsx:66`,
  `useOrgList()`), is read once per mount, and has no client cache
  (`useOrgList.ts:1-3`). The prefill's "EXACT names ... on the organization
  list" check needs that list in `BroadcastComposer`, and the spec does not say
  where it comes from.
- The spec does not say what the prefill does while the list is loading or
  after the read fails (`orgList.error`).
- `canPreview` (`BroadcastComposer.tsx:388-394`) does not wait for the prefill.
  The first draft is created after a 600 ms debounce
  (`useComposerDraft.ts:28`) with an EMPTY authority list, so Preview is
  enabled for an "every authority" draft until the list lands. A failed list
  read means the prefill never happens at all.
- If every accepted authority of a property is off-list, D3 puts nothing in the
  filter. The empty list means "every authority" (D2), which is the opposite of
  goal 3, and the only signal is a note.
- The rationale "the server would refuse the draft" is not true for a unique
  spelling: `checkScalarWrite` resolves it to the entry name
  (`app/src/lib/orgNames.ts:276-279`). The dashboard has the spellings, so it
  could resolve them too.
- Minor: `accepted_authorities` has no member cap
  (`app/src/lib/unitFields.ts:52`), but D2 refuses more than 25 with a 400 the
  composer would show as a stale draft.

Implies. Specify:
1. Where the composer gets the list.
2. That Preview waits for the prefill (or for a settled list).
3. What a failed list read does. It must not silently mean every authority.
4. Whether an all-off-list property blocks, warns, or deliberately means every
   authority.

These are the moments where the blast widens with nobody noticing.

## 5. [MEDIUM] Section 7's test and seam inventory misses the tests that D3 and D5 break, plus the fakes and seams the build needs

What is wrong. The inventory says "from the inventory", but it misses several
tests and surfaces. The D3 authority prefill applies to every `?unitId=` entry,
and the e2e properties below accept Atlanta, while their tenants are created
with NO `housingAuthority`:
- `e2e/tests/dashboard-next/review-recipients-heard-from.spec.ts` is NOT
  listed. Its property accepts Atlanta (`:67`) and its tenants have no
  authority (`:34-51`), so they leave the audience and the listing, order and
  decline asserts at `:177-196` fail.
- `a2p-compliance.spec.ts:330-420` (the composer consent test) is NOT listed.
  It is listed only for `:480`. Its property accepts `atlanta_housing`
  (`:348`, stored as the list name). Its tenants come from `createContact`
  (`:70-87`) with no authority, so they are filtered out.
- `broadcasts.spec.ts` is listed only for the Tasha lines (167-175). The
  keep/drop tenants (`:119-120`, helper `:43-62`, no authority) also vanish.
  The "Warnme" test (`:231-263`) needs at least 1 checked recipient and may get
  0.
- `dashboard/src/routes/broadcasts/BroadcastComposer.prefill.test.tsx`: the
  composer gains an org-list fetch.

Surfaces the build needs that the spec does not name:
- The harness fake `toursRepo` (`app/test/helpers/twilioWebhookHarness.ts:3920`,
  its `listByStatus` at `:3964`) must model the new range-conditioned,
  completeness-aware read. It is the fake every `broadcastApi.test.ts` preview
  case runs against.
- The new e2e's "3-day-old tour request" has no seam. `POST /api/tours` takes
  no `createdAt` (`app/src/routes/tours.ts:367-374`), and no `/__dev` route
  backdates a tour (`app/src/routes/dev.ts`, route list). A dev fixture route
  is needed and is not listed.

Implies. The gate run is the first place the builder learns the scope. Add
these items to section 7.

## 6. [LOW] D5 requires a 503 on an "incomplete" decline read, but the decline read cannot detect incompleteness

What is wrong. `effectiveDeclines` reads `listingSends.listByUnit` and
`tours.listByUnit` (`broadcasts.ts:462-469`). Both go through `queryAll`, which
on a page-cap hit returns a PREFIX with only a WARN (`app/src/lib/dynamoPaging.ts:49-58`;
`toursRepo.ts:348-363`). Section 7 names completeness work only for the new
open-tours read.

Implies. Either name the decline-read repo changes, or narrow D5 to "fails".

## 7. [LOW] "The existing notice naming it" does not exist

What is wrong. D3 says the composer "shows the existing notice naming it
(`BroadcastComposer.tsx:60-61` copy)". That copy is "That housing authority is
no longer on the list - pick it again" (`:61`). It names no authority. With
several members, "that" is ambiguous, and "pick it again" is wrong for an entry
that left the list.

Implies. New copy that carries the member's name.

## 8. [LOW] `requested` is not "the only partition that never closes"

What is wrong. A `toured` tour with an outcome, or with `convertible: true`,
never auto-closes: `autoCloseDueAtMs` returns null (`toursModel.ts:203-205`).
A Not a fit recorded through the API leaves the tour `toured`
(`routes/tours.ts:1290-1327`). So the `toured` partition also only grows, and
D5 reads it "to the end" with no bound. The cost is small today. The claim is
still false, and it is the basis for bounding only `requested`.

## 9. [LOW] The needs_placement hand-off ("the tenant is `placing`, so D1 leaves them out") rests on a best-effort write

What is wrong. After conversion the tour is `closed` (no hold). Moving the
tenant to `placing` is `deriveForStage`, which is try/catch best-effort
(`placements.ts:909-915`). If that write fails, the tenant stays `searching`,
has no hold, and is included while holding an active placement. This is rare.
State it, or have D4 also read "has an active placement" (out of scope if not
wanted).

## 10. [LOW] D10 overstates the caseworker path

What is wrong. "A caseworker gets a property only when staff send it directly
from the caseworker's page (a seeds-only draft)." The caseworker entry can flip
to filters ("Add more tenants by filters", `BroadcastComposer.tsx:317-328`). The
partner then stays a seed on a FILTER draft (`broadcasts.ts:630-633`, 751-754),
and path (a) accepts partners (`:933`). The guarantee that holds is "only as a
seed or an explicitly checked row", which section 2 already states.

## 11. [LOW] Add a tenant annotation and the joined accessible name are under-specified against pinned selectors

What is wrong.
- Today the annotation is ONE suffix: Not interested outranks Already sent
  (`RecipientPreview.tsx:435-438`). D7 says the tour label goes "after 'Not
  interested' and 'Already sent' when they apply", which implies both can now
  show. The rule is not stated.
- The checkbox name becomes "every reason, joined", with no separator and no
  order given. e2e pins exact names (`review-recipients-heard-from.spec.ts:190`,
  `:208`).
- A no-consent row's name is today consent-only (`RecipientPreview.tsx:106`).
  "Every reason" changes it.

## 12. [LOW] Consequence "A /join lead now starts as Onboarding" is half true

What is wrong. Only a `/join` WITHOUT a unitId starts `onboarding`. A flyer
sign-up (WITH a unitId) starts `needs_review` and stores no authority
(`public.ts:331-342`), so D1 excludes it from every filtered blast. Section 4
should say flyer leads stay out until staff move them.

## 13. [LOW] Small unspecified points

- `audienceSummary` for a list: the format is not given (up to 25 names in a
  list row).
- Path (c): it is not said whether the unchanged cap and truncation refusals
  count the audience before or after the hold and decline exclusions.
- D2 says the results and list projections "read through the normalizer" and
  ALSO that the dashboard has a twin. It does not say whether the server
  rewrites the wire shape or passes the stored filter through.
