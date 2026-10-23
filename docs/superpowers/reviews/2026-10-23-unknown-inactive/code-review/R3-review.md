# R3 code review - feat/unknown-inactive (round 3, fresh reviewer, fix wave 2 cold)

- Reviewer: round-3 code reviewer, fresh (wrote neither earlier round). Read
  the code-review folder (R1/R2 reports and adjudications, FW1/FW2 reports),
  the FW2 diff (b372e6a0..ed2363b3) and the branch diff as of ba39fe2b; did
  not read the spec, plan, build-research or slice records. Authority: the
  live tree at HEAD ed2363b3 (merge base 916258ae).
- Battery-3 at ed2363b3 (read before any run; ALL.done 19:23:29): typecheck
  0; npm test 0 (app 527 files / 11174 passed + 1 skipped, dashboard 266 /
  5487, e2e workspace 22 / 508, 34 / 275, 13 / 111; no `[dynamoAdmin]` line;
  aws-names.txt empty, no AWS_ variable exported); smoke 0 (1733 specifiers /
  301 files); e2e 0 (372 passed, 15.8m).
- Empirical work, all after ALL.done: three throwaway probes
  (`app/test/zz-review-r3-today-mirror.test.ts`,
  `dashboard/src/routes/contact/zz-review-r3-detail-reopen.test.tsx`,
  `dashboard/src/routes/contact/zz-review-r3-form-409-changed.test.tsx`),
  all deleted; ten module-swap runs (two baselines, eight reverts/mutants;
  method under the verification table). No tracked file was edited; `git
  status` was clean at the end apart from this report.

Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 1, INFO 3.

---

## Findings

### 1. LOW - FW2-INTRODUCED (the FW2-2 guard's premise; challenges the R2-6 ruling's "until it is reopened") - CONFIRMED (probe)

The Save-off guard lasts one mount. A close and reopen rebuilds the form
from the contact the 409 never refreshed, so when the page missed the
colleague's event the R2-6 overwrite is one Cancel away.

Where:
- `dashboard/src/routes/contact/ContactEditForm.tsx:597-603` - the 409 arm
  sets only the copy and `retypedUnderForm` (local state); `:169` - `base` is
  the prop at mount; `:583` - `onSaved` runs only after BOTH writes.
- `dashboard/src/routes/contact/ContactDetail.tsx:1364-1373` - the form is
  mounted from the page's `contact` under `editing ?`; `:305` - that contact
  comes from useContact.
- `dashboard/src/routes/contact/useContact.ts:74-91` - the page re-reads
  only on `suggestion.updated` / `contact.updated`; nothing on a reconnect
  (`EventStreamProvider.tsx:65` offers `onOpen`, unused here), and missed
  events are not replayed.
- Contrast `ContactDetail.tsx:966-982`: the header's own 409
  contact_type_changed re-reads the contact (consistent GET), so the pill
  heals; the form's 409 does not.
- The claims this breaks: `ContactEditForm.tsx:109-120` ("So the copy sends
  staff to a fresh read"), `:325-328`, and `ContactEditForm.test.tsx:1946-1948`
  ("the copy's 'Reload the contact' is the only way forward").

Interleaving (probe `zz-review-r3-detail-reopen`, ContactDetail-level with
that test file's own mocks; passed = shown):
1. A's page holds X = (unknown, inactive). A's draft: Change type -> Tenant,
   Status Searching, Save. The PATCH `{type:'tenant'}` resolves; the status
   write answers 409 contact_type_changed (B re-typed X to landlord in
   between). The copy shows and Save is disabled - FW2-2 working.
2. No event reaches A's page (stream down or reconnecting): A clicks Cancel,
   then More actions > Edit contact details. The `getContact` call count is
   unchanged - nothing re-read X - and the form mounts on the same pre-save
   (unknown) contact with Save enabled.
3. A redoes the draft: the second PATCH is `["u9",{"type":"tenant"}]` and the
   status write `{"toStatus":"searching","source":"manual","expectedType":
   "tenant","porting":false}`. Server-side that PATCH has no type fence (FW1
   residual 1) and its classification guard is taken at the PATCH's own read,
   so it lands over B's landlord, and the status write's `expectedType:
   'tenant'` then matches: B's re-type is silently undone - R2-6's outcome.

Control (same probe, second case, passed): when B's `contact.updated` reaches
the page before the reopen, useContact re-reads and the reopened form is
built from the landlord - the guard holds while the stream is up.

Secondary (by reading): the PATCH result that DID land is never applied to
the page on this path. A name-only field PATCH emits no contact.updated
(`app/src/routes/contacts.ts:2222-2228`), so after the 409 the page - and a
reopened form - shows the pre-save name although it saved.

Consequence for staff: rare (a concurrent re-type inside the
PATCH-to-status-write window AND a page that missed the event), but it is
exactly the silent undo of a colleague's re-type that FW2-2 was ruled to
prevent, reached by the most natural recovery (close and reopen) instead of
the browser reload the copy implies.

Fix: in the 409 arm, have the page re-read the contact the way the header's
409 does - e.g. an optional `onStale()` prop that ContactDetail wires to
`getContact(contactId, undefined, { consistent: true }).then(setContact)`
(the same late-answer guard as `:977-981`) - and keep Save off for this
mount. A reopen is then built from the stored contact even with the stream
down, and the fields the PATCH saved show. Pin it at the ContactDetail
level: 409, Cancel, no event, reopen -> the form is built from the re-read
type. Weaker alternative: say "reload the page" in the copy and drop the
"reopen" claims from the comments.

### 2. INFO - NEW - CONFIRMED (probe + existing server tests)

FW2-2 covers the status write's 409 only. The contacts PATCH's OWN lost-guard
409 (`contact_changed`) still maps to "Couldn't save - please try again."
with Save on, and in the same race that retry re-sends the draft's type over
the colleague's re-type.

Where: `app/src/routes/contacts.ts:1659-1661` (classificationGuard is the
revision as read by THIS PATCH), `:1985-2019` (a lost guard is `409 { error:
'contact_changed', contact: current }`); `ContactEditForm.tsx:604-610` (no arm
for contact_changed: the generic copy, Save stays enabled). The server side
is pinned by the existing `app/test/contactTriage.test.ts:915-930` ("returns
the current classification on conflict, even when another writer made a
caseworker").

Probe `zz-review-r3-form-409-changed` (passed = shown): a draft unknown ->
Tenant / Searching whose PATCH answers 409 contact_changed shows "Couldn't
save - please try again.", Save stays enabled, and the second Save re-sends
`["u9",{"type":"tenant"}]` and then the status write with `expectedType:
'tenant'`.

Interleaving: B's re-type lands between A's PATCH read and its write (the
classification fence's own window) -> A gets 409 contact_changed -> the copy
tells A to try again -> A's retry PATCH reads B's type, passes, and writes A's
type over it; the status write then succeeds.

Consequence for staff: the R2-6 outcome through a narrower, pre-existing path
(the fence and the generic copy predate the branch) - but the only one whose
copy actively invites the overwriting retry. Fix: map 409 contact_changed in
the form to a "this contact changed while you were editing - reload it" copy
with the same Save-off (plus finding 1's re-read; the body already carries
the current contact), or record it beside FW1 residual 1 for the planner.

### 3. INFO - NEW (FW2-3 doc check) - CONFIRMED (probe)

STATUS-MODEL 5b and the GLOSSARY Inactive entry promise that an Inactive
unknown contact's or team member's unread text shows only in the inbox. That
is false for a contact re-typed TO unknown or team_member, whose kept typed
threads still feed Today's Unreplied.

Where: `documentation/STATUS-MODEL.md:286-288` ("does NOT show in Needs you
now (a team member's 1:1 threads are unknown threads, so the same rule covers
them) - it shows only in the inbox"); `documentation/GLOSSARY.md:717-720`
("a team member's 1:1 threads are unknown threads too; the unread texts show
only in the inbox"). FW2-report.md:55 says this sentence "was already true
and is unchanged".

Mechanism: the PATCH flips only `unknown_1to1` threads
(`app/src/routes/contacts.ts:2149-2153`) and `conversationTypeFor` has no
unknown or team_member arm (`:541-545`), so a contact re-typed to either keeps
its tenant_1to1 / landlord_1to1 / partner_1to1 threads; the Today skip needs
`unknown_1to1` (`app/src/routes/today.ts:769`), so those threads keep feeding
Unreplied (`:839-871`).

Probe `zz-review-r3-today-mirror` (real routes; passed = shown, both rows): a
tenant with an unread tenant_1to1 thread; PATCH `{type:'unknown'}` (second
row `{type:'team_member'}`) -> 200, thread still tenant_1to1; `/tenant-status
{toStatus:'inactive', expectedType:<new type>}` -> 200, stored (unknown or
team_member, inactive); Today: `["unreplied:c-mir:Unreplied"]` in both rows.

Reachable through an API PATCH or the importer only - the KindPicker offers
neither target (`dashboard/src/routes/contact/KindPicker.tsx:39`). Behavior is
main's (the text was always visible); only the documented promise is wrong.
Consequence for staff: none in the UI; a reader, or the tracker #31 work, is
told these texts never reach Today. Fix: scope both sentences to unknown
threads, e.g. "...does NOT show in Needs you now; a thread it kept from an
earlier type still feeds Unreplied". If Cameron wants "only in the inbox"
literally, key the skip on the owner (an Inactive unknown or team_member
owner skips ANY 1:1 thread), which also removes those Unreplied rows
(tracker #31's section) - planner call.

### 4. INFO - NEW - CONFIRMED (by reading)

FW2-1's comment and docs name the second number as how a typed owner holds an
unknown_1to1 thread. The bigger source is the importer, and that root cause
is already filed.

Where: `app/src/routes/today.ts:761-766` (names only "a tenant's or
caseworker's SECOND number" and the PATCH's primary-phone-only gather);
`documentation/STATUS-MODEL.md:284-285` and `documentation/GLOSSARY.md:723-725`
("a second number's thread"); `app/src/lib/import/apply.ts:1284` and `:460`
(the importer mints EVERY imported 1:1 thread `unknown_1to1`,
`if_not_exists`, whatever the contact's type, and never re-types it);
`docs/issues/imported-unknown-threads-surface-as-unknown-on-today.md` (open,
low: "Today decides by the THREAD type alone").

So after an import, the population FW2-1 puts back on Today (as "New unknown
contact") is every Inactive imported tenant or partner whose threads no
explicit type PATCH re-typed - likely far larger than the second-number case
the comment and docs name. FW2-1's behavior is still right (it is main's);
the text undersells it, and the FW2 residual "the deeper cause ... this wave
files nothing - PLANNER" is already filed under that slug. Consequence for
staff: none directly. Fix (text only): cite the issue in the today.ts comment
and in the 5b / GLOSSARY parentheticals ("an imported thread, or a second
number's"), and append a dated Update to the issue naming the PATCH's
primary-phone-only gather (`contacts.ts:2127-2143`) as a second source and
FW2-1's owner-type rule (AR14 allows a body update). No new issue file needed.

---

## FW2 verification

| Item | Verdict | Revert proof (file: failed / passed (total); baseline) |
|---|---|---|
| FW2-1 | REAL | b372e6a0's `today.ts` swapped in: todayApi.test.ts 2 / 68 (70) - exactly the two new cases, `:1167` (`after` toEqual `before`) and `:1175` (the partner row), both `expected [] to deeply equal [ { group: 'needs_you_now', ...(5) } ]`; every PIN and the cap case pass; a hand-made revert of only the skip block fails the same two. Baseline (exact HEAD copy, same config) 70 / 70. Mutants: drop `owner.type === 'team_member'` -> 1 failed (the OR-6 Inactive team member RED); drop `owner.type === 'unknown'` -> 2 (the Inactive unknown RED, the cap RED); drop the status test -> 2 (the Active team member PIN, the cap RED). The Needs review unknown PIN cannot kill the status mutant (the contacts-triage pass rescues that row); the team member PIN does. |
| FW2-2 | REAL per mount (finding 1) | b372e6a0's `ContactEditForm.tsx`: ContactEditForm.test.tsx 3 / 112 (115) - both it.each rows (`:1983`) and the new case (`:2023`), `expect(element).toBeDisabled()`. Submit guard alone reverted: 1 failed, the new case at `:2026`, `expected "spy" to be called 1 times, but got 2 times` (FW2's own discrimination reproduced). canSave alone reverted: the same 3 fail. Baseline 115 / 115. |
| FW2-3 | REAL, with gaps | inbox.ts, ContactDetail.tsx, api/types.ts, the issue Update and the copy docblock state what the code does (swept list below). Gaps: findings 3 and 4 in STATUS-MODEL 5b / GLOSSARY / the today.ts comment; finding 1 in the docblock's "fresh read". |

Method: each reverted or mutant module is a COPY in the reviewer scratchpad
(the reverts are `git show b372e6a0:<path>`, so exactly the pre-FW2 module),
swapped in by a throwaway vitest config, also in the scratchpad, that merges
`app/vitest.config.ts` or `dashboard/vite.config.ts`. Its resolveId hook
redirects any import RESOLVING to the target file and resolves the copy's own
imports as if from the original path, so the copy needs no rewriting. Every
run logged its `[zz-swap]` redirects (two for today.ts: the test and
routes/api.ts; one for the form), and both baselines through the same config
were green.

## Charge 1 walk - the Today collect loop at HEAD (`today.ts:743-782`, emit `:808-873`)

| Owner (Inactive unless noted) | Thread | Collect loop | Today | Comments and docs |
|---|---|---|---|---|
| unknown | unknown_1to1 | skipped before the cap (`:769-776`) | nothing | true |
| team_member | unknown_1to1 | skipped | nothing | true |
| tenant or partner | tenant_1to1 / partner_1to1 | kept | Unreplied | true |
| tenant or partner | unknown_1to1 (second number, imported) | kept (owner type) | Needs you now "New unknown contact", as main | true; mechanism undersold (finding 4) |
| landlord | any | cannot hold `inactive` (LANDLORD_STATUSES); an imported (landlord, inactive) keeps today's row | as main | true |
| unknown or team_member re-typed from a typed contact | tenant_1to1 | kept (skip needs unknown_1to1) | Unreplied | docs say "only in the inbox" (finding 3) |
| unresolvable (getContact undefined: missing, or the read failed) | unknown_1to1 | kept | "New unknown contact" | true ("keeps today's behavior") |
| no participant contactId | unknown_1to1 | kept, spends a cap slot, dropped at emit | nothing | pre-existing, unchanged |
| deleted | any | skipped first (`:744-747`) | nothing | unchanged |

The skip sits ahead of the dedupe and the cap, so kept typed-owner rows spend
TODAY_UNREAD_CAP slots exactly as on main and skipped ones spend none. No
extra read: `getContact` is memoized and `isDeletedContact` just read the id.

## Adjudications

- FW2-2 (R2-6): CHALLENGED by finding 1 - "until it is reopened" is not
  "until the contact is re-read".
- R2-2 (PLANNER): not challenged. FW2-1 reads the owner through the same
  default-GetItem `getContact` (`today.ts:358-370`), so it neither adds nor
  removes eventual-consistency exposure. Finding 1's fix is the same
  re-read-on-a-known-stale-signal idea, client-side, one consistent GET per
  409.
- The FW2 residual "deeper cause - this wave files nothing - PLANNER": the
  root cause is already filed (finding 4); an Update to that issue suffices.
- FW2-report.md "Tree vs adjudication": right about the PATCH. "The caseworker
  conversion re-types EVERY phone's and email's thread" is slightly broad -
  only the contact's own OPEN, unshared one-to-one threads
  (`app/src/services/caseworkerConversion.ts:262-270`); the code comment's
  "can keep" wording already tolerates it. Records only.
- Every other R1/R2 ruling stands as ruled.

## Surfaces swept clean

- Today collect-loop consumers: the emit loop and `emittedUnknownPhones` (the
  triage dedupe) only; the payload is read only by Today.tsx via useToday; the
  buildToday client fallback (404 only) is unchanged per plan W3; nothing else
  replicates the rule (`unreadFeed.ts:659` is the inbox walk).
- Edit form flag: canSave and the submit guard both read it; Cancel is
  `disabled={saving}` (enabled after the catch) and the Modal's onClose is
  ungated, so the form cannot get stuck; it unmounts on close
  (`ContactDetail.tsx:1364`) and on a contact change (`:369`); no reachable
  `setError(null)` clears the copy while Save is off; implicit submission and
  requestSubmit both hit the guard; NewOrgDialog writes only the org list.
- Other callers of the save contract: the header pill (its own 409, which
  re-reads), the Unknown card's Mark as and the kind-suggestion accept
  (`ContactDetail.tsx:755`, PATCH only), StaffNotesCard and
  ConsentCaptureModal (PATCH only); none sends a status write after a PATCH.
- inbox.ts comments (`:1001-1008`, `:1102-1110`): true - filter=unknown returns
  at `:1862` before passesFilter, a pager drop is `drops['filtered']`
  (`:2463-2464`), the tab reads `listByType('unknown')`, and roleFromContact
  maps team_member to 'unknown' (`:608-615`).
- ContactDetail.tsx `:308-325`: true (`contacts.ts:2227`,
  `caseworkerConversion.ts:575`, `useContact.ts:88-91`).
- api/types.ts ContactUpdatedEvent: matches `app/src/lib/events.ts:297-313`
  (drops its "shown status is not Onboarding or porting changed" qualifier;
  not false); setTenantStatus emits on every success
  (`services/statusTransition.ts:674-678`).
- The issue Update's refs are exact (`contacts.ts:2227`,
  `caseworkerConversion.ts:575`, `useContact.ts:75-90`); its status and
  frontmatter are untouched.
- CONTACT_TYPE_CHANGED_SAVE_COPY docblock: true (the only emitter is the
  transition route, `app/src/routes/statusTransition.ts:313` and `:386`; the
  PATCH has no type fence) except its "fresh read" (finding 1).
- ASCII: every line FW2 added (code, tests, docs, records) is ASCII.
- Test-name nit, no action: `todayApi.test.ts:1170` says "INACTIVE
  CASEWORKER" but seeds a role-less partner; the rule keys on type, so it
  proves the partner case.
