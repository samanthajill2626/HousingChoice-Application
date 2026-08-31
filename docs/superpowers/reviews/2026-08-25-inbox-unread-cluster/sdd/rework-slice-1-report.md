# Rework slice 1 - the null/REMOVE half of the index-key guard

Branch: `feat/inbox-unread-cluster`
Worktree: `W:\tmp\inbox-unread-cluster`
Commit: **`31e5ee3ad725def8a1b44bf19d8e6e405c12d656`**
(`fix(contacts): refuse a null REMOVE of a byTypeStatus key in contactsRepo.update`)

Files touched (three, all committed):

- `W:\tmp\inbox-unread-cluster\app\src\repos\contactsRepo.ts`
- `W:\tmp\inbox-unread-cluster\app\test\contactsRepo.integration.test.ts`
- `W:\tmp\inbox-unread-cluster\app\test\helpers\twilioWebhookHarness.ts`

Nothing in `app/src/routes/inbox.ts`, `app/src/lib/unknownQueue.ts`, or
`app/test/helpers/contactsPartitionFake.ts` was read for edit or modified.

---

## 1. Decision: THROW - but NARROWER than the steer, and here is why

**Chosen: throw, scoped to the `byTypeStatus` key attributes (`type`, `status`),
NOT to all of `INDEX_KEY_ATTRIBUTES`.**

The steer was "mirror the existing guard and THROW" over `INDEX_KEY_ATTRIBUTES`.
I took the throw and rejected the scope, because the scope is falsified by a
live caller.

### The thing that changed the shape of the fix

The task brief said a repo-wide sweep during this branch's research found no
current caller nulls an index key. **That is not what the code says.** There is
one, and it is deliberate, documented, and load-bearing:

`W:\tmp\inbox-unread-cluster\app\src\routes\contacts.ts:600`

```ts
patch['housingAuthority'] = v.length > 0 ? v : null;
```

That is `PATCH /api/contacts/:id` - the contact edit form - clearing the housing
authority field. The comment immediately above it (lines 585-599) explains that
it CANNOT use the `''`-clears-it convention precisely because the attribute is
an index key, so it uses `null` -> REMOVE instead, and calls that "the correct
index semantics: the contact leaves the sparse partition rather than joining an
'' one".

`EmptyIndexKeyError`'s own docblock says the same thing twice over: "Callers
clear an indexed attribute with null (-> REMOVE), which also correctly drops the
item out of the sparse index", and its message literally instructs callers to
"pass null to REMOVE it instead".

So a blanket throw over `INDEX_KEY_ATTRIBUTES` would have:

1. **500'd the contact edit form's authority clear** - reintroducing the exact
   production bug the null convention was introduced to fix (the docblock names
   it: "how the contact edit form's housingAuthority clear reached production as
   an unhandled 500"), and
2. **made the sibling error's advice a lie** - it tells you to pass null, and
   the next line would refuse the null.

Per the stop-and-report instruction this is reported rather than worked around:
I did not special-case the route, did not add an escape hatch, and did not
change any caller. I narrowed the GUARD to the set where the hazard is real.

### The distinction that actually matters

Not "is this attribute indexed" but **"is absence a legal state for it".**

| GSI | key(s) | absence is... | in the guard? |
| --- | --- | --- | --- |
| `byTypeStatus` | `type` (hash), `status` (range) | **never legal** - it is how contacts are enumerated by kind | **yes** |
| `byPhone` | `phone` | legal - `removePhone` unsets the scalar by design | no |
| `byEmail` | `email` | legal - `removeEmail` does the same | no |
| `byHousingAuthority` | `housingAuthority` | legal - optional field, tenant-sparse, cleared by the edit form | no |

`type` is REQUIRED on `ContactItem` (`contactsRepo.ts:93`); `phone`, `email` and
`housingAuthority` are all optional. `status` is declared optional but is the
`byTypeStatus` range key, and every read that ENUMERATES contacts of a kind goes
through `listByType` on that index: the Unknown inbox tab, the Today triage
block, `GET /api/contacts?type=`, the importer's dedupe, and
`services/audienceResolution.ts`. Losing it does not error and does not empty
the row - it un-indexes it, so the contact reads back perfectly by id and is
gone from every one of those surfaces, permanently and identically on every
render.

### Why throw rather than allow-and-WARN

- The precedent is one line above and it throws. Two guards over the same hazard
  behaving differently is how the asymmetry got there in the first place.
- The failure class is silent invisibility, which this codebase has repeatedly
  been burned by. A WARN is only diagnosable if somebody is reading logs at the
  moment it happens; a throw is diagnosable at the moment it is written.
- Nothing currently does it, so the blast radius is zero today (verified below).
  The throw is a design-time refusal, not a behaviour change anyone will feel.
- A caller who genuinely wants to clear a `byTypeStatus` key has to think about
  what the row is FOR. The message tells them the two real answers: write a real
  status value, or soft-delete the contact.

Note that the throw is a 500 if a route ever hits it - nothing catches
`EmptyIndexKeyError` today either. That is deliberate and matches the sibling: a
caller bug that should never reach production, not a user-facing condition.

### Error type: extended the family, did not invent a parallel one

Added a shared base rather than a second unrelated class:

```
IndexKeyWriteError  (base, carries `attribute`, catchable as one family)
  |- EmptyIndexKeyError            (unchanged name, message, and `.attribute`)
  |- RequiredIndexKeyRemovalError  (new; also carries `contactId`)
```

Every existing `instanceof EmptyIndexKeyError` site (the integration test, the
webhook harness) keeps working untouched. The new message names the attribute,
the contact, the mechanism, and the remedy:

> cannot REMOVE the indexed attribute 'status' from contact <id>: it is a
> byTypeStatus key, so a contact missing it is invisible to every listByType
> read (the Unknown tab, triage, GET /api/contacts?type=) while still reading
> back by id. Write a real value instead, or soft-delete the contact if it
> should leave the lists.

### The set is derived, not hand-listed

`REQUIRED_INDEX_KEY_ATTRIBUTES` is derived from `getTableSpec('contacts')` by
locating the `byTypeStatus` GSI and taking its hash + range key names - same
spirit as the existing `INDEX_KEY_ATTRIBUTES`.

That derivation has one hole I closed rather than ignored: it keys on the index
NAME, so renaming the index would leave the set EMPTY and silently disarm the
guard - the same silent-failure shape the guard exists to prevent. A
constant-only test pins the contents (`['status','type']`), pins the subset
relation to `INDEX_KEY_ATTRIBUTES`, and pins that `phone`/`email`/
`housingAuthority` are index keys that stay OUT.

### The fake mirrors it

`app/test/helpers/twilioWebhookHarness.ts` already mirrors the `''` guard under
the stated rule "a fake that accepts what real DynamoDB refuses is worse than no
fake". Its `update` now mirrors the null guard too - and it had to, because the
fake stores contacts in a plain array, so a fake that let `status: null` through
would keep the row "visible" and offer an illusion the real GSI does not.

---

## 2. The regression test, shown failing without the guard

Test: `app/test/contactsRepo.integration.test.ts`, in the DynamoDB Local
describe - so it drives the **real** `byTypeStatus` index, not a fake.

`update REFUSES a null REMOVE of status, which would make the contact invisible
to listByType`:

1. create `(type='unknown', status='needs_review')`
2. assert it is returned by `listByType('unknown', { status: 'needs_review' })`
3. assert `update(id, { status: null })` rejects with
   `RequiredIndexKeyRemovalError`
4. assert a companion field in the SAME patch (`{ notes: 'triaged', status: null }`)
   also rejects - refusal is total, no half-applied patch
5. consistent-read the row: `status` unchanged, `notes` never written
6. assert it is STILL in the `listByType` partition

Guard disabled (`if (false && ...)` on the new branch only), same command:

```
FAIL  update REFUSES a null REMOVE of status, ...
AssertionError: promise resolved "{ ...(4) }" instead of rejecting
+ {
+   "contactId": "contact-cbdf25c1-5f36-42ab-b363-7c94643ec412",
+   "created_at": "2026-08-26T18:56:32.487Z",
+   "phone": "+15550100116",
+   "type": "unknown",
+ }            <- note: NO status. The row is now un-indexed and invisible.

FAIL  update REFUSES a null REMOVE of type for the same reason
AssertionError: promise resolved "{ ...(4) }" instead of rejecting
+ { "contactId": "...", "created_at": "...", "phone": "...", "status": "needs_review" }

Test Files  1 failed (1)
     Tests  2 failed | 16 passed (18)
```

Guard restored: `18 passed`. The returned object in the failing run is the whole
finding in one line - a healthy-looking `ContactItem` with the key attribute
quietly gone.

Three more tests were added around it so the two halves of the guard cannot
drift apart:

- `update REFUSES a null REMOVE of type for the same reason`
- `update still CLEARS housingAuthority with null - the sparse lookup keys stay
  clearable` (this is the one that would fail if anyone later widens the guard
  to all index keys, and it says why in the comment)
- the constant-only `contacts index-key guard sets` describe (2 tests), which
  runs with or without Docker

**The existing `''` behaviour was ALREADY pinned** - `update REFUSES an empty
string on a GSI key attribute...` and `update with null REMOVEs
housingAuthority...` were both already in this file. The new tests sit
immediately after them, so all four halves of the guard's contract now read as
one block.

---

## 3. `create` / `createIfAbsent` sweep - a REAL second hole, reported not fixed

**YES, the hole exists at the type level. NO current call site walks into it.**

### The hole

```ts
create(input: Partial<ContactItem> & { type: ContactType }): Promise<ContactItem>
createIfAbsent(item: ContactItem): Promise<boolean>
```

`status?: string` is OPTIONAL on `ContactItem` (`contactsRepo.ts:105`), and
neither writer defaults it - `create` (line ~1054 pre-patch) spreads `...input`
and fills only `contactId` and `created_at`. So **`create({ type: 'unknown' })`
type-checks, succeeds, returns a plausible item, and produces a contact that no
`listByType` read can ever see.** `createIfAbsent` is worse: it takes a whole
`ContactItem` and puts it verbatim with no defaulting at all.

`type` is safe on both (required in the signature).

### Every call site, with evidence

| # | Call site | Sets `status`? | Evidence |
| --- | --- | --- | --- |
| 1 | `app/src/routes/contacts.ts:1049` | yes | passes `parsed.item`; the body parser defaults `item.status` type-scoped (tenant->`onboarding`, landlord->`interested`, else `active`) whenever it is undefined - `routes/contacts.ts:881-884` |
| 2 | `app/src/routes/public.ts:257` | yes | literal `status: 'needs_review'` (housing-fair signup -> triage queue) |
| 3 | `app/src/routes/unmatchedEmail.ts:462` | yes | computes `status` on line 461 and passes it explicitly |
| 4 | `app/src/services/contactCapture.ts:111` | yes | `stubFor` sets `status: 'needs_review'` |
| 5 | `app/src/services/groupConvert.ts:347` | yes | stub literal `type: 'unknown', status: 'needs_review'` (line ~338) |
| 6 | `app/src/services/groupMembers.ts:155` | yes | `stubFor` at line 105-119: `type: 'unknown', status: 'needs_review'` |

That is the complete set - `grep -rn "contacts\.create(\|contactsRepo\.create(\|\.createIfAbsent(" app/src app/scripts` returns exactly six hits and nothing else in the repo writes contacts through those two methods.

### The deliberate exception, which is why a create-time guard is not a one-liner

`putPointer` (`contactsRepo.ts:785`) and `putEmailPointer` (`contactsRepo.ts:858`)
write contact-table items with **no `type` and no `status` on purpose** - the
phone/email pointer rows. `ContactItem`'s own docs say so: a pointer "carries
`phone_ref: true`, `phone_ref_owner`, and the indexed scalar `phone`, but NO
type/status/housingAuthority - so it is invisible to byTypeStatus /
byHousingAuthority (never in lists/triage) yet findable via byPhone."

They do NOT go through `create`/`createIfAbsent` (they use raw `PutCommand`), so
a guard on those two methods would not hit them today. But it means
"un-indexed contact-table row" is a SUPPORTED shape here, and any create-time
guard has to be written knowing that - which is exactly the wider blast radius
the brief anticipated. **Not fixed in this slice, as instructed.** Worth its own
`docs/issues/` entry or a follow-up slice; the cheap version is defaulting
`status` inside `create` the way the route already does, plus tightening
`createIfAbsent`'s parameter to require it.

---

## 4. Suites run (all bare, none piped, none chained)

Only DynamoDB Local was needed and it was already up (`hc-dynamodb-local`, up 43
hours). No server started, no e2e, no full `npm test`.

| Command | Result |
| --- | --- |
| `npx vitest run test/contactsRepo.integration.test.ts` (guard ON) | 1 file, **18 passed** |
| same, guard disabled | 1 file, **2 failed / 16 passed** (see section 2) |
| `npx vitest run` on contactsRepo.integration, contactsCrud, contactTriage, contactsRepo.email, contactsEmailCrud, contactPhones, contactSoftDelete | 7 files, **135 passed** |
| `npx vitest run` on statusTransition, statusTransition.integration, statusModel, extractionApply, extractionDecisions, extractionJob, extractionAddress, contactExtractionRun, audienceResolution, contactCapture | 10 files, **295 passed** |
| `npx vitest run` on twilioSmsWebhook, twilioStatusWebhook, twilioEventsWebhook, groupTextWebhook, voiceWebhook, publicIntake, unmatchedEmailRoutes, groupMembers, groupConvert, groupConvert.integration, importApply.integration | 11 files, **335 passed** |
| `npx vitest run` on founderTriage, transitionRoutes, todayApi, inboxApi, inboxEmail, suggestions, trimStrings, conversationHubApi, contactVoucherSync, contactIntakeFields, landlordContactFields, contactVocabulary, missedCallAutoText, placementConvert | 14 files, **281 passed** |
| `npm run typecheck` (repo root, bare) | **exit 0**, all five workspaces |
| `npx eslint app/src/repos/contactsRepo.ts app/test/helpers/twilioWebhookHarness.ts app/test/contactsRepo.integration.test.ts` | **exit 0**, no output |

**Total: 42 distinct suite files, 1046 tests, zero failures** with the guard on.

Coverage rationale: the guard is on a shared write path, so I ran every
`contacts.update` consumer found by grep (`routes/contacts.ts`, `routes/public.ts`,
`routes/webhooks/twilio.ts`, `routes/webhooks/voice.ts`,
`services/extraction/apply.ts`, `services/statusTransition.ts` - the importer
writes contacts with its own `UpdateCommand` and never calls `update`), plus a
broad slice of the ~90 suites that import the edited `twilioWebhookHarness`.

ASCII check on the diff: `git diff -U0 | grep "^+" | LC_ALL=C grep '[^ -~]'`
returns nothing - every added line is ASCII. (The pre-existing em-dashes in the
`EmptyIndexKeyError` docblock are untouched context.)

---

## 5. Things that surprised me

1. **The "no current caller nulls an index key" premise was wrong**, and it was
   wrong in the one way that changes the answer. `routes/contacts.ts:600` does
   it on every authority clear from the edit form. Had I implemented the steer
   as written, the branch would have shipped a 500 on a routine edit-form save -
   a strictly worse bug than the one being fixed, and one that a
   contactsRepo-only test pass would not have caught (the failing suites would
   have been route suites nobody would think to attribute to a repo guard).
2. **`EmptyIndexKeyError`'s message is an instruction to do the thing the naive
   fix would forbid.** "pass null to REMOVE it instead". The two guards are not
   mirror images; one is advice pointing at the other. That is the strongest
   argument against the blanket form and it is sitting inside the class the
   steer said to mirror.
3. **`status` is optional on `ContactItem` but is a GSI RANGE key.** That single
   mismatch is the whole defect class - the type system says "may be absent",
   the index says "absent means nonexistent", and nothing reconciles them. It is
   also why `create` has the same hole (section 3).
4. **Un-indexed contact rows are a supported shape**, via the phone/email
   pointer items. So "every row in the contacts table must be in byTypeStatus"
   is NOT a true invariant, and any future create-time guard must be written as
   "every row created through `create`/`createIfAbsent`", not "every row".
5. **The derived-set trick can itself fail silently.** Deriving
   `REQUIRED_INDEX_KEY_ATTRIBUTES` by index name means a rename empties the set
   and disarms the guard with no error - the same failure mode as the bug. Hence
   the constant-only pinning test, which runs even without Docker.
6. The `''` half was **already** pinned in the integration test, including the
   legitimate `housingAuthority` null clear. The tests were there; only the
   guard was half-written.
