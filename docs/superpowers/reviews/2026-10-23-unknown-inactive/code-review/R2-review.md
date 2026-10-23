# R2 code review - feat/unknown-inactive (round 2, fresh reviewer)

- Reviewer: round-2 code reviewer, fresh (did not write round 1). Read the R1
  reports, the adjudications and the FW1 report; did not read the spec, plan,
  build-research or slice records. Authority: the live tree at HEAD ba39fe2b
  (merge base 916258ae).
- Battery-2 at ba39fe2b (read before any run; ALL.done 18:27:19): typecheck 0;
  npm test 0 (app 527 files / 11172 passed + 1 skipped, dashboard 266 / 5486,
  e2e workspace 22 / 508, 34 / 275, 13 / 111; no `[dynamoAdmin]` line; no
  AWS_ variable exported); smoke 0 (1733 specifiers / 301 files); e2e 0
  (372 passed, 15.8m).
- Empirical work, all after ALL.done: two throwaway probes
  (`app/test/zz-review-pair-invariant.test.ts`,
  `app/test/zz-review-today-secondary-thread.test.ts`), both deleted; seven
  fix-reverted mutant runs (method under the FW1 table). No tracked file was
  edited; `git status` clean at the end.

Counts: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 2, INFO 4.

---

## Findings

### 1. LOW - ADJUDICATION-CHALLENGE (ADV-10, recorded INFO) - CONFIRMED

An Inactive tenant's unread text on a SECOND number disappears from Today,
although STATUS-MODEL 5b promises it shows under Unreplied.

Where: `app/src/routes/today.ts:763-767` (the skip keys on the THREAD type and
the owner's status, never the owner's type); `app/src/routes/contacts.ts:2137-2145`
(a triage PATCH finds threads by the scalar PRIMARY phone and the emails only,
so a secondary number's `unknown_1to1` thread is never re-typed);
`documentation/STATUS-MODEL.md:282-285` ("An Inactive tenant's or partner's
unread text still shows in Today's Unreplied"); the GLOSSARY Inactive entry
says the same; the code comment `today.ts:758-760` ("an Inactive
tenant/landlord/caseworker thread still feeds Unreplied").

Reproduced (probe `zz-review-today-secondary-thread`, passed = defect shown):
unknown contact with phones [P1 primary, P2], an `unknown_1to1` thread on each,
P2 unread.
1. `PATCH /api/contacts/c-two {type:'tenant'}` -> 200; threads afterwards:
   `conv-p1=tenant_1to1`, `conv-p2=unknown_1to1`.
2. Today: `["needs_you_now:New unknown contact"]` (pre-existing mis-bucket,
   but visible).
3. `PATCH .../tenant-status {toStatus:'inactive', expectedType:'tenant'}` -> 200.
4. Today: `[]` - the unread text is on no Today section at all.

Consequence for staff: someone working Today never sees an unread text from an
Inactive tenant's (or caseworker's) second number; before this branch it
showed. The inbox still shows it. R1 recorded this for the planner as an edge;
a real triage flow produces it and it breaks a documented guarantee.

Fix: add the owner's type to the skip at `today.ts:763-767`
(`owner.type === 'unknown' || owner.type === 'team_member'`), which restores
the pre-branch row for a typed owner; pin it with the probe's flow. The deeper
cause (triage never re-types a secondary number's thread; a typed owner's
`unknown_1to1` renders as "New unknown contact") is pre-existing - file it, or
for #31. If the planner keeps the code, STATUS-MODEL 5b, GLOSSARY and the
`today.ts:758-760` comment must name the exception.

### 2. LOW - ADJUDICATION-CHALLENGE (ADV-4 / W8, recorded) - PLAUSIBLE

The spec D2 live behavior (an open Today drops the row, an open inbox shows the
tag, no reload) rests on ONE refetch over eventually consistent reads, and
nothing corrects a stale answer.

Where: `dashboard/src/routes/today/useToday.ts:39`, `:132-135` (one refetch,
300 ms after the event); `dashboard/src/routes/inbox/useInbox.ts:142`,
`:577-591`; `app/src/routes/today.ts:358-363` (memoized `getContact`, default
GetItem) read by the Inactive skip at `:763-767`; `:892-899` (triage pass,
byTypeStatus GSI); the inbox Unknown blocks (`lib/unknownQueue.ts`, GSI) and
byPhone resolution (GSI).

Interleaving: (1) the header pick commits (unknown, inactive) and emits
contact.updated (`services/statusTransition.ts`, after the audit); (2) an open
Today refetches 300 ms later; (3) the triage Query on byTypeStatus answers with
the pre-write index image, so X is still in the (unknown, needs_review)
partition and "New unknown contact" is re-rendered; (4) no later event comes,
so the row stays until an unrelated event or a reload. The inbox's Needs
triage chip / missing Inactive tag behaves the same through the GSI-fed reads.
DynamoDB Local applies index writes synchronously, so the green e2e step 5 says
nothing about production.

Why challenge the record: this is the feature's headline observable rule, the
failure is silent, and the cheap fix is client-side only.

Fix: on `contact.updated` ONLY, schedule a second trailing refetch (about
1.5-2 s) in useToday and useInbox (status changes are rare: one extra read per
change per open page). Optionally make the Today skip's lookup consistent (not
the label hydration that shares `getContact`).

### 3. INFO - NEW - CONFIRMED (by reading)

`inbox.ts` still encodes "Unknown tab = needsTriage" in a dead filter arm and a
comment; D9 broke that equivalence.

Where: `app/src/routes/inbox.ts:993-1000` (`case 'unknown': return
row.needsTriage;`); comment `:1093-1094` ("A type='unknown' contact IS an
untriaged inbound ... so it needs triage, and it is what the 'unknown' filter
serves").

The arm is unreachable today (filter=unknown returns at `:2364`, before the
pager's `passesFilter` at `:2450`), but it exists so a future routing change
cannot be a silent no-op - and its predicate is now wrong: an Inactive unknown
contact is on the Unknown tab with `needsTriage: false` (`:1127`). A refactor
that sends the tab back through the pager would drop every Inactive unknown
row, visible only as `drops.filtered`.

Consequence: none today; a latent trap. Fix: `return row.role === 'unknown'`
with a D9 note, and amend the `:1093` comment.

### 4. INFO - NEW - CONFIRMED (by reading)

The housing-authority review comment and its issue now describe behavior this
branch changed.

Where: `dashboard/src/routes/contact/ContactDetail.tsx:313-322` says the page
learns of another operator's type change "only through useContact's
suggestion.updated re-read" and "A generic contacts-PATCH re-type usually emits
none ... so after one the review can stay open";
`docs/issues/ha-review-close-name-patch-unfenced.md` "The plain re-type case"
says the same.

Interleaving: A opens "Is this really new?" on tenant T; B re-types T to
landlord (edit form or Unknown card -> PATCH); the PATCH emits contact.updated
(`app/src/routes/contacts.ts:2221-2228`); A's useContact re-reads consistently
(`useContact.ts:74-90`); the render-time reset (`ContactDetail.tsx:323`) closes
the review. The caseworker conversion now emits it too
(`caseworkerConversion.ts:575`). What remains is the dropped-stream /
in-flight window the issue already names for the client close.

Consequence: none for staff; it misleads whoever sizes the
TODO(ha-review-close-name-patch-unfenced) fix. Fix: update the comment and the
issue body (its described behavior changed, so AR14 allows the edit); the
server-side fence stays the remedy for API callers and dropped streams.

### 5. INFO - FW1-INTRODUCED (FW1-6 incomplete) - CONFIRMED (by reading)

The dashboard mirror of ContactUpdatedEvent keeps the claim FW1-6 removed from
events.ts. `dashboard/src/api/types.ts:2129-2134`: "through the status
transition route (the header dropdown) or the contact PATCH (the edit form)",
"Mirrors app/src/lib/events.ts ContactUpdatedEvent". The edit form's
no-type-change saves and its post-retype-to-tenant write go through
setTenantStatus, and the caseworker conversion is a third emitter
(`app/src/lib/events.ts:291-310`). Fix: mirror the events.ts sentence.

### 6. INFO - FW1-INTRODUCED - CONFIRMED (by reading)

`CONTACT_TYPE_CHANGED_SAVE_COPY`'s docblock is wrong for a draft that changed
the type, and Save stays enabled.

Where: `dashboard/src/routes/contact/ContactEditForm.tsx:107-117` ("the Status
list it offers is the OPENED type's", "A retry from this form would send the
old type again"); the save path `:529-571`.

Interleaving: A's draft re-types unknown X to Tenant with Searching; Save sends
the PATCH `{type:'tenant'}` (commits X tenant/onboarding); B re-types X to
landlord before A's status write; A's `setTenantStatus(searching,
expectedType:'tenant')` -> 409 -> the copy. Save is still enabled and the draft
kept; a second Save diffs against `base` (unknown), re-sends `{type:'tenant'}`
(the PATCH has no client-side type fence, so it lands over B's landlord) and
the status write with `expectedType:'tenant'` then SUCCEEDS. In this path the
list is the NEW type's and the retry does not send the old type.

Consequence: an operator who clicks Save again instead of reloading silently
undoes a colleague's re-type. The overwrite is the pre-existing unfenced PATCH
(FW1 report residual 1, not widened); the docblock now states the opposite.
Fix: correct the docblock; the cheap real guard is to disable Save (or close
the form) after this 409, so the copy's "Reload" is the only way forward.

---

## Adjudications not challenged

SPEC-F3/ADV-7 (PLANNER), SPEC-F2/F4/F5 (PLANNER), ADV-5/W7, ADV-6, ADV-8 and
the FW1-1 residual for the landlord status that rides the PATCH (pre-existing,
not widened: before this branch every non-tenant form status rode the PATCH)
are sound as ruled. The FW1 fixes are the right fixes: a type fence is
sufficient for the stale-list window (the list depends on the type alone; an
A-B-A re-type puts the same list back), and guarding the kept status (409)
beats writing it explicitly (that would overwrite a concurrent status write).

## FW1 verification

Method: each "fix reverted" copy lives in the reviewer scratchpad (relative
imports rewritten to absolute worktree paths) and is swapped in by a throwaway
vitest config, also in the scratchpad, merging `app/vitest.config.ts` or
`dashboard/vite.config.ts`. The swap is a resolveId hook that redirects any
import RESOLVING to the target file, instead of a specifier `resolve.alias`:
`./statusTransition.js` names routes/statusTransition.ts from routes/api.ts
AND services/statusTransition.ts from services/suggestionResolution.ts, so a
specifier alias would swap the wrong module. Every run logged its `[zz-swap]`
redirect, and every baseline through the same config was green.

| Item | Verdict | Proof (file: failed / passed (total) under the revert; baseline) |
|---|---|---|
| FW1-1 route | REAL | both expectedType branches -> `if (false)`: transitionRoutes.test.ts 6 / 34 (40), exactly the six non-PIN FW1-1 cases (`expected 200 to be 409`, `expected 400 to be 409`, `"robot": expected 200 to be 400`); both PINs pass. Baseline 40/40. |
| FW1-1 edit form | REAL | `expectedType: statusType` removed: ContactEditForm.test.tsx 10 / 104 (114), including the re-rendered-with-a-re-typed-prop regression; the 409 mapping removed: 2 / 112 (the two 409 copy cases). Baseline 114/114. |
| FW1-1 header | REAL | `expectedType: contact.type` removed: ContactDetail.test.tsx 6 / 148 (154), every header pick test. Baseline 154/154. These pin the call shape; the header has no other type source. |
| FW1-2 | REAL | M1 (read-time compare + unconditioned update): statusTransition.test.ts + transitionRoutes.test.ts 2 / 110 (112), exactly the two FW1-2 cases (`promise resolved ... instead of rejecting`; `expected [] to deeply equal [ { attr: 'type', value: 'tenant' } ]`). Baseline 112/112. |
| FW1-3 | REAL | `keptStatusGuards.push(...statusAsRead)` -> `void statusAsRead`: contactTriage.test.ts 2 / 100 (102), the two race cases (`expected 200 to be 409`); PINs pass. Baseline 102/102. Also: the pair probe's status-only-PATCH racer fails under this revert and passes on the real code, so the guard covers that racer too. |
| FW1-4 | REAL | the emit removed: caseworkerConversion.test.ts 2 / 84 (86): `expected [] to deeply equal [ { event: 'contact.updated', ...(1) } ]` and the before-followOn order case; PINs pass. Baseline 86/86. |
| FW1-5 | REAL | `|| portingChanged` dropped: ContactEditForm.test.tsx 1 / 113 (114), only the new porting case. |
| FW1-6 | REAL, one miss | events.ts, STATUS-MODEL 5b, statusModel.ts and unknownQueue.ts now state what the code does (the pair probe below backs "every writer but the importer"); the dashboard mirror docblock was missed (finding 5). |

## Surfaces swept clean

- Pair invariant, probe `zz-review-pair-invariant` (3/3 on real code): a
  status-only PATCH racing a team_member -> unknown keep-path PATCH (409); the
  reverse order (OR-3 type fence, 409); a /tenant-status write racing a D7
  re-type from Inactive (explicit needs_review). Never (unknown, active).
- Every status/type writer: the PATCH, setTenantStatus (route-only caller), the
  caseworker conversion (explicit partner/active, fenced), the AI status accept
  (onboarding tenant -> searching only, classification-fenced, emits
  suggestion.updated), the derived tenant status (tenant-only, skips
  on_hold/inactive, never derives inactive), the importer (documented
  exception), creates (manual, /join, flyer, unmatched email, capture stubs),
  restore/softDelete (no status), dev route.
- contact.updated: emitters are the PATCH, setTenantStatus and the conversion,
  on the router's own bus (`contacts.ts:1069-1089`); subscribers are useToday,
  useInbox, useContact and useContactTimeline; SSE, bridge and internal route
  are generic over APP_EVENT_NAMES; the payload is ID-only.
- Dashboard writers: only ContactDetail and ContactEditForm call
  setTenantStatus; nothing sends status `active` for an unknown contact;
  useContacts never filters by status; the create form sends no status; every
  dashboard write applies its own response (Mark as, conversion, phones).
- isEligibleRecipient: followUps and the units listing-send rows only; `eligible`
  only orders rows (`listingFormat.ts:353-354`).
- Inbox: one buildContactRow feeds every path; team_member maps to role unknown
  (pre-existing chip); contactless rows unchanged; head-read merge as R1 found.
- Perf seed: the third status arm is unknown-only (`contactTypeAndOrdinal`
  returns tenant/landlord/unknown).
- Possible caseworkers, audience resolution, push service: no status
  dependency changed.
- FW1 code read cold: the route's 400/409 order, its log fields (ids and
  validated types only), the edit form's `statusType === kind.type` at every
  enabled Save, the conversion emit placement, the new test fixtures against
  the fake repo's guard semantics (`twilioWebhookHarness.ts:2415-2464` mirrors
  the conditional write) - no vacuous test found.
