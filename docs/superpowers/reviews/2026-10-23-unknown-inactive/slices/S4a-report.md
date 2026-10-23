# S4a slice report - dashboard contact page, first half: S4.1-S4.3 (tracker #30)

Branch feat/unknown-inactive. Commits: 4138acf0 (S4.1), a8cdb9a6 (S4.2),
132bc331 (S4.2, OR-1), 031a9512 (S4.3), cc563411 (S4.3 follow-up, test
comment only). S4.4-S4.6 are S4b's; nothing of them was started.
Every task went RED for the plan's stated reason, then GREEN:
- S4.1: 24 failed / 7 passed. The new cases die on `TypeError`
  (`PARTNER_STATUSES is not iterable`, `statusOptionsFor is not a
  function`); the mirror's label-map case reads `expected undefined to deeply
  equal {...}`, so the APP imports resolved. The 7 old cases stayed green.
- S4.2: exactly the four `an Inactive <type> is muted` cases (partner,
  team_member, unknown, undefined): `expected 'neutral' to be 'muted'`.
- OR-1: the Unknown-view case rendered server order (`Zed Off, Abe Off, ...`).
- S4.3: exactly the three `status pill` cases and the 409 case (no
  `Contact status: ...` button). The deleted PIN stayed green.
`npm run typecheck` exit 0 after S4.1, S4.2, OR-1 and S4.3. At the end, the
directories that use the changed helpers ran green: src/routes/contact,
src/routes/contacts, src/ui, src/api (99 files, 2071 passed).

## What the tree held that the plan got wrong

- Every S4.1-S4.3 anchor was byte-exact on the tree after S1-S3. S2 did not
  touch the ContactDetail.tsx import list, so step 3b had no extra name to
  keep. app/src/lib/statusModel.ts has no `import` statement (the word appears
  only in comments and strings, :225, :292, :308).
- Two stale comments the plan does not list. S2 (contact.updated, plus OR-4's
  timeline refetch) made "no SSE event covers it" false in two places: the
  onChangeStatus `.then` comment (base ContactDetail.tsx ~:949-951) and its
  twin in the tenant-pill test (base ContactDetail.test.tsx ~:442-444). Both
  are rewritten, comments only: ContactDetail.tsx:953-956 (in 031a9512) and
  ContactDetail.test.tsx:442-445 (in cc563411). The explicit
  `timeline.refetch()` stays, because it still covers a stream that is down.
- Left as is (out of scope): ContactDetail.tsx:724 still says the opt-out
  milestone has the "same no-SSE gap as status". Status no longer has that
  gap; the opt-out milestone still does.
- OR-21 predicted the old lint error at ~:209. It is at ContactsList.tsx:219:
  S4.2 adds 1 docblock line and OR-1's helper adds 10.

## Divergences

- The two comment-only fixes above.
- OR-1 uses a module-private helper, `inactiveLast`
  (ContactsList.tsx:105-113), instead of an inline comparator. The rule is
  the same: a stable sort on a copy, keyed on the literal `inactive`.

## WORKLIST items

- OR-1 (132bc331, its own commit, test first). For `filter === 'unknown'`
  only, the `visible` memo returns `inactiveLast(queried)`
  (ContactsList.tsx:280). `filter` joined the memo deps (:288). All,
  Landlords and Deleted keep server order. The Caseworkers page is untouched.
  Tests: RED at ContactsList.test.tsx:217. The server returns two Inactive
  rows then two Needs review rows; the screen shows the Needs review rows
  first, each group in server order. The names are chosen so that a name sort
  and a reversed list both fail. PIN at :234: the All view keeps server order.
  Issue body (AR14): docs/issues/contacts-status-filter-tenants-only.md:21-25
  now says that Inactive contacts list after the Needs review ones on the
  Unknown view (tracker #30) but still show there, and that the Caseworkers
  view sorts by name, so a retired caseworker stays mixed in. Not edited: the
  issue's `ContactsList.tsx:217` refs (frontmatter :9 and body :14) point at
  `isTenantView`, which is now :228.
- OR-15: the S4.2 test comment says "muted color" (StatusBadge.test.tsx:61).
  No added line in any S4a file uses the British spelling.
- OR-20: every committed file has 0 non-ASCII bytes in its added lines against
  916258ae. The new contactStatusMirror.test.ts has 0. None of the touched
  files holds a `u2192` escape.
- OR-21 (lint, run at the end): `npx eslint` on the 12 touched .ts/.tsx files
  exits 1 with ONE error: ContactsList.tsx:219:21
  `react-hooks/set-state-in-effect`. As a baseline I linted the 916258ae
  content of that file (`git show` into the scratchpad, then
  `npx eslint --stdin --stdin-filename dashboard/src/routes/contacts/ContactsList.tsx`).
  It shows the same single error at :208, so the error is pre-existing and
  not S4a's. The other 11 files are clean, ContactDetail.tsx included.
- OR-22: I read a bare `git status` before every `git add`. Nothing was ever
  staged that I had not staged.

## For the planner

- Clarification 5 / AR21. Non-tenant Contacts list rows show their type's
  label as plain text (ContactsList.tsx:180, via `statusLabel` :100-103 and
  `contactStatusLabel`). They get no toned badge, so D4.4's muted color shows
  on the contact page header (pill tone and the deleted contact's badge) but
  NOT on non-tenant list rows. Tenant rows keep `StatusBadge kind="tenant"`,
  where Inactive was already muted.
- The 409 re-read calls `setContact` directly (ContactDetail.tsx:969-973),
  outside useContact's OR-5 latest-wins sequence (useContact.ts:74-87). The
  concurrent re-type emits its own contact.updated, so useContact re-reads
  too. Both are consistent reads of the same record, which is harmless,
  unless a third write lands between them: the older answer could then show
  until the next event. This is the same class as S2's recorded residual
  (`setContact` does not bump the sequence). Not changed.
- `contactStatusTone('landlord', 'inactive')` stays `neutral`: LANDLORD_TONE
  has no inactive, and D1 makes the pair illegal.

## As-built names (S4b and S6 depend on these)

- dashboard/src/api/types.ts (re-exported through api/index.ts):
  `PARTNER_STATUSES` :819, `type PartnerStatus` :821, `PARTNER_STATUS_LABELS`
  :823, `UNKNOWN_STATUSES` :829, `type UnknownStatus` :831,
  `UNKNOWN_STATUS_LABELS` :833, `type ContactStatusValue` :839 (TenantStatus |
  LandlordStatus | PartnerStatus | UnknownStatus).
  `statusOptionsFor(type: string | undefined): { value: string; label: string }[]`
  :857.
  `contactStatusLabelFor(type: string | undefined, status: string): string | undefined`
  :864 (uses Object.hasOwn, so an inherited key such as 'constructor' returns
  undefined).
  The private `contactStatusListFor` :844 handles tenant, landlord and
  unknown explicitly; any other type, unset included, gets the partner list.
- format.ts:123 `contactStatusLabel(type, status)` returns
  `contactStatusLabelFor(...) ?? humanize(status)`.
- StatusBadge.tsx:119 `contactStatusTone`: for any type other than tenant or
  landlord, needs_review -> warn, inactive -> muted, anything else -> neutral.
- endpoints.ts:478 `setTenantStatus`: the input `toStatus` is now
  `ContactStatusValue`. ContactEditForm.tsx's TenantStatus-typed call
  (:542-543) compiles unchanged.
- ContactDetail.tsx, the status pill:
  - `StatusMenu` renders for `contact.status && !deleted` (:1031), with
    `options={statusOptionsFor(contact.type)}` (:1034) and
    `label="Contact status"` (:1038). So the trigger is named "Contact
    status: <label>", the menu is a role=menu named "Contact status", and
    each item is a menuitemradio named by its label.
  - `onChangeStatus` (:939) calls
    `setTenantStatus(contact.contactId, { toStatus, source: 'manual' })`.
  - 409 (:960): `err instanceof ApiError && err.status === 409 &&
    err.code === 'contact_type_changed'`. It sets
    `CONTACT_TYPE_CHANGED_STATUS_COPY` as the error, then calls
    `getContact(contact.contactId, undefined, { consistent: true })` followed
    by `setContact`. Any other error keeps "Couldn't update the status -
    please try again."
  - The exported `CONTACT_TYPE_CHANGED_STATUS_COPY` (:143) reads "This
    contact's type just changed, so its status list did too. Pick the status
    again." It renders in StatusMenu's role=alert span, which shows only
    while the menu is closed.
  - A deleted contact keeps `ContactStatusBadge` (:1042).
- ContactsList.tsx: `inactiveLast` :111. For S6.1 step (6), the rows list is
  `getByRole('list', { name: 'Unknown' })`, and each row is a link named by
  the contact's display name.
- For S4b: ContactEditForm.tsx still has its private `statusOptionsForType`
  (:138, used at :588) and `NON_TENANT_STATUS_VALUES` (:33), which S4.4
  deletes. The shared export is `statusOptionsFor`, with no `Type` suffix.

Untrimmed input paths: none (no new input; status values are fixed keys).
No existing e2e spec asserts the old badge-only header for a non-tenant
type: the `Contact status:` selectors in e2e/scenarios/steps.ts:1465-1481
and conversation-fact-extraction.spec.ts:279-283 are landlord and tenant
flows, which are unchanged.
