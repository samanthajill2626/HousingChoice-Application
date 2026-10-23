# s2-notify findings - plan v4 section 6 (S2 transition route and live notify)

Reader: s2-notify (Phase 1, read-only). Scope: plan section 6 (S2.1-S2.10)
in full, plus S1.4 (plan 2005-2191) as the base S2.3 anchors on.

Result: 0 BLOCKER, 0 MAJOR, 6 MINOR. Every quoted S2 anchor matches the live
tree (the S2 source files are CRLF on disk; the Edit tool handles that) and is
unique where an Edit needs it; S1.1, S1.3 and S1.4 leave every S2 anchor
intact. Every helper, fake, harness API and import the S2 code calls exists
with the shape used. Every stated RED and PIN was traced through the current
code and holds for the stated reason. Checked and clean:

- `app/test/eventBridge.test.ts:43` is the only test or code that counts or
  lists event names (app/src, app/test, dashboard/src, e2e, scripts);
  `ALL_APP_EVENTS` (`app/src/lib/events.ts:318`) is the only
  `Record<AppEventName, ...>`; the bridge (`eventBridge.ts:45`) and
  `internal.ts:34` need no change.
- `UpdateContactOptions.expect` is `ExpectClause | ExpectClause[]` with
  `value: string | number | boolean | null` (`app/src/repos/contactsRepo.ts:712-741`),
  so `{ attr: 'type', value: expectedType }` fits (`ContactItem.type` is a
  required `ContactType`, :115). `getById(id, { consistentRead })` (:756).
  The harness fake honors every `expect` clause before applying a field
  (`app/test/helpers/twilioWebhookHarness.ts:2435-2453`), so the S2.3/S2.4
  409 cases are neither vacuous nor red. In `setTenantStatus` nothing is
  audited, timelined or emitted before the guarded write
  (`app/src/services/statusTransition.ts:609-635`).
- Every post-write path of the contact PATCH reaches the S2.5 emit (no
  `return` after the update catch, `app/src/routes/contacts.ts:1953-1959`);
  one emit per PATCH; the caseworker case inside the PATCH is a pre-write
  409 (:1776-1781) and the conversion route is a separate writer (already
  listed in S2.10).
- `getContact(contactId, signal?, { consistent })` exists
  (`dashboard/src/api/endpoints.ts:1474-1487`; the server honors
  `?consistent=1` at `contacts.ts:1264`). The useEventStream, useToday,
  useInbox and useContact test setups can each drive `contact.updated` as
  written; no existing dashboard test asserts `getContact` arguments on the
  suggestion.updated re-read S2.9 makes consistent.

1. MINOR - S2.10 Step 3, "Known extra reads, accepted" is incomplete.
   Tree/plan: S4.4 3g/3h (plan ~7498-7541) saves a type change to tenant whose
   shown status is not onboarding (or a porting change) as the PATCH and then
   `setTenantStatus`. After S2 that is TWO `contact.updated` for one save (the
   S2.5 emit after `contacts.ts:2141-2144`, then the S2.3 emit in
   `setTenantStatus`). Today and the inbox debounce at 300 ms
   (`dashboard/src/routes/today/useToday.ts:39`,
   `dashboard/src/routes/inbox/useInbox.ts:140`) and usually coalesce;
   S2.9's `refetchInPlace` issues two consistent GETs with no latest-wins
   guard, so an earlier GET answering last would show the PATCH-only
   (tenant, onboarding) contact until the next event (the property today's
   suggestion.updated re-read already has).
   Correction: add this bullet to the S2 report's accepted list. Optional
   hardening (planner call): a `useRef` request counter in `refetchInPlace`
   that drops a response which is not the latest request's.

2. MINOR - S2.10 Step 3, the "no contact.updated on a committed write that
   then fails" bullet names only `StatusTransitionCommittedError`.
   Tree: the S2.5 emit sits after the non-best-effort
   `await audit.append(...)` (`contacts.ts:2119`) and the unguarded
   thread-propagation awaits (`contacts.ts:2073-2093`:
   `findByParticipantPhone`, `findByParticipantEmail`, `applyTriage`). A throw
   there 500s a PATCH whose status/type write already committed, and no
   `contact.updated` goes out.
   Correction: record it in the same report bullet; no mechanism change.

3. MINOR - S2.5 Edit A/B, `priorStatus` freshness.
   Tree: `priorStatus` (`contacts.ts:1631`) comes from the pre-read at
   `contacts.ts:1619-1622`, which is consistent ONLY when the body touches an
   org field, type/role or a requirement key. A status-only PATCH (the
   landlord edit-form path, D3) diffs against an eventually consistent read,
   so a status the header wrote moments earlier can make `statusChanged`
   false and suppress the emit (the existing milestone diff at :2129 has the
   same exposure). `priorType` is unaffected: a body with `type` already
   forces the consistent read.
   Correction (planner call): add `'status' in parsed.patch` to the
   consistent-read condition at `contacts.ts:1621` (one clause; also fixes
   the milestone diff), or record it as a residual beside W8 in the S2 report.

4. MINOR - W8 citations (plan section 3 W8; S2.10 Step 3 W8 bullet).
   Tree: the (unknown, needs_review) GSI read is `app/src/routes/today.ts:870`
   (`contacts.listByType('unknown', { status: 'needs_review', ... })`; :868 is
   the page-loop header). The GetItem behind the AR8 skip is the memoized
   `getContact` at `today.ts:358-370` (default-consistency
   `contacts.getById` at :362, the same read the deleted-contact skip uses at
   :378-381). The bullet says "Today/Inbox" but names only Today reads; the
   inbox Unknown-tab walk is also a byTypeStatus GSI read
   (`app/src/lib/unknownQueue.ts:350`).
   Correction: cite `today.ts:870` and `today.ts:362`, and add the
   `unknownQueue.ts:350` inbox read, in the S2 report's W8 bullet.

5. MINOR - C4 citation (plan "Contradictions and clarifications" C4).
   Tree: `app/test/sse.test.ts:364-387` is the Twilio status-callback emit
   gate test (exact `world.emitted` after POST /webhooks/twilio/status), not
   a contact PATCH; the PATCH-side exact assert is
   `app/test/contactTriage.test.ts:85-96`. The ruling itself (keep
   `contact.updated` out of the recorder at `twilioWebhookHarness.ts:617-623`)
   is right: every exact `world.emitted` assert would otherwise move.
   Correction: in the S2 report's C4 bullet describe sse.test.ts:364-387 as
   a status-webhook exact assert.

6. MINOR - a resolved issue body that S2.9 supersedes.
   Tree: `docs/issues/staff-notes-stale-page-overwrite.md:15-17` (status
   resolved) says nothing refreshes an open contact page: "there is no
   contact SSE event, and useContact refetches only on suggestion.updated".
   After S2.9 `useContact` also re-reads on `contact.updated` (status/type
   changes only; a staff_notes edit still emits nothing).
   Correction: per AR14 do not edit it (resolved history); name it in the S2
   report.
