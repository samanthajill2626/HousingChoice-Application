> **FINDINGS HALF ONLY.** Extracted 2026-08-27 from `research-repos-unreadfeed.md`, which was ~90%
> byte-exact quotation of code git already holds at the commits cited below. Only the
> drift/corrections section - what the plan and spec got WRONG - is kept here. The
> reference half was not committed.

# Research: repo / library layer for the Unknown-tab contact-side read

READ-ONLY sweep of `W:\tmp\inbox-unread-cluster` (branch `feat/inbox-unread-cluster`),
2026-08-26. Nothing was modified; no tests or servers were run.

Scope: `app/src/repos/contactsRepo.ts`, `app/src/lib/tables.ts`,
`app/src/lib/unreadFeed.ts`, `app/src/lib/contactThreads.ts`,
`app/src/routes/today.ts` (precedent only), `app/src/lib/logger.ts`, plus an
invariant sweep of every writer of a contact's `type` / `status` / `origin` /
`deleted_at` and every reader of `listByType('unknown')`.

Every quote below is byte-exact from the worktree at the stated line.

---
## DRIFT (what the plan/spec got wrong)

### D1. BLOCKING-ish: the real `lastEvaluatedKey` is NOT `{ contactId }`

`listByType` passes DynamoDB's raw `LastEvaluatedKey` straight out
(`contactsRepo.ts:1021-1025`):

```ts
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as ContactItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
```

The query runs on `IndexName: 'byTypeStatus'` (`:1011`). For a **GSI** query
DynamoDB returns the index key attributes **plus** the base-table key, so the
real LEK for this index is:

```
{ type: <S>, status: <S>, contactId: <S> }
```

not `{ contactId }`. The plan's Task 1 fake mints
`lastEvaluatedKey: { contactId: last.contactId }` (plan line 272) and its Task 1
test asserts `expect(page1.lastEvaluatedKey).toEqual({ contactId: 'd2' })`
(plan lines 301, 330, 356). That pin describes a shape production never
produces.

Mitigating facts, so this is a fidelity note rather than a stop-the-build:
- The existing sibling fake has the same shape
  (`app/test/helpers/twilioWebhookHarness.ts:1710`:
  `...(more && last !== undefined && { lastEvaluatedKey: { contactId: last.contactId } })`),
  so `{ contactId }` is an established repo convention for this fake.
- No production caller inspects the LEK's contents. `today.ts:871` feeds it back
  verbatim as `exclusiveStartKey`; `routes/contacts.ts:1006-1007` base64s it as an
  opaque cursor.
- The fake's own reader only looks at `opts.exclusiveStartKey?.['contactId']`, so
  it is self-consistent.

Recommendation: either mint `{ type, status, contactId }` in the fake (and keep
reading only `contactId`), or add a one-line comment saying the shape is
deliberately narrowed. Do not let a test assert `toEqual({ contactId: ... })`
without that comment - it reads as a production pin.

### D2. The plan's `lib/import/apply.ts:884-899` citation points at the wrong code

Plan line 179 lists `lib/import/apply.ts:884-899` among the "every write path sets
a status" evidence. That range is the status **derivation** helper, not a write:

```
878	  const validStatuses: readonly string[] =
879	    type === 'tenant'
880	      ? TENANT_STATUSES
...
897	    status = validStatuses.includes(person.suggestedStatus)
898	      ? person.suggestedStatus
899	      : 'needs_review';
```

The actual contact WRITE is `upsertContact` at `apply.ts:937-1053`. `#type` is
written unconditionally (`:967` `'#type = :type'`, `:976` `':type': resolved.type`);
`#status` is written **conditionally** (`:1023-1028`):

```ts
  if (!preserveStatus) {
    sets.push('#status = :status', 'status_source = :statusSource');
    names['#status'] = 'status';
    values[':status'] = resolved.status;
    values[':statusSource'] = 'import' satisfies TransitionSource;
  }
```

The conclusion still holds - `preserveStatus` requires `prior.status !== undefined`
(`:961-964`), so a status-less prior always gets one written - but the cited lines
do not show it and a reviewer checking them will not find the guarantee.

### D3. The spec's "four lines past the range cited here" is off by fourteen

Spec section 2 (design doc line 106) says the `excludeOrigin` safety reason "is
stated four lines past the range cited here" for `today.ts:855-899`. The sentence
is at `today.ts:917-918` - **eighteen** lines past 899:

```
917	        // partition anyway; a real unknown caller who TEXTED still surfaces
918	        // through the conversation-row source above.
```

The claim is true; only the locator drifted.

### D4. `listByType`'s `deleted` option is BINARY in code, not tri-state

Plan line 111 and spec section 3 call it "tri-state". The implementation
(`contactsRepo.ts:1000-1003`) tests `opts.deleted === true` only:

```ts
      names['#del'] = 'deleted_at';
      const deletedFilter =
        opts.deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)';
      const filters = [deletedFilter];
```

`undefined` and `false` are the SAME branch. The operative conclusion - "both" is
not expressible in one Query - is CONFIRMED, and one further fact the plan does not
state: **`FilterExpression` is ALWAYS present.** `listByType` can never issue an
unfiltered Query, so the "an unfiltered Query never returns an empty page with a
LEK" reasoning (used at `unreadFeed.ts:356-358`) does not transfer to this index.

### D5. `unreadFeed.ts:695-709` is the right neighbourhood, not the right lines

Plan line 128 cites `unreadFeed.ts:695-709` for the flag semantics. Current lines:
`consumedAll` at `:695`, `capped` set at `:674-677`, `truncated` derived at `:708`,
`capped` returned at `:709`. Both substantive claims are **CONFIRMED** verbatim
(see C12).

### D6. Not drift, but read it correctly: which two warns share a limiter

Plan Step 5 comment (plan line 1858) says "the two bind to ONE module-scope
limiter, so a request that trips both emits one line, never two." That is
**CORRECT** for the pair it means: the **in-iterator** scan warn
(`unreadFeed.ts:373`) and `warnUnreadScanned` (`:245`) both call `warnWalkScanned`
(`:154`). It is **NOT** true across tripwire kinds: `warnDeletedProbes` uses a
DIFFERENT module limiter, `warnProbeBurst` (`:155`). A request that trips the
scan tripwire AND the probe tripwire emits **TWO** lines. See C14.

### D7. Confirmed-as-written (checked, no drift)

- `ContactType` union and `contactsRepo.ts:51` - exact.
- `byTypeStatus` hash/range at `lib/tables.ts:90-94` - exact.
- `ContactsPage { items, lastEvaluatedKey? }`, `ListContactsOpts` at `:472-490`,
  `listByType` interface member at `:522` - exact.
- `Limit` applies at the index BEFORE the FilterExpression, so a residue-thick page
  returns short/empty WITH a LEK - CONFIRMED by construction (`:1013` vs `:1016`).
- `truncated = !capped && !state.scanExhausted`; `capped` counts ALL candidate
  kinds - CONFIRMED verbatim.
- `UNREAD_WALK_LIMIT` is 2000 - CONFIRMED.
- `statusAllowlistFor('unknown') === ['needs_review','active']` - CONFIRMED.
- `contactCapture.ts:79-81`, `groupMembers.ts:111-112`, `groupConvert.ts:339-340`,
  `routes/contacts.ts:881-884` - all four exact.
- `twilioWebhookHarness.ts` `listByType` at `:1684`, items-remaining LEK at
  `:1707` - both exact, and the deleted filter really is applied before `Limit`
  (`:1691`, inside the `partition` construction).
- `conversationsForContact(contact, Pick<ConversationsRepo,
  'findByParticipantPhone' | 'findByParticipantEmail'>)` - exact signature; the
  file is `contactThreads.ts:38-54` as cited.
- `roleFromContact` at `inbox.ts:396-403` - exact.
- The `unreadFeed.js` import block at `inbox.ts:86-96` really does carry
  `collectUnreadRows`, `UNREAD_WALK_LIMIT`, `warnDeletedProbes`, `warnUnreadScanned`
  (and `BADGE_COUNT_CAP`, `isUnreadVisible`, `warnTruncatedZeroCount`).

---

