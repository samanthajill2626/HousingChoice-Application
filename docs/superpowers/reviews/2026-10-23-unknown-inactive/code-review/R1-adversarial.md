# R1 adversarial code review - feat/unknown-inactive

- Reviewer: adversarial, PLAN-BLIND (read only the diff package under
  `.superpowers/review/`, the live tree at HEAD 8738fcfd, and base 916258ae).
- Battery-1 (read before any run): typecheck 0, npm test 0 (527 + 266 + 22 +
  34 + 13 files, no `[dynamoAdmin]` fault line), smoke 0, e2e 372 passed (15.8m).
- Empirical work: five throwaway tests (`zz-review-*`), run singly after
  `battery-1/ALL.done`, all deleted. No tracked file was modified.

Counts: CRITICAL 0, HIGH 0, MEDIUM 1, LOW 4, INFO 5.

---

## 1. MEDIUM - CONFIRMED - the type fence guards the wrong gap: a status picked from the OLD type's list lands on a re-typed contact

Where: `app/src/routes/statusTransition.ts:274-292`,
`dashboard/src/api/endpoints.ts:478` (the body carries no type),
`dashboard/src/routes/contact/ContactEditForm.tsx:187`, `:523-527`, `:551-555`,
`:598`, `dashboard/src/routes/contact/ContactDetail.tsx:939-975` (comment at `:961`).

The AR4 guard (`expectedType: stored.type`) conditions the write on the type
the ROUTE read a few milliseconds earlier. The client never says which type its
status list was built from, so the window that actually matters - between the
page or form showing the list and the pick reaching the server - is not fenced.
The route validates `toStatus` against the NEW stored type and writes it when it
is legal there.

Interleaving (edit form; the window is however long the form stays open):

1. Operator A opens Edit contact on unknown contact X (needs_review). The form
   freezes `base` and `statusType = base.type` (`ContactEditForm.tsx:154`, `:187`),
   so the Status list is [Needs review, Inactive] (`:598`). A picks Inactive.
2. Operator B clicks "Mark as Tenant" on X: type-only PATCH, auto-advance,
   stored (tenant, onboarding) (`contacts.ts:1766-1770`); contact.updated fires.
3. A's page re-reads X and passes the tenant into the open form; the form keeps
   `base`, so its list is still the unknown list and `typeChanged` is false.
4. A clicks Save: `statusTransition` is true (`:527`), so the form sends
   `setTenantStatus(X, { toStatus: 'inactive', source: 'manual' })` (`:551-555`) -
   no type.
5. The route reads (tenant, onboarding) consistently (`statusTransition.ts:274`),
   'inactive' is in TENANT_STATUSES (`:279-283`), `expectedType: 'tenant'` (`:292`)
   matches, the write commits: (tenant, inactive), 200.

The header dropdown has the same shape with a shorter window (until the
contact.updated re-read lands, or for as long as the event stream is down), and
its comment at `ContactDetail.tsx:961` ("re-typed the contact between this page's
read and the pick, so the route wrote nothing") describes protection that does
not exist for that window.

Evidence:
- `app/test/zz-review-stale-client-status.test.ts` (3 cases, passed = defect
  shown): unknown re-typed to tenant then the stale Inactive pick -> 200 and
  stored (tenant, inactive); re-typed to partner -> 200 and (partner, inactive);
  re-typed to landlord -> 400 `toStatus must be one of: ...` (no 409).
- `dashboard/src/routes/contact/zz-review-editform-stale-type.test.tsx` (passed =
  defect shown): form opened on (unknown, needs_review), re-rendered with
  (tenant, onboarding); options stay `["needs_review","inactive"]`; Save calls
  `setTenantStatus('u9', { toStatus: 'inactive', source: 'manual' })` and no PATCH.

Consequence for staff: a contact a colleague has just identified as a tenant or
caseworker is silently set Inactive - hidden from the Tenants view by default,
dropped from Follow up and listing-send eligibility and from blasts (they read
Onboarding/Searching) - with no message to either operator. For a landlord
re-type the save fails with the generic "Couldn't save - please try again."
on every retry (the form's list never changes), after its other field edits
were already saved by the first PATCH.

Fix: send the type the list was built from - `expectedType: base.type` from the
edit form (`statusType` when it differs), `expectedType: contact.type` from the
header - add it to the `/tenant-status` body parser, and 409
`contact_type_changed` BEFORE the allowlist check when it differs from
`stored.type` (keep `stored.type` as the fallback for API callers that omit it).
Map that 409 in the edit form's catch (`ContactEditForm.tsx:558-577`) to the
header's copy. Add the two tests above as regression tests (they fail after the
fix). The landlord status ride on the PATCH (`:341-342`) has the same hole for
the one shared value (needs_review) and could carry the same field.

---

## 2. LOW - CONFIRMED - asymmetric fence: a type-only re-type that KEEPS the stored status is not fenced on that status, so the race stores (unknown, active)

Where: `app/src/routes/contacts.ts:1787-1811` (keep path), `:1659-1661` (the
only guard on a classifying PATCH is `classification_revision`), `:1971-1984`;
`app/src/services/statusTransition.ts:650-652` (writes status without touching
`classification_revision`).

Interleaving:
1. PATCH `{type:'unknown'}` on (team_member, needs_review) reads it consistent;
   needs_review is legal for unknown and is not inactive, so the patch keeps the
   status and carries `type` only.
2. `/tenant-status {toStatus:'active'}` reads (team_member, needs_review),
   PARTNER_STATUSES allows active, writes `status=active` fenced on
   `type=team_member` - succeeds.
3. The PATCH writes `type=unknown` fenced on the unchanged
   `classification_revision` - succeeds. Stored: (unknown, active).

Evidence: `app/test/zz-review-asymmetric-fence.test.ts` (passed): header 200,
PATCH 200, stored `unknown active`; `statusAllowlistFor('unknown')` lacks
active and `UNKNOWN_QUEUE_BLOCKS` has no active block.

Consequence: the pair the branch says every writer refuses
(`statusModel.ts` UNKNOWN_STATUSES comment, STATUS-MODEL.md 5b) exists, and this
branch makes it worse than before: no Unknown-tab block reads `active`, and
Today's triage pass reads needs_review only, so the contact drops off every
triage surface. The same race stores (team_member, parked) or
(team_member, searching). Reach is API-only today: KindPicker offers no
team_member/unknown target (`KindPicker.tsx:39`, `:61`) and the edit form sends
status on every non-tenant type change (`ContactEditForm.tsx:339-340`).

Fix: when the normalize branch keeps the stored status, fence it -
`guards.push(...guardAsRead(stored, 'status'))` (a lost guard is the existing
409 contact_changed) - or write the kept value explicitly so the PATCH cannot
combine a new type with a concurrently written status.

---

## 3. LOW - CONFIRMED - the caseworker conversion changes type and status but emits no contact.updated

Where: `app/src/services/caseworkerConversion.ts:533-555` (commit: type partner,
status active); its only emits are `:373` (suggestion.updated when suggestions
changed) and `:391` (conversation.updated per re-typed thread).

The Unknown card's "Mark as Caseworker" and "Make caseworker" go through this
path, not the PATCH. contact.updated was added because conversation.updated
misses threadless contacts (events.ts docblock); this writer was left out.

Evidence: `app/test/zz-review-conversion-no-event.test.ts` (passed): a threadless
(unknown, needs_review) contact is in GET /api/today needs_you_now; after
`POST .../caseworker-review {action:'make'}` -> 200 (partner, active) it is not,
and the events seen across placement/conversation/suggestion/tour/contact.updated
are `[]`. Control: the same triage through the PATCH emits `contact.updated`.

Consequence: another operator's open Today page keeps "New unknown contact" for a
contact that is now an Active caseworker; the contact page open in another tab
keeps the old type even when threads exist (useContact re-reads only on
suggestion.updated / contact.updated).

Fix: `events.emit('contact.updated', { contactId })` after the commit in
`make()` (before `followOn`, so a follow-on failure cannot swallow it).

---

## 4. LOW - PLAUSIBLE - the live Today/inbox refresh re-reads the changed status through eventually consistent paths

Where: Today's triage pass queries the byTypeStatus GSI (`today.ts:892-899`) and
the unread pass's Inactive skip reads `contacts.getById` with the default read
(`today.ts:362`, `:763-767`); the inbox resolves a row's contact through the
byPhone GSI (`inbox.ts:921`, `contactsRepo.ts:1297-1303`) and the Unknown tab
through byTypeStatus. Both refetch 300 ms after the event (`useToday.ts:39`,
`useInbox.ts:577-583`, `:591`).

A refetch that beats GSI propagation re-renders the pre-write state (the row
still on Needs you now; the inbox row with Needs triage and no Inactive tag) and
no later event corrects it. The contact page was given consistent re-reads for
exactly this reason (`useContact.ts` comment, ruling PR-3); Today and the inbox
cannot read a GSI consistently. Not reproduced: DynamoDB Local applies index
writes synchronously, which is also why the e2e spec's live-drop step passes.

Fix: on contact.updated, schedule a second trailing refetch (for example 2 s
later) in useToday and useInbox; or make the Today unread-pass lookup
`consistentRead` (it is the one base-table read in that path).

---

## 5. LOW - stored (unknown, active) rows at deploy have no migration and vanish from the inbox Unknown tab

Where: `app/src/lib/unknownQueue.ts:188-191` (blocks needs_review, inactive),
comment at `:66-70` (relies on a manual re-count "just before deploy").

Until this deploy, production can still manufacture (unknown, active): the
deployed edit form offers Active for an unknown contact and POST /api/contacts
defaults an unknown create to active. Any such row after the deploy is read by no
Unknown-tab block and by no Today pass; it shows only on Contacts > Unknown, with a
header pill reading "Active" and options [Needs review, Inactive]. The code has no
backstop if the re-count is skipped or finds rows. Not reproduced (data-dependent).

Fix: ship an idempotent ops script (or a step in the rollout) that rewrites
(unknown, active) to inactive (or needs_review), and/or a read-only count that
WARNs at startup when the partition holds an off-list status.

---

## 6. INFO - CONFIRMED - useContact's latest-wins sequence leaves out the initial load

Where: `dashboard/src/routes/contact/useContact.ts:30-45` (initial load commits
unconditionally), `:75-79` (only re-reads take a sequence number).

Evidence: `dashboard/src/routes/contact/zz-review-useContact-initial.test.tsx`
(passed): initial GET held; contact.updated re-read commits `ready:inactive`;
the held initial GET then lands and the state is `ready:needs_review`.
Narrow in practice (the earlier request must arrive after the event plus a
consistent re-read). Fix: give the initial load a sequence number too and drop it
when a newer re-read has already committed.

## 7. INFO - committed writes that go unannounced

`setTenantStatus` emits after the audit append
(`services/statusTransition.ts:667` then `:678`); an audit failure throws
StatusTransitionCommittedError after the write committed, so no contact.updated
fires and the header shows "Couldn't update the status" for a status that did
change (no re-read on that path). The PATCH emits at `contacts.ts:2211` after
`audit.append` and the thread propagation (`:2111-2174`); any throw there returns
500 for a committed write with no event. Fix: emit as soon as the conditional
write succeeds.

## 8. INFO - edit-form status saves for partner/team_member/unknown are now two non-atomic writes

`ContactEditForm.tsx:537-556`: the field PATCH, then `/tenant-status` (they were
one PATCH before). A second-write failure (finding 1's 400, a 409
contact_type_changed) shows the generic save error after the fields were saved;
neither code is mapped in the catch (`:558-577`). Retry is safe (the diff is
against `base`). Fix: map both codes to specific copy.

## 9. INFO - comment and doc drift

- `app/src/lib/events.ts:297-305` names the PATCH as "the edit form's path"; a
  no-type-change tenant/partner/team_member/unknown status save from the edit form
  goes through setTenantStatus (`ContactEditForm.tsx:523-527`).
- STATUS-MODEL.md 5b and the UNKNOWN_STATUSES comment ("every writer refuses
  (unknown, active)") are overstated (finding 2).
- `ContactDetail.tsx:961` claims the 409 covers the page-read-to-pick window
  (finding 1).

## 10. INFO - the Today skip keys on the THREAD type

`today.ts:763-767` skips an `unknown_1to1` thread whose owner is Inactive. A
triage PATCH flips only the primary phone's and the email threads
(`contacts.ts:2111-2128`), so a former unknown's secondary-number thread stays
`unknown_1to1`; once that tenant is Inactive its unread text leaves Today
entirely, although STATUS-MODEL.md 5b says an Inactive tenant's unread text still
shows under Unreplied (before the branch it showed, mis-bucketed, under Needs you
now). Edge case; if it matters, key the skip on the owner's type
(unknown / team_member) as well.

---

## Surfaces swept and found clean

- POST /api/contacts: explicit status validated per type (`contacts.ts:912-918`); unknown default needs_review (`:1013-1022`).
- GET /api/contacts `?type&status` allowlist (`contacts.ts:1139-1146`); parseTriageBody fallback union (`:631-632`).
- Status-only PATCH: consistent read and type fence, deduped against the requirement guard (`contacts.ts:1637-1692`).
- D7 same-type rule in auto-advance and normalize (`contacts.ts:1766-1811`); milestone label by the post-write type (`:2180-2193`).
- PATCH contact.updated semantics: same-value echoes and refused PATCHes emit nothing (`contacts.ts:2207-2213`).
- `/tenant-status` 409 mapping not shadowed by sendContactTypeError (`statusTransition.ts:346-351`); setTenantStatus has exactly one caller.
- `statusLabelFor` / per-type lists: `app/src/lib/statusModel.ts` is import-free; the dashboard mirror test compares lists, labels and options for every type.
- Auto-capture stubs (`contactCapture.ts:79-80`, `groupConvert.ts:339-340`, `groupMembers.ts:111-112`) and every seed: no (unknown, active); the new invariant test covers the seed worlds.
- Inbound SMS, voice, email, /join and flyer paths never write status (`twilio.ts:1210`, `:1251`, `voice.ts:727`, `inboundEmail.ts`, `public.ts:595-620`).
- AI paths: status suggestions are onboarding-tenant-only (`extraction/apply.ts:533-574`) and classification-fenced; a type accept goes through the PATCH (`suggestionResolution.ts:296-313`).
- Importer per-type allowlist with needs_review fallback (`import/apply.ts:970-1000`).
- isEligibleRecipient consumers (`units.ts:301`, `followUps.ts:182`): landlords are never recipients, so the type-free inactive check changes nothing for them.
- Inbox row flags (`inbox.ts:1122-1129`); contactless rows keep needsTriage (`:1177-1188`, `:1567-1579`).
- Unknown queue block order and cursor decoder (`unknownQueue.ts:188-191`, `inbox.ts:441-505`): an old cursor in the removed block is a 400, as documented.
- Dashboard merge/sort (`inboxListMerge.ts:148-163`, useInbox `sortForFilter`): a complete head read drops the tail, so a flipped tail row cannot stay stale.
- Contacts > Unknown order: useContacts walks every page, so `inactiveLast` sees the whole set.
- SSE plumbing: ID-only payload, auth-gated stream, listener removed on close (`api.ts:2752-2803`); bridge and internal route are generic over APP_EVENT_NAMES.
- ContactDetail per-contact reset effect and useMarkContactRead are keyed on contactId, so contact.updated re-reads do not bump generations or re-mark read.
- Authz: status writes stay staff-wide as before; new logs and 409 bodies carry ids, types and codes only.
- e2e spec: reseeds both sides, uses the shared E2E_DASHBOARD_URL idiom (76 specs).
