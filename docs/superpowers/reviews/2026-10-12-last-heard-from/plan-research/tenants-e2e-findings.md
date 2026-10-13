# Plan research findings - Tenants tab (5.7), heardFrom helpers, C6 re-proof, E2E (1)-(6)

Date: 2026-10-13. Worktree W:\tmp\last-heard-from @ f6aba402 (main merged in).
Spec: docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md rev 5.
Only corrections and ambiguities a literal builder would trip on. Code is cited by
`file:line` (NOW line numbers); byte-exact extracts live in the gitignored reference
(.superpowers/sdd/plan-research/tenants-e2e-reference.md).

## HIGH

F1. A tenant with no status, or a status outside the seven, has no rule under the default
status set. `Contact.status` is optional (dashboard/src/api/types.ts:2167) and StatusBadge
already handles off-list values (dashboard/src/ui/StatusBadge.tsx:94). Spec 5.7
(spec:853-868) defines the default as "every status except inactive and placed" and the
chips as the seven statuses, so a status-less tenant is matched by no chip: either it is
silently hidden by default with no chip to bring it back - which breaks the module's own
invariant "a selection the user can neither see nor clear must not filter"
(dashboard/src/routes/contacts/ContactsList.tsx:202-218) - or it is always shown, which the
spec never says. Existing unit fixtures hit this directly: ContactsList.test.tsx:31 (a
tenant with status 'active') and the status-less T_STUDIO / T_NONE / T_HA_ONLY
(ContactsList.test.tsx:46-82) drive most Tenants-view tests, including chip counts such as
`Studio (1)` (:296-300). The plan must pick one rule (recommended: absent or off-list status
is never hidden by the status facet and counts under no chip; or an eighth "Not recorded"
chip in the default set, reusing `NONE_KEY`'s idea) and test it.

F2. The page-performance harness will silently stop sampling the contact detail surface.
`resolveContactDetail` (e2e/performance/routes.ts:1117-1131) binds the FIRST non-deleted
tenant in GSI order and then requires that tenant's exact link on /contacts/tenants
(`bindResolved`, routes.ts:1073-1082; the source is /contacts/tenants, routes.ts:675). The
performance world cycles all seven statuses (app/src/lib/seed/performance.ts:549-552), and
byte order puts `inactive` first, which the new default hides, so every sample returns
`fixture_not_navigable`. The same trap already happened once for units and was fixed by
binding an Available unit (routes.ts:1132-1135 comment). Add a plan task to bind a
default-visible tenant (or navigate with an explicit `?status=`). Nothing in the gates
catches this: perf:pages is run on demand and routes.test.ts only checks citation shape.

F3. E2E (6) cannot be written with today's seams: there is no way to make a send at least
24 hours old. No dev route writes `listing_sends.sentAt` (the full dev router list:
app/src/routes/dev.ts:208-1292), and the worker stamps it at send time. Spec section 8 (6)
requires "a send older than 24 hours with no reply". The plan must add either a hermetic
dev seam that backdates a listed row's `sentAt` (within the 14-day lookback), or a dev-only
`now`/`asOf` override on GET /api/matching/follow-ups (the tick seams' `nowIso` precedent,
e2e/scenarios/steps.ts:2237, :2914). The spec says nothing, so this is a design decision.

F4. listing-activity.spec.ts will go red on the new outcome chip. It asserts
`page.getByText(/No reply/i)` has count 0 on the property page at
e2e/tests/dashboard-next/listing-activity.spec.ts:231 and :261 (the retired-`response`
proof). Section 5.5's `no_reply` chip reads "No reply yet", which matches. Spec 5.3 lists
the `already sent` selector specs as knowingly updated but not this one; the plan must
rewrite these two assertions (e.g. to the retired label's exact old text or to the absence
of a response control) rather than letting the gate find it.

## MEDIUM

F5. The contact header does not refresh when an inbound arrives. `useContact` fetches once
per id (dashboard/src/routes/contact/useContact.ts:30-45) and re-fetches only on an SSE
`suggestion.updated` naming the contact (:55-70). Spec non-goals list live updates only for
the Tenants tab and roster cards (spec:115-116). The header behavior is unstated. E2E (1)
must `page.reload()` inside a retry loop (the steps.ts:727-745 idiom). State "refreshes on
navigation" explicitly, or add a message-driven refetch as its own task. Also, the label has
minute resolution, so two inbounds in the same minute look the same: E2E (1) should use a
fresh tenant per channel ("Never" to "Today h:mm") or compare `last_heard_from_at` from
GET /api/contacts/:id.

F6. "Beside the status" in the contact header has no room as specified. `.nameRow` is a
flex row that does not wrap (dashboard/src/ui/twoPaneShell.module.css:33-37) on the dark
header band, and it already holds the name, kind pill, StatusMenu or badge, the Deleted
badge and the Do Not Contact badges (dashboard/src/routes/contact/ContactDetail.tsx:947-983).
Do NOT append the line to `buildFacts()`'s string (ContactDetail.tsx:1417-1438):
ContactDetail.test.tsx:2855 pins that line exactly ('Voucher 1BR - Atlanta Housing
Authority'), and :369, :2839, :2847, :2923 read it. The plan should name the element (its
own span on the facts line, or a wrapped nameRow) and use the header color tokens
(`--c-header-facts`, ContactDetail.module.css:89-96).

F7. `formatHeardFrom(iso, now)` is under-specified. Spec 5.1 (spec:364-368) wants a label
"with the full stamp as the hover title", but a single string return cannot carry a title.
The inbox splits this into two functions (dashboard/src/routes/inbox/inboxTime.ts:52, :63).
The spec also defines "Never" only for an absent value, while `formatInboxTime` returns ''
for an unparseable one (inboxTime.ts:54). Recommendations: return `{ label, title }`, or
ship a small component that renders `<time dateTime=...>`, which lets e2e assert the exact
instant the way inbox-rows-timestamps.spec.ts:162-163 does. Treat an unparseable value as
"Never". Keep `formatInboxTime` unchanged (the inbox still shows a bare "2:14 PM").

F8. One `sortByHeardFrom` has to handle two row shapes. Tenants rows are `Contact`, which
has `last_heard_from_at`, `firstName` and `lastName` (types.ts:2164). Review-recipients rows
are `PreviewCandidate`, which will carry `lastHeardFromAt` in camelCase
(types.ts:3358-3375), plus hand-added rows that are `Contact`. The spec also words the tie
differently in the two places: "ties by name" (spec:453) and "ties by the name comparator"
(spec:849-850). The plan must fix a generic signature (accessor functions or a normalized
row type) and one shared comparator.

F9. `applyToParams` and `TenantSelection` need changes the spec only implies.
- The serializer's contract is "only voucher, ha and porting are touched"
  (dashboard/src/routes/contacts/tenantFacets.ts:160-172), and the module header says
  "Empty sets / false = unconstrained" (:57).
- Status needs serialization that knows the default set: drop the param when the selection
  equals the default, and write `_empty` for an empty selection. `TenantFacetModel`
  (:72-85) needs a `status: FacetOption[]` field. So "enters buildFacets like the other
  facets" means a model change, not just a new input.
- Making `status` a required field breaks these `TenantSelection` literals at typecheck:
  ContactsList.tsx:100-104 (`NO_SELECTION`), TenantFilters.test.tsx:12-16 and
  tenantFacets.test.ts:34-38.
- `NO_SELECTION` feeds `facetProbe` (ContactsList.tsx:197). Under the inverted convention,
  an empty status set means zero rows, so the probe must carry all seven statuses (or a
  separate "unconstrained" value). The probe's signals come from the full list
  (tenantFacets.ts:235-245), so only `portingCount` would change, but the plan should still
  state the rule.
- `?sort=` is not a facet. The spec does not say whether it joins `TenantSelection` or gets
  its own writer. Whichever it is, it must merge into the existing params the way
  `updateSelection` does (ContactsList.tsx:246-251) so `?phone=` survives.
- `ContactsFilterTabs` already carries the whole query string on the Tenants tab
  (ContactsList.tsx:80, :277), so status and sort ride along without extra work.

## LOW

F10. The name comparator's fallback does not match the existing helper. Spec:850-851 says
"display fallback (phone or id)", but `contactDisplayName` falls back to the formatted phone
and then the literal 'Unknown contact', never the id
(dashboard/src/routes/contact/format.ts:138-147). The spec also does not say where an absent
last name sorts: with `localeCompare`, '' sorts before 'A', so first-name-only tenants come
first. Recommended order: last name, then first name, then phone, then contactId as the
final stable key.

F11. The scope of the hidden-match hint is ambiguous. Spec:879-883 says "would match a
hidden one" without saying hidden by what: the status facet only, or any facet?
Recommendation: show the hint only when the query matches some tenant that passes the
voucher, authority and porting facets but fails the status facet. The "Show all statuses"
control's role (button) and its exact copy and quoting are also unspecified. The existing
line uses entity quotes (ContactsList.tsx:331-332), so an e2e regex should accept either
style.

F12. The order of the status chips is unspecified (spec:853-854). Recommended:
`TENANT_STATUSES` order (types.ts:771-779). The status group always shows all seven chips
and never uses `emptyLine`. The Clear label will be 'Clear status filter'
(FilterChips.tsx:60). The `baseline` prop must be optional because CaseworkersList.tsx:229-236
also uses ChipGroup. With a non-empty baseline, an empty `_empty` selection has size 0 but
still differs from the baseline, so the new rule has to replace `selected.size > 0`
(FilterChips.tsx:56), not add to it.

F13. Row placement and CSS for the new line are open questions:
- Spec:845-846 says "after the facts span". It does not say whether that is before or after
  the Porting chip (ContactsList.tsx:156-165).
- The CSS documents `.facts` as the ONLY compressible child of `.meta`
  (ContactsList.module.css:199-221, :266-281). Another fixed-width span makes the overflow
  tracked in docs/issues/tenant-row-longname-midpane-overflow.md worse, so the plan must
  give the new span an explicit flex behavior.
- `Row` is shared with the All and Deleted views, and tenant rows show facts on All too
  (ContactsList.tsx:323). The spec limits the line to the Tenants view, so `Row` needs a prop
  driven by `filter === 'tenant'`.

F14. Where the sort control goes is unspecified: inside TenantFilters' controls or next to
the search box. It should render only on the Tenants view and only once loaded, like
ContactsList.tsx:279. A `<select>` does not clash with the chip style: the Properties list
already puts a labeled native `<select>` next to its ChipGroups
(dashboard/src/routes/listings/ListingsList.tsx:338-357).

F15. Citations that drifted after the main merge:
- `useContacts('all')` sites: ContactDetail.tsx:539 is now :561, and ListingDetail.tsx:194
  is now :212 (spec:887-889). The other four are unchanged. The `'deleted'` call sites at
  ListingDetail.tsx:213 and ToursPage.tsx:667 are uncounted, which is correct.
- FYI for 5.4: ContactDetail.tsx:1306-1313 is now :1348-1356, and :1134 is now :1176
  (spec:580, :661, :702).
- Verified still accurate: ContactsList.tsx:197-243 and :216-218; tenantFacets.ts:57-62
  and :217-226; inboxTime.ts:52-60; api/paging.ts:56-85; app/src/routes/contacts.ts
  :1098-1099; e2e/tests/dashboard-next/matching-entry-points.spec.ts:228.
- Spec I4 (spec:938-940) expects e2e specs that assert "Never" or ordering on lean contacts.
  None exist. The only Tenants-tab spec, contacts-list-facets.spec.ts, asserts presence on
  its own onboarding tenants, so it survives the change. roster-paging.spec.ts pins the
  server's page order and never opens the Tenants tab.

F16. The performance ledger pins for these files are already stale and are only
shape-checked: e2e/performance/routes.ts:128, :749-753, :803-807 and :836 cite
useContacts.ts:14-99 (the file has 85 lines) and ContactsList.tsx:232,290-301, while
routes.test.ts:447-451 checks only their format. Updating them is optional cleanup; no test
fails either way.

F17. The C6 re-proof (E2E (5)) only means something in the full run. The issue records a
failure only in the populated seven-case batch, and the isolated case passes even without
the fix (docs/issues/contact-search-popover-below-viewport.md, "Reproduction and
attribution"). A solo green run of matching-entry-points.spec.ts:192 proves nothing; the
proof is the full `npm run e2e`. The patch still applies cleanly at f6aba402
(`git apply --check`).

F18. E2E (1)'s "a call" is covered by the business-line miss path (`placeCall` with
`digit: null`, e2e/fixtures/fakeVoice.ts:35-43; call-inbox-unread.spec.ts:122). No e2e
drives a MEMBER's call to a relay pool number (path #7). The only pool-number call is a
contactless non-member (relay-inbound-caller-identity.spec.ts:64). If the plan wants e2e for
#6 with a known contact, or for #7, it has to write that driver. Specs that create relay
groups must reseed before and after (relay-inbound-caller-identity.spec.ts:40-48).
