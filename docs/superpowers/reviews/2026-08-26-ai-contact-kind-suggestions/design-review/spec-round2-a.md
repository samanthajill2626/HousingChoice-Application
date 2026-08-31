# Adversarial Design Review - Round 2

Reviewed the revised specification at `d2190eee`, the independent first-round
review, and the adjudications. The accepted first-round changes correctly narrow
the raw-audit claim, enumerate Edit contact as a classification writer, limit the
notes guarantee to reconciliation/exact deduplication, and point raw-operation
parsing at `schema.ts`. The remaining finding is a new/retained type-specific
violation of the design's own Unknown-only and race-safe guarantees.

## 1. [HIGH] The preserved replacement fence strands a pending type suggestion after classification

### What is wrong

Section 7 deliberately preserves the generic human-edit race policy: a suggestion
created or replaced during the contact write is neither deleted nor stamped. That
is safe for ordinary field suggestions because their renderer remains on the
classified contact. It is not safe for `target: 'type'`, whose only actionable
renderer is the Unknown file and whose generic accept endpoint refuses the target.

This reachable sequence leaves permanently misleading work:

1. An Unknown contact has pending type suggestion S1.
2. Staff classifies it through either D7 writer. The PATCH snapshots S1.
3. An extraction already in flight used the pre-write Unknown `ContactItem`, so it
   writes/replaces the single `type` row with S2 while the PATCH is updating the
   contact.
4. The PATCH's conditional delete of S1 fails. Per the specification, S2 stays
   pending and its AI run is not given a verdict.
5. The contact is now Tenant, Landlord/Property Manager, or Partner. None of those
   files receives a type-suggestion renderer; generic acceptance is rejected for
   `type`; the Unknown card, including its four buttons, has disappeared. Today
   nevertheless includes every pending suggestion and links staff to that contact.

The result is a pending AI Suggestions item that cannot be accepted, superseded,
or dismissed by the intended classification UI, and an accuracy run left pending
after the human decision. Reopening Edit contact without changing kind does not
send a `type` field, so it also does not enter the route's snapshot/delete loop.
The spec's proposed test requires this replacement to remain pending, thereby
locking in the bad state rather than detecting it.

### Evidence

- The stated guarantees are advisory, race-safe, and compatible with existing
  suggestions: spec section 2, lines 35-42. D6 says type suggestions exist only
  while the contact is Unknown: lines 177-183.
- D7 keeps `type` out of generic acceptance: lines 207-215. Section 7 explicitly
  requires a replacement during the contact update to remain pending and unstamped:
  lines 377-387; section 8.1 requires a test asserting that result: lines 418-427.
- The existing PATCH route snapshots only the old exact identity before
  `contacts.update`, then does nothing when its conditional deletion did not
  succeed: `app/src/routes/contacts.ts:1506-1539`. Its own comment states that a
  replacement remains pending and unstamped: `app/src/routes/contacts.ts:1529-1530`.
  The existing regression test asserts that policy for `pets`:
  `app/test/aiRunVerdicts.test.ts:1894-1919`.
- Extraction makes the Unknown-only decision from a passed `ContactItem`, not a
  fresh read (`app/src/services/extraction/apply.ts:160-177`), and the job invokes
  it after a potentially long model call with the earlier `contact` object
  (`app/src/jobs/extraction.ts:544-578`). It can therefore put S2 after the human
  write using the stale Unknown snapshot. The type branch puts a pending suggestion
  from that snapshot (`app/src/services/extraction/apply.ts:536-555`).
- Only `UnknownFile` receives `suggestions`; LandlordFile and PartnerFile do not,
  and TenantFile is passed suggestions but renders chips only for voucher size,
  housing authority, address, phone, status, and porting:
  `dashboard/src/routes/contact/ContactDetail.tsx:989-1054` and
  `dashboard/src/routes/contact/TenantFile.tsx:180-241`. Generic accept rejects
  `type`: `app/src/services/suggestionResolution.ts:203`. Today enumerates every
  pending suggestion without target/type filtering:
  `app/src/routes/today.ts:942-972`.

### What it implies

The design needs a type-specific post-classification race outcome, rather than
blindly inheriting the generic replacement policy. It must state which conditional
operation proves S2 was generated from pre-classification state and then closes or
supersedes that row and its run without deleting a truly current suggestion. The
test matrix must inject a replacement for `target: 'type'` during each D7 writer,
then prove no type suggestion remains in Today or a classified contact's pending
list and that the corresponding AI decision has a terminal verdict. Without that
decision and test, implementation cannot satisfy D6's Unknown-only rule and the
claimed race safety simultaneously.
