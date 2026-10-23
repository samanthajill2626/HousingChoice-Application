# invariant-sweep findings - feat/unknown-inactive (Phase 1 build research)

Reader: invariant-sweep (whole-app sweep of every writer and reader of a
contact's (type, status) pair and of the literal status `inactive`).
Tree: worktree W:\tmp\unknown-inactive, code identical to main @916258ae.
Scope checked against spec rev 3 (all of it) and plan v4 sections 0-4; slice
sections read only to see whether a surface is already covered. Only GAPS and
DISAGREEMENTS are listed. Counts: 0 BLOCKER, 1 MAJOR, 3 MINOR.

## 1. MAJOR - Contacts > Unknown will list every Inactive unknown ABOVE every Needs review one

- Plan location: no task covers it. S4.2 (ContactsList rows) changes only the
  row LABEL; S6.1 step (6) (plan ~9095-9101) asserts membership only; spec
  section 3 scopes out status FILTERS on the Unknown view, not its order.
- Tree:
  - app/src/repos/contactsRepo.ts:1379-1414 - `listByType` is one byTypeStatus
    Query with no `ScanIndexForward`, so rows return ASCENDING by the `status`
    range key.
  - app/src/routes/contacts.ts:1156 - GET /api/contacts?type=unknown serves
    straight from it.
  - dashboard/src/api/endpoints.ts:1414-1417 - `getAllContacts` concatenates
    every page in that order (its own docblock: "ordered by `status`").
  - dashboard/src/routes/contacts/useContacts.ts:34, :63-71 - the Unknown view
    fetches only `unknown` and keeps insertion order.
  - dashboard/src/routes/contacts/ContactsList.tsx:265-267 - non-tenant views
    are returned unsorted (`if (!isTenantView) return queried;`).
  - `'inactive' < 'needs_review'` byte-wise. Once S1 lands and staff use the
    header, every Inactive unknown sorts to the TOP of Contacts > Unknown and
    the contacts still needing review sink below them: the reverse of D9's
    Unknown-tab rule (Needs review first, which S5 implements for the inbox
    only), and the reverse of the premise in
    docs/issues/contacts-status-filter-tenants-only.md that a retired contact
    "stays mixed in". On main the mechanism is latent (zero (unknown, active)
    rows in dev and prod). No unit or e2e test in the plan would catch it.
- Correction (a planner call before S4 starts; pick one):
  - (a) extend S4.2: in ContactsList.tsx, for `filter === 'unknown'` only,
    order rows whose status is not `inactive` first, each group keeping
    today's server order (a stable partition) - or reuse the Tenants view's
    last-heard order; add a ContactsList.test.tsx case (an Inactive row
    loaded first renders after a Needs review row) and an order assertion to
    S6.1 step (6) (A after B, as step (7) does for the inbox tab); or
  - (b) change no code: name it in the S4 report, put it to Cameron at the
    merge gate, and correct the existing issue body to say the Unknown view
    lists retired contacts FIRST (an existing-issue body update, AR14).

## 2. MINOR - the race D2/AR4 closes on the transition route stays open on the status-only contact PATCH

- Plan location: AR4 and S2.3-S2.4 fence only
  `PATCH /api/contacts/:id/tenant-status`; S1.1 adds the case "a status-only
  PATCH moves a <type> to inactive" (plan ~721) with no fence.
- Tree: app/src/routes/contacts.ts:1665-1675 validates `status` against
  `stored.type` from the read at :1619-1622 (not a consistent read for a
  status-only body); the write at :1922-1934 carries only the classification,
  requirement and staff-notes guards, so a status-only body writes with no
  condition on `type`. A concurrent re-type between that read and the write
  stores an illegal pair - spec D2's own example: (landlord, inactive) from a
  partner or unknown marked Inactive this way, or (unknown, active) from a
  partner `active` write racing a re-type to unknown. After S4 the dashboard
  reaches this path only from the landlord edit form (D3 keeps landlords on
  the PATCH); API callers reach it for every type.
- Correction: in the PATCH handler, when
  `'status' in parsed.patch && !('type' in parsed.patch)`, add
  `...guardAsRead(stored, 'type')` (contacts.ts:527-534; the requirement
  guards already do this at :1647, so skip it when that clause is present;
  a consistent read for that body, as P12 gave the route, avoids a spurious
  409); a lost guard is the existing
  `409 { error: 'contact_changed', contact }` (:1950-1953). If the planner
  prefers no code change, record it as a known residual in the S1 or S2
  report.

## 3. MINOR - the importer can still store a status illegal for the new type, (unknown, active) included

- Plan location: S1.1 changes only `validStatuses`
  (app/src/lib/import/apply.ts:975-980), which governs the status the import
  WRITES.
- Tree: app/src/lib/import/apply.ts:1150-1154 preserves the stored status
  whenever its `status_source` is not `import` (or is absent); :1173-1174
  still writes `#type = :type` for every contact without
  `type_source: 'manual'`; :1226-1231 writes `status` only when it is not
  preserved. A re-typed row therefore keeps a status from its old type: a
  header-marked Inactive partner or unknown (`status_source: 'manual'`)
  re-typed to landlord by the workbook becomes (landlord, inactive); an
  un-sourced partner `active` (the create default, contacts.ts:1006-1008)
  re-typed to unknown becomes (unknown, active). Spec D6 ("the import: falls
  back to Needs review with a warning") holds only for the written value. The
  spec scopes the importer's type-rule gap out (section 3), but neither
  docs/issues/import-bypasses-contact-type-rules.md nor
  docs/issues/reimport-reverts-unknown-triage.md names this pair shape.
- Correction: no code change on this branch (the importer already owes a code
  fix before the next import:apply). The S1 report names it; the planner
  decides whether to append it to the import-bypasses-contact-type-rules body
  (AR14).

## 4. MINOR - the contact timeline does not refresh on `contact.updated`, even on the page that saved

- Plan location: S2.9 wires only `useContact`.
- Tree: dashboard/src/routes/contact/useContactTimeline.ts:539-545 refetches
  on `onMessagePersisted`, `onConversationUpdated` and `onScheduledUpdated`
  only. The header handler refetches it by hand
  (dashboard/src/routes/contact/ContactDetail.tsx:947-952), but the edit
  form's `onSaved` (ContactDetail.tsx:1345-1348) does not, and D3 now sends
  partner, team_member and unknown form status changes through
  `setTenantStatus`, which writes a `Status -> <label>` milestone and emits
  no `conversation.updated`. So after an edit-form status save, or a change
  made in another tab, the header shows the new status (S2.9) while the
  timeline lacks its milestone until an unrelated event arrives.
- Correction: in S2.9 also subscribe `useContactTimeline` to
  `onContactUpdated`, filtered to its own contactId, calling its existing
  `scheduleRefetch` (one useContactTimeline.test.tsx case); or call
  `timeline.refetch()` in the `onSaved` callback (S4.4). Record the choice in
  the S2 or S4 report.
