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

## A. `app/src/repos/contactsRepo.ts`

### A1. `ContactItem` - `contactsRepo.ts:91-291`

Only `contactId` and `type` are REQUIRED. Everything else is optional, and the
interface ends with an index signature (`[key: string]: unknown` at `:290`), so it
is a flexible document.

Field-by-field for the fields the plan depends on:

```
 91	export interface ContactItem {
 92	  contactId: string;
 93	  type: ContactType;
...
108	  status?: string;
...
116	  status_source?: TransitionSource;
...
124	  porting?: boolean;
...
132	  park_reason?: string;
133	  /** E.164 (byPhone GSI) — the PRIMARY number (back-compat scalar). */
134	  phone?: string;
...
140	  phones?: ContactPhone[];
...
146	  email?: string;
...
152	  emails?: ContactEmail[];
153	  sms_opt_out?: boolean;
154	  sms_unreachable?: boolean;
...
162	  email_opt_out?: boolean;
163	  email_unreachable?: boolean;
...
170	  voice_opt_out?: boolean;
...
181	  deleted_at?: string;
...
183	  capture_source?: string;
185	  captured_at?: string;
186	  created_at?: string;
...
196	  consent_method?: ConsentMethod;
198	  consent_at?: string;
...
208	  group_participation_at?: string;
...
217	  origin?: string;
...
227	  import_retract_started_at?: string;
...
236	  voucher_expiration_date?: string;
239	  consent_version?: string;
241	  consent_note?: string;
243	  consent_captured_by?: string;
...
251	  phone_ref?: boolean;
252	  phone_ref_owner?: string;
...
260	  email_ref?: boolean;
261	  email_ref_owner?: string;
...
267	  pets?: string;
268	  evictions?: string;
270	  tenure?: string;
271	  lifEligible?: boolean;
...
279	  contract_status?: 'unsigned' | 'signed';
280	  registered_landlord?: boolean;
281	  rta_within_48h?: boolean;
282	  pass_inspection_first_try?: boolean;
283	  income_includes_voucher?: boolean;
...
290	  [key: string]: unknown;
291	}
```

Confirmations the plan asked for:
- `status` EXISTS and is `status?: string` - **optional, and a bare `string`**, not
  a union. `:108`.
- `type: ContactType` - **required**. `:93`.
- `origin?: string` - optional. `:217`. Doc: "Today the only value is
  `'group_detection'` (services/groupMembers.ts)".
- `deleted_at?: string` - optional ISO 8601. `:181`. Its docstring already names the
  resurfacing rule: "The INBOX hides them too, with ONE exception: a deleted contact
  resurfaces (row flagged `deleted`) while an UNREAD inbound newer than this stamp
  exists".
- `phone?: string`, `email?: string`, `phone_ref?: boolean`, `email_ref?: boolean` -
  all optional.
- `contactId: string` - required.

Note for the fake: the `phone_ref` docstring (`:244-250`) states a pointer item
"carries `phone_ref: true`, `phone_ref_owner` (the real contactId), and the indexed
scalar `phone`, but NO type/status - so it is invisible to byTypeStatus". The
plan's fake filters pointers explicitly AND filters `status === undefined`; the
second filter alone would already catch a real pointer item.

### A2. `ContactType` - `contactsRepo.ts:51`

```ts
export type ContactType = 'tenant' | 'landlord' | 'partner' | 'team_member' | 'unknown';
```

Its doc block (`:44-50`) names the queue directly: "On the byTypeStatus GSI,
(type=unknown, status=needs_review) IS the human triage queue".

### A3. `ListContactsOpts` - `contactsRepo.ts:472-490` (FULL, byte-exact)

```ts
export interface ListContactsOpts {
  /** Narrow to a single status within the type partition (byTypeStatus range). */
  status?: string;
  limit?: number;
  exclusiveStartKey?: Record<string, unknown>;
  /**
   * Soft-delete scope. Omitted/false → exclude deleted contacts (the default for
   * every normal list). true → return ONLY soft-deleted contacts (the Contacts
   * "Deleted" view). Applied as a FilterExpression on `deleted_at`.
   */
  deleted?: boolean;
  /**
   * Drop rows carrying this `origin` (fix wave 2, adversarial 6). A
   * FilterExpression, so it saves the CALLER work but NOT the page slot -
   * DynamoDB applies `Limit` at the index first. A caller that must not go blind
   * behind a wall of excluded rows therefore also has to page (see today.ts).
   */
  excludeOrigin?: string;
}
```

All five names the plan's fake consumes are EXACT: `status`, `limit`,
`exclusiveStartKey`, `deleted`, `excludeOrigin`. Every field optional. Types:
`string`, `number`, `Record<string, unknown>`, `boolean`, `string`.

Note the docstring already carries the plan's own argument for the fill loop
(`excludeOrigin` "saves the CALLER work but NOT the page slot").

### A4. `ContactsPage` - `contactsRepo.ts:466-470`

```ts
/** One page of a contacts list query (opaque cursor handled at the route). */
export interface ContactsPage {
  items: ContactItem[];
  lastEvaluatedKey?: Record<string, unknown>;
}
```

`items` is a mutable `ContactItem[]`; `lastEvaluatedKey` is optional and
untyped-by-key.

### A5. `listByType` - FULL implementation, `contactsRepo.ts:986-1026`

```ts
    async listByType(type, opts = {}) {
      // ONE Query on byTypeStatus: hash = type, optional range = status. `type`
      // and `status` are DynamoDB reserved words → expression-aliased.
      const names: Record<string, string> = { '#t': 'type' };
      const values: Record<string, unknown> = { ':t': type };
      let keyExpr = '#t = :t';
      if (opts.status !== undefined) {
        names['#s'] = 'status';
        values[':s'] = opts.status;
        keyExpr += ' AND #s = :s';
      }
      // Soft-delete scope (FilterExpression — byTypeStatus projects ALL attrs, so
      // deleted_at is filterable). Default HIDES deleted; deleted:true shows ONLY
      // deleted (the Contacts "Deleted" view).
      names['#del'] = 'deleted_at';
      const deletedFilter =
        opts.deleted === true ? 'attribute_exists(#del)' : 'attribute_not_exists(#del)';
      const filters = [deletedFilter];
      if (opts.excludeOrigin !== undefined) {
        names['#origin'] = 'origin';
        values[':excludedOrigin'] = opts.excludeOrigin;
        filters.push('(attribute_not_exists(#origin) OR #origin <> :excludedOrigin)');
      }
      const input: QueryCommandInput = {
        TableName: table,
        IndexName: 'byTypeStatus',
        KeyConditionExpression: keyExpr,
        FilterExpression: filters.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(opts.limit !== undefined && { Limit: opts.limit }),
        ...(opts.exclusiveStartKey !== undefined && {
          ExclusiveStartKey: opts.exclusiveStartKey as QueryCommandInput['ExclusiveStartKey'],
        }),
      };
      const { Items, LastEvaluatedKey } = await doc.send(new QueryCommand(input));
      return {
        items: (Items ?? []) as ContactItem[],
        ...(LastEvaluatedKey !== undefined && { lastEvaluatedKey: LastEvaluatedKey }),
      };
    },
```

Answering each question exactly:

- **KeyConditionExpression**: `#t = :t` always; `AND #s = :s` appended ONLY when
  `opts.status !== undefined`. So `status` is a KEY condition (applied before
  paging), `type` is the hash.
- **FilterExpression**: ALWAYS present. Contains the soft-delete predicate
  (`attribute_not_exists(#del)` by default, `attribute_exists(#del)` when
  `deleted === true`), joined with `' AND '` to
  `(attribute_not_exists(#origin) OR #origin <> :excludedOrigin)` when
  `excludeOrigin` is supplied. Note the origin filter is written to KEEP rows with
  no `origin` attribute at all.
- **`Limit`**: passed only when `opts.limit !== undefined`; **OMITTED entirely
  otherwise**, in which case DynamoDB pages at the 1MB result cap. (The plan's
  Task 1 fake synthesizes `limit ?? 50`; the plan already documents that as a
  FAKE-ONLY caveat at plan lines 225-229 - correct and worth keeping.)
- **`ExclusiveStartKey`**: passed through unchanged, cast only.
- **`lastEvaluatedKey`**: the raw DynamoDB `LastEvaluatedKey`, present iff the
  service returned one. Its key attributes are the GSI's `{ type, status }` PLUS
  the table key `{ contactId }` - see **D1**.
- **Default `deleted` behaviour**: omitted or `false` -> `attribute_not_exists(deleted_at)`,
  i.e. live rows only. `true` -> `attribute_exists(deleted_at)`, i.e. deleted only.
  No "both".
- **`excludeOrigin` exists**; the option name is exactly `excludeOrigin`.

### A6. `isDeleted` - `contactsRepo.ts:301-308`, EXPORTED

```ts
/**
 * A contact is soft-deleted when it carries a non-empty `deleted_at` stamp.
 * Shared by the repo (query filters) and the inbox/today routes (hydration
 * filters) so "deleted" is defined in exactly one place.
 */
export function isDeleted(contact: Pick<ContactItem, 'deleted_at'>): boolean {
  return typeof contact.deleted_at === 'string' && contact.deleted_at.length > 0;
}
```

Note: an EMPTY-STRING `deleted_at` is NOT deleted here, but IS indexed by the real
`attribute_exists(#del)` filter. Irrelevant in practice (no writer produces one)
but it is a real fake-vs-DynamoDB divergence if a fixture ever sets `deleted_at: ''`.

### A7. `ContactsRepo.listByType` - `contactsRepo.ts:517-522`

```ts
  /**
   * List/filter via the byTypeStatus GSI (M1.5): all contacts of a type,
   * optionally narrowed by status (the (type=unknown, status=needs_review)
   * partition IS the triage queue). ONE Query per page — never a Scan.
   */
  listByType(type: ContactType, opts?: ListContactsOpts): Promise<ContactsPage>;
```

`ContactsRepo` is an `interface` (`:492`), so `Pick<ContactsRepo, 'listByType'>`
is valid. Note the first parameter is typed `ContactType`, NOT `string` - the
plan's Task 1 helper signature is `type: string`, which is fine for the helper but
means a `Pick<ContactsRepo,'listByType'>`-shaped fake must accept `ContactType`
(the plan's Task 4 fake does: `async listByType(type: ContactType, ...)`).

### A8. `createIfAbsent` - `contactsRepo.ts:542-548` (interface) / `:1073-1090` (impl)

```ts
  /**
   * Conditional create (attribute_not_exists(contactId)): true when THIS
   * call created the item, false when the contact already existed. An
   * existing contact's fields are NEVER overwritten — this is the M1.2
   * auto-capture no-overwrite guarantee, enforced at the write.
   */
  createIfAbsent(item: ContactItem): Promise<boolean>;
```

Takes ONE argument, a whole `ContactItem`, and returns `Promise<boolean>`.
`{ contactId, type, status, phone }` typechecks (only `contactId` + `type` are
required; the index signature accepts the rest).

Sibling: `create(input: Partial<ContactItem> & { type: ContactType }): Promise<ContactItem>`
(`:541`), which mints `contactId` and stamps `created_at` (`:1054-1071`).

### A9. `statusAllowlistFor` - `app/src/lib/statusModel.ts:189-208`

NOT in `contactsRepo.ts`. Exported from `lib/statusModel.ts`:

```ts
/**
 * Status allowlist for contact types WITHOUT a lifecycle (team_member/unknown):
 * the simple `needs_review` (auto-capture stub) → `active` (resolved). Tenant and
 * landlord have their own richer lifecycles above; see {@link statusAllowlistFor}.
 */
export const NON_TENANT_STATUSES = ['needs_review', 'active'] as const;

/**
 * The single source of truth for the type-scoped status allowlist. A TENANT
 * carries its §5 lifecycle (TENANT_STATUSES); a LANDLORD carries the lead
 * lifecycle (LANDLORD_STATUSES); every other type (team_member/unknown) carries
 * the simple needs_review|active. Used by BOTH status-setting paths (the generic
 * contact PATCH and the `/tenant-status` transition route) so a landlord can
 * never be pushed into a tenant-only state.
 */
export function statusAllowlistFor(type: string | undefined): readonly string[] {
  if (type === 'tenant') return TENANT_STATUSES;
  if (type === 'landlord') return LANDLORD_STATUSES;
  return NON_TENANT_STATUSES;
}
```

**The spec's claim is CONFIRMED**: `statusAllowlistFor('unknown')` is
`['needs_review', 'active']`. It is also the FALL-THROUGH arm, so an `undefined` or
unrecognised type gets the same allowlist.

Supporting fact for spec class (f), also CONFIRMED exactly at the cited lines
(`routes/contacts.ts:881-884`):

```ts
  if (item.status === undefined) {
    item.status =
      item.type === 'tenant' ? 'onboarding' : item.type === 'landlord' ? 'interested' : 'active';
  }
```

So a manually created `unknown` contact defaults to `status: 'active'`.

---

## B. `app/src/lib/tables.ts` - the `byTypeStatus` GSI

`lib/tables.ts:88-94`, verbatim:

```ts
      // Composite: all contacts of a type, optionally narrowed by status
      // (e.g. landlords by lead_status value).
      {
        indexName: 'byTypeStatus',
        hashKey: { name: 'type', type: 'S' },
        rangeKey: { name: 'status', type: 'S' },
      },
```

Hash key: `type` (S). Range key: `status` (S). No `sparse: true` flag.

**Sparseness claim - CONFIRMED, with a caveat about how to verify it.** The
`GsiSpec.sparse` flag exists (`:48-52`) but is DOCUMENTATION ONLY - nothing in
`app/src` reads `.sparse`; every hit is a literal `sparse: true` in the specs
themselves. `byTypeStatus` does not carry the flag, so anyone "confirming
sparseness" by looking for the flag will conclude the opposite.

The mechanical rule is stated in-repo at `lib/tables.ts:319-320`, in the
`pool_numbers` GSI comment:

```
319	      // NOT sparse: a DynamoDB GSI indexes an item only when BOTH key attrs are
320	      // present, so quarantine_until is written on EVERY pool_numbers item as a
```

So: a contact missing `status` is NOT in `byTypeStatus` and is invisible to
`listByType` at any `type`. A contact missing `type` is likewise invisible - the
plan's fake models only the missing-RANGE-key case (`c.status !== undefined`), not
the missing-HASH-key case. `ContactItem.type` is required in TS so this cannot
arise from typed code, but `twilioWebhookHarness.ts:1550` shows fixtures that omit
`type` do get written in this repo ("item simply omits type"). One extra
`.filter((c) => c.type !== undefined)` would close it; low priority.

Also relevant: `INDEX_KEY_ATTRIBUTES` (`contactsRepo.ts:407-419`) is DERIVED from
this same table spec and currently equals `{ phone, email, type, status, housingAuthority }`.

---

## C. `app/src/lib/unreadFeed.ts`

### C10. `collectUnreadRows` - FULL signature, `unreadFeed.ts:478-498`

```ts
export async function collectUnreadRows(
  deps: {
    conversations: Pick<ConversationsRepo, 'queryUnreadPage'>;
    contacts: Pick<ContactsRepo, 'findByPhone' | 'findByEmail'>;
    messages: Pick<MessagesRepo, 'listByConversation'>;
    logger?: Logger;
  },
  opts: {
    maxRows: number;
    budget: number;
    startAfter?: UnreadScanPosition;
    excludeContactIds?: ReadonlySet<string>;
    /**
     * WASTED resurfacing probes already spent EARLIER IN THIS REQUEST. The
     * bound is per REQUEST (spec 4.4 amended), and the unread page's fill loop
     * makes many collects, so it threads its running total through here the
     * same way it threads `remainingBudget`.
     */
    wastedProbesBefore?: number;
  },
): Promise<CollectResult> {
```

deps: `conversations` REQUIRED, `contacts` REQUIRED, `messages` REQUIRED,
`logger` OPTIONAL. opts: `maxRows` REQUIRED, `budget` REQUIRED, `startAfter`
OPTIONAL, `excludeContactIds` OPTIONAL (`ReadonlySet<string>`, not an array),
`wastedProbesBefore` OPTIONAL. Exactly as the plan states.

`UnreadScanPosition` (`:256-260`):

```ts
export interface UnreadScanPosition {
  lastActivityAt: string;
  conversationId: string;
}
```

### C11. `UnreadCandidate` and `CollectResult` - `unreadFeed.ts:399-461`

```ts
export type UnreadCandidate =
  | {
      kind: 'contact';
      contactId: string;
      contact: ContactItem;
      /**
       * Every unread thread of this contact met in the walk, in ENCOUNTER
       * (index) order - so `[0]` is the newest one encountered, the row's
       * representative. NOT the contact's full thread set: the page hydrates
       * fresh sums, and the badge needs none.
       */
      unreadConversations: ConversationItem[];
    }
  | { kind: 'unknown'; phone: string; conversation: ConversationItem }
  | { kind: 'relay_group' | 'group_text'; conversation: ConversationItem };
```

**Discriminant field name is `kind`. The contact field name is `contact`, typed
`ContactItem`.** The plan's `candidate.kind !== 'contact'` guard followed by
`candidate.contact.type` is CORRECT and narrows properly (the other two arms have
no `contact` member, so the guard is load-bearing for typecheck too).

Also available on the contact arm: `contactId` (a duplicate of `contact.contactId`)
and `unreadConversations` (`[0]` = newest ENCOUNTERED, which is index order, i.e.
`last_activity_at` DESC).

```ts
export interface CollectResult {
  candidates: UnreadCandidate[];
  /** Position after the last index item CONSUMED (undefined = nothing seen). */
  scanPosition?: UnreadScanPosition;
  /**
   * The item SUPPLY ran out: the scan exhausted AND every yielded item was
   * consumed. A CONSUMPTION fact, deliberately distinct from layer 1's
   * `scanExhausted` - conflating the two made every under-budget dataset
   * report page one with a null cursor.
   */
  consumedAll: boolean;
  /**
   * The candidate list is a FLOOR because the walk STOPPED EARLY: the request's
   * raw-scan budget ran out before the supply did. A drained stream is never
   * truncated, not even when the probe bound left `skippedDeletedThreads` behind
   * it (fix wave 3, adversarial r3 finding 2) - see the derivation below.
   */
  truncated: boolean;
  /** `maxRows` stopped emission (the candidate list is a FLOOR). */
  capped: boolean;
  /** Budget left for the caller's NEXT collect in this same request. */
  remainingBudget: number;
  /**
   * Resurfacing probes ATTEMPTED by THIS collect only (a real message read
   * each). The CALLER accumulates them per request and owns the WARN (see
   * warnDeletedProbes).
   */
  deletedProbes: number;
  /**
   * Of those, the ones that found the thread still HIDDEN - the probes that
   * bought no row. The CALLER accumulates these too and threads the running
   * total into its next collect as `wastedProbesBefore`, which is what makes
   * the bound a REQUEST budget instead of a per-collect one.
   */
  wastedProbes: number;
  /**
   * Deleted-contact threads this collect treated as hidden WITHOUT probing,
   * because the request's wasted-probe bound was already spent. Free to count,
   * and the only thing that says how DEEP the wall is.
   */
  skippedDeletedThreads: number;
}
```

Every field the plan names exists with the stated name. Note `consumedAll` -
present in `CollectResult` but NOT listed in the plan's inventory (plan line
126-127 skips it). It is `!capped && state.scanExhausted`, a stricter thing than
`!truncated`.

### C12. `truncated` / `capped` - the exact lines. CONFIRMED.

`capped` is set at `unreadFeed.ts:670-683`, in the consume loop:

```ts
    await consume(item);
    // Checked AFTER consumption so `state.scanPosition` is exactly the item
    // that filled the cap. Breaking here calls the generator's return(), which
    // is what makes the cap STOP THE SCAN rather than merely slice its output.
    if (candidates.length >= opts.maxRows) {
      capped = true;
      break;
    }
    // NOTHING ELSE STOPS THIS LOOP. The deleted-probe bound deliberately does
    // NOT break here (fix wave 2): stopping the walk turned a wall of hidden
    // deleted threads into a page of zero rows with no cursor, in a world that
    // still had live unread behind it. The bound stops READING; the walk runs
    // to the cap, the supply, or the budget as it always did.
```

`candidates.length` counts EVERY candidate kind - `contact`, `unknown`,
`relay_group`, `group_text` (they are all pushed onto the same `candidates` array
in `consume`, `:596-657`). **Plan claim CONFIRMED: `capped` counts ALL candidate
kinds.**

`truncated` is derived at `unreadFeed.ts:695-710`:

```ts
    consumedAll: !capped && state.scanExhausted,
    // A DRAINED STREAM IS A NATURAL END, EVEN WITH SKIPPED THREADS BEHIND IT
    // (fix wave 3, adversarial r3 finding 2). Fix wave 2 ORed
    // `skippedDeletedThreads > 0` in here, which made a residue-only org that is
    // GENUINELY caught up report a floor forever: zero rows plus `truncated` is
    // the client's inbox-FAILURE state, over a deterministic prefix whose Retry
    // reproduces it. The assumption made past the probe bound is "hidden" - the
    // overwhelmingly likely truth inside a wall of confirmed-hidden threads -
    // and a hidden row is exactly what an empty page means. `truncated` keeps
    // its spec 4.5 step 3 meaning: rows this reader WOULD have shown were
    // withheld, i.e. the scan stopped early. `skippedDeletedThreads` is still
    // returned, and the deleted-probe WARN is what tells the operator the wall
    // is there.
    truncated: !capped && !state.scanExhausted,
    capped,
    remainingBudget: Math.max(0, opts.budget - state.scanned),
```

**Plan claim CONFIRMED byte-exact**: `truncated: !capped && !state.scanExhausted`,
so `capped` MASKS `truncated`. Both are floor signals; a caller reading only
`truncated` is blind to the cap stop.

One extra trap the plan does not state: `state.scanExhausted` is set in TWO places
(`:361` on an empty page with no LEK, `:391` only when the consumer pulled through
a whole page). A consumer that breaks mid-page leaves it FALSE by design
(`:388-390`), which is exactly why `capped` has to mask.

### C13. Constants - names and values

```
 46	export const UNREAD_WALK_LIMIT = 2000;
 49	export const UNREAD_WALK_WARN = 500;
 55	export const BADGE_COUNT_CAP = 100;
 63	export const UNREAD_DELETED_PROBE_WARN = 25;
 93	export const UNREAD_DELETED_PROBE_LIMIT = UNREAD_DELETED_PROBE_WARN + 1;   // = 26
 96	const UNREAD_QUERY_PAGE_SIZE = 100;                                        // NOT exported
 99	const UNREAD_WARN_INTERVAL_MS = 5 * 60_000;                                // NOT exported
```

Docstrings, verbatim:
- `UNREAD_WALK_LIMIT` (`:41-45`): "Raw index items ONE REQUEST may scan (spec 4.3).
  A safety ceiling, not a per-call allowance: a caller that runs several collects
  threads the REMAINING budget through each one so the whole request stays under it."
- `UNREAD_WALK_WARN` (`:48`): "Scanned-items tripwire: past this, the accrual classes need revisiting."
- `BADGE_COUNT_CAP` (`:51-54`): "Row candidates the badge count stops at (spec 4.4).
  A capped count is a FLOOR, which is why the wire carries `capped` alongside the number."

### C14. `warnDeletedProbes` / `warnUnreadScanned` - signatures and the limiter question

```ts
export function warnDeletedProbes(
  logger: Logger | undefined,
  totals: { probes: number; wasted: number; skipped: number },
): void {
  if (totals.wasted + totals.skipped <= UNREAD_DELETED_PROBE_WARN) return;
  warnProbeBurst(
    logger,
    {
      event: 'unread_deleted_probe_tripwire',
      probes: totals.probes,
      wasted: totals.wasted,
      skipped: totals.skipped,
      threshold: UNREAD_DELETED_PROBE_WARN,
    },
    'unread feed: deleted-contact resurfacing probes passed the tripwire - revisit index accrual',
  );
}
```
(`unreadFeed.ts:211-227`)

```ts
export function warnUnreadScanned(logger: Logger | undefined, scanned: number): void {
  if (scanned <= UNREAD_WALK_WARN) return;
  warnWalkScanned(
    logger,
    {
      event: 'unread_walk_scan_tripwire',
      scanned,
      threshold: UNREAD_WALK_WARN,
    },
    'unread feed: raw byUnread scan passed the walk tripwire - revisit index accrual',
  );
}
```
(`unreadFeed.ts:243-254`)

Both take `Logger | undefined` FIRST. Both are NO-OPs below their thresholds:
`warnDeletedProbes` keys on `wasted + skipped > 25` and **never on `probes`** - a
sweep with 50 PRODUCTIVE probes emits NOTHING. `warnUnreadScanned` needs
`scanned > 500`.

**The limiter question, answered definitively.** There are THREE separate
module-scope limiters (`unreadFeed.ts:154-156`):

```ts
const warnWalkScanned = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);
const warnProbeBurst = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);
const warnBadgeZero = moduleRateLimitedWarn(UNREAD_WARN_INTERVAL_MS);
```

- `warnUnreadScanned` -> `warnWalkScanned`.
- The IN-ITERATOR scan warn (`:373`, inside `iterateUnreadConversations`) -> ALSO
  `warnWalkScanned`. Its own docstring at `:239-241` says so: "It is bound to the
  SAME module-scope limiter as the in-iterator warn, never a second instance - so
  when a single request manages to trip both, the limiter swallows the duplicate
  instead of emitting the line twice."
- `warnDeletedProbes` -> `warnProbeBurst`, a DIFFERENT limiter.
- `warnTruncatedZeroCount` (`:176-185`) -> `warnBadgeZero`, a third.

**Answer:** a request that trips the SCAN tripwire twice (in-iterator + caller)
emits **ONE** line. A request that trips the SCAN tripwire and the PROBE tripwire
emits **TWO** lines. The plan's Step-5 comment is about the first pair and is
correct.

**Test trap the plan does not mention.** These limiters are MODULE scope with a
5-minute interval and NO reset seam. Within one vitest file the module is
instantiated once, so the SECOND test that trips the same tripwire is SUPPRESSED -
it only increments `suppressed` (`lib/rateLimitedWarn.ts:122-128`) and schedules an
unref'd trailing flush. Any assertion like `expect(warn).toHaveBeenCalledTimes(1)`
on `warnUnreadScanned`/`warnDeletedProbes` is ORDER-DEPENDENT across tests in the
same file. Also, every emitted line is `{ ...fields, suppressedCount }`
(`rateLimitedWarn.ts:134`), so a `toEqual` on the fields object will fail; use
`toMatchObject`. (The plan's Task 4 collector WARN is a direct `logger.warn`, not
rate-limited, so its `toHaveBeenCalledTimes(1)` pins are safe.)

`moduleRateLimitedWarn` also re-points its shared destination to whichever logger
most recently fired it (`:148-151`), so in a test the last caller's `vi.fn()` wins.

### C15. The resurfacing predicate - `unreadFeed.ts:568-593`

```ts
  const threadResurfaces = async (item: ConversationItem, deletedAt: string): Promise<boolean> => {
    if (wastedProbesBefore + wastedProbes >= UNREAD_DELETED_PROBE_LIMIT) {
      skippedDeletedThreads += 1;
      return false;
    }
    deletedProbes += 1;
    try {
      const page = await deps.messages.listByConversation(item.conversationId, { limit: 1 });
      const latest = page[0];
      const resurfaced =
        latest !== undefined && latest.direction === 'inbound' && latest.created_at > deletedAt;
      // Only a probe that bought NO row spends the bound. One that resurfaces a
      // contact paid for itself and is bounded by `maxRows` like any candidate.
      if (!resurfaced) wastedProbes += 1;
      return resurfaced;
    } catch (err) {
      log.warn(
        { err, conversationId: item.conversationId },
        'unread feed: resurfacing probe failed (best-effort)',
      );
      // A failed read bought no row either, and retrying a failing dependency
      // for every thread in a wall is exactly the cost the bound exists for.
      wastedProbes += 1;
      return false;
    }
  };
```

Reached from `consume` (`:639-656`):

```ts
    const candidate: ContactCandidate = {
      kind: 'contact',
      contactId: contact.contactId,
      contact,
      unreadConversations: [item],
    };
    const deletedAt = isDeleted(contact) ? contact.deleted_at : undefined;
    if (deletedAt === undefined) {
      seenContacts.set(contact.contactId, { candidate, emitted: true });
      candidates.push(candidate);
      return;
    }
    // A deleted contact whose FIRST thread does not qualify is remembered in
    // the hidden state; it emits later if a subsequent thread qualifies, and
    // if none ever does it never emits and never enters the seen-set.
    const emitted = await threadResurfaces(item, deletedAt);
    seenContacts.set(contact.contactId, { candidate, emitted });
    if (emitted) candidates.push(candidate);
```

and, for a SECOND thread of an already-seen still-hidden contact, `:622-637`:

```ts
    const existing = seenContacts.get(contact.contactId);
    if (existing !== undefined) {
      existing.candidate.unreadConversations.push(item);
      // Once EMITTED, later threads merge silently - no second probe.
      if (existing.emitted) return;
      ...
      const deletedAt = existing.candidate.contact.deleted_at;
      if (typeof deletedAt === 'string' && (await threadResurfaces(item, deletedAt))) {
        existing.emitted = true;
        candidates.push(existing.candidate);
      }
      return;
    }
```

**Exactly what a fixture must contain for a deleted contact to resurface** (ALL of
these, in order of evaluation):

1. The CONVERSATION must pass `isUnreadVisible` (`:309-317`): `conversationId` must
   not start with `phone#` / `email#` / `token#`; `unread_count` must be a **number
   `> 0`**; and for the 1:1 bucket `status === 'open'` (a `relay_group` needs
   `open`/`connecting`, a `group_text` needs `GROUP_TEXT_STATUS` - but those are the
   group bucket and never take the contact path).
2. The conversation must be in the 1:1 bucket - `isOneToOneBucket` (`:295-297`),
   i.e. `type !== 'relay_group' && type !== 'group_text'`. A missing `type` counts
   as 1:1 by design.
3. `resolveContact` must return the contact via `findByPhone(participant_phone)`
   or, failing that, `findByEmail(participant_email)`. (The real `findByPhone`
   deliberately ignores `deleted_at`, so a deleted contact IS resolvable.)
4. The contact must be `isDeleted` - a **non-empty string** `deleted_at`.
5. The contact must NOT be in `opts.excludeContactIds`.
6. The wasted-probe bound must not already be spent:
   `wastedProbesBefore + wastedProbes < 26`.
7. The newest message of that conversation - `listByConversation(id, { limit: 1 })[0]` -
   must be `direction === 'inbound'` AND `created_at > deleted_at`, a **STRICT
   string comparison**. Equal timestamps do NOT resurface. `created_at` must be a
   string that sorts correctly against `deleted_at` (ISO 8601 with the same
   precision - a `Z` vs `+00:00` mix would break it).

The plan's Task 3 class-(d) fixture satisfies all seven (`deleted_at`
`2026-06-10T00:00:00.000Z`, message `created_at` `2026-06-12T07:00:00.000Z`,
`direction: 'inbound'`, `unread_count: 1`, conv `status: 'open'`), and the plan's
own "if it fails, check..." note at plan lines 727-729 is accurate.

**Repo calls the probe makes**: exactly ONE
`messagesRepo.listByConversation(conversationId, { limit: 1 })` per probe. The
signature is `listByConversation(conversationId: string, opts?: ListByConversationOptions): Promise<MessageItem[]>`
(`app/src/repos/messagesRepo.ts:1193`) - it returns an ARRAY, never `{ items }`,
confirming the plan's claim. Probes are counted in `deletedProbes` (attempted),
`wastedProbes` (bought no row, including THROWN reads), and
`skippedDeletedThreads` (past the bound, no read).

Per contact, the probe fires at most once per THREAD until one qualifies; after
`emitted` becomes true, later threads of that contact never probe again.

### C16. Contact resolution per visible item - `unreadFeed.ts:534-546` and `:596-616`

```ts
  const resolveContact = async (item: ConversationItem): Promise<ContactItem | undefined> => {
    const phone = item.participant_phone;
    const email = item.participant_email;
    try {
      let contact: ContactItem | undefined;
      if (phone !== undefined) contact = await deps.contacts.findByPhone(phone);
      if (!contact && email !== undefined) contact = await deps.contacts.findByEmail(email);
      return contact;
    } catch (err) {
      log.warn({ err }, 'unread feed: contact lookup failed (best-effort)');
      return undefined;
    }
  };
```

Call site inside `consume` (`:596-616`):

```ts
  const consume = async (item: ConversationItem): Promise<void> => {
    if (!isOneToOneBucket(item)) {
      // Both group kinds are their OWN row, keyed by conversationId - one
      // index item each, so they can never straddle a page boundary.
      candidates.push({
        kind: item.type === 'relay_group' ? 'relay_group' : 'group_text',
        conversation: item,
      });
      return;
    }

    const contact = await resolveContact(item);
    if (contact === undefined) {
      const phone = item.participant_phone;
      // A contactless EMAIL thread has no identity to render: email unknowns
      // live in the unmatched-email surface only, so skip rather than emit a
      // phantom unknown row.
      if (phone === undefined) return;
      candidates.push({ kind: 'unknown', phone, conversation: item });
      return;
    }
```

and the driving loop, `:659-670`:

```ts
  for await (const item of iterateUnreadConversations(
    { conversations: deps.conversations, ...(deps.logger !== undefined && { logger: deps.logger }) },
    { budget: opts.budget, ...(opts.startAfter !== undefined && { startAfter: opts.startAfter }) },
    state,
  )) {
    await consume(item);
```

**Plan claim CONFIRMED with two refinements:**
- It is once per VISIBLE **1:1-bucket** item. Group-bucket items (`relay_group`,
  `group_text`) short-circuit at `:597` and cost NO contact read.
- `findByEmail` runs only when `findByPhone` returned nothing (or no phone) AND
  `participant_email` is defined. So a phone-resolvable item costs exactly one read.
- There is NO memoization, deliberately, and the docstring at `:526-532` says why
  and points at `docs/issues/contacts-batchget-amplified-reads.md`.
- A repeat visible item for an ALREADY-SEEN contact still costs a `findByPhone`
  (the seen-set is checked at `:622`, AFTER `resolveContact`).

---

## D. `app/src/lib/contactThreads.ts` - `conversationsForContact`

Whole function, `contactThreads.ts:31-54`:

```ts
/**
 * All conversations a contact participates in, resolved across BOTH their phone
 * numbers AND their email addresses, deduped by conversationId (phone threads
 * first, then email threads; the first-seen item wins a dedupe). Takes a narrow
 * structural view of the conversations repo so any fake with just the two
 * finders satisfies it.
 */
export async function conversationsForContact(
  contact: ContactItem,
  conversations: Pick<ConversationsRepo, 'findByParticipantPhone' | 'findByParticipantEmail'>,
): Promise<ConversationItem[]> {
  const byId = new Map<string, ConversationItem>();
  for (const p of contactPhones(contact)) {
    for (const c of await conversations.findByParticipantPhone(p.phone)) {
      if (!byId.has(c.conversationId)) byId.set(c.conversationId, c);
    }
  }
  for (const e of contactEmails(contact)) {
    for (const c of await conversations.findByParticipantEmail(e.email)) {
      if (!byId.has(c.conversationId)) byId.set(c.conversationId, c);
    }
  }
  return [...byId.values()];
}
```

- **Signature**: exactly `(contact: ContactItem, conversations: Pick<ConversationsRepo,
  'findByParticipantPhone' | 'findByParticipantEmail'>) => Promise<ConversationItem[]>`.
  Matches the plan's citation byte-for-byte. Second parameter is POSITIONAL and is
  the repo view, not a deps object.
- **Returns**: the RAW union across all of the contact's phones and emails, deduped
  by `conversationId`, phone threads first. Order is Map-insertion order.
- **Filters nothing itself.** No status filter, no type filter, no soft-delete
  filter. The module header (`:11-15`) states it: "It returns the RAW union (deduped
  by conversationId); callers keep their own status/type filters". The caller must
  apply `status === 'open' && type !== 'relay_group'` itself.
- **Throws, never catches.** There is no try/catch anywhere in the file. A repo
  failure propagates to the caller - which is precisely why requirement 4's local
  try/catch works: `[]` from this function unambiguously means "the union was
  empty", and a throw unambiguously means "the query failed".
- Cost: one `findByParticipantPhone` per phone in `contactPhones(contact)` plus one
  `findByParticipantEmail` per email in `contactEmails(contact)`, SEQUENTIALLY.
  `contactPhones` (`contactsRepo.ts:331-337`) returns `phones[]` when non-empty,
  else `[{ phone, primary: true }]` from the scalar, else `[]`; `contactEmails`
  (`:375-381`) is the analog. So a contact with neither costs ZERO repo calls and
  returns `[]` - a third meaning of the empty array the plan should be aware of
  ("this contact has no participant keys at all"), distinct from "filtered to
  nothing" and "threw".
- Module header caveat that matters for the queue: NATIVE GROUP TEXTS ARE NEVER
  RETURNED (`:17-23`) - a `group_text` thread carries neither participant key.

---

## E. `app/src/routes/today.ts` - the precedent, byte-exact

Constants:

```
173	const GROUP_FETCH_LIMIT = 100;
196	const TRIAGE_MAX_PAGES = 10;
```

The whole triage block, `today.ts:840-940` (the fill loop and its reasons,
`:843-895`):

```ts
    // --- contacts: untriaged (unknown / needs_review) → needs_you_now ---------
    // The (type=unknown, status=needs_review) byTypeStatus partition IS the human
    // triage queue — one bounded Query, never a Scan.
    {
      // FILL THE PAGE PAST THE STUBS (fix wave 2, adversarial 6). DynamoDB
      // applies `Limit` at the index BEFORE any filter, and every row in the
      // `unknown#needs_review` partition carries the identical sort key - so
      // intra-partition order is stable and the same 100 rows come back every
      // time. Once enough group-detection stubs sort ahead of the real unknown
      // contacts, filtering them at display rendered an EMPTY block, forever,
      // which reads as "nothing needs triage": a loud problem turned silent.
      // The exclusion is pushed into the Query (saves work, not page slots) AND
      // the read pages until it has a real page or runs out, bounded so a
      // partition made entirely of stubs cannot spin.
      //
      // WHAT THIS COSTS (fix wave 4, item 7): up to TRIAGE_MAX_PAGES (10)
      // SEQUENTIAL Queries of GROUP_FETCH_LIMIT (100) rows each on one Today
      // request - a bounded but real read amplification, paid only while the
      // partition ahead of the real unknowns is thick with excluded rows. It
      // stops the moment a page fills the block.
      const collected: ContactItem[] = [];
      let cursor: Record<string, unknown> | undefined;
      let pagesWalked = 0;
      for (let page = 0; page < TRIAGE_MAX_PAGES; page += 1) {
        pagesWalked = page + 1;
        const read = await contacts.listByType('unknown', {
          status: 'needs_review',
          limit: GROUP_FETCH_LIMIT,
          // Their triage surface is the GROUP THREAD, which is where a human can
          // actually tell who these people are.
          excludeOrigin: GROUP_DETECTION_ORIGIN,
          ...(cursor !== undefined && { exclusiveStartKey: cursor }),
        });
        collected.push(...read.items);
        cursor = read.lastEvaluatedKey;
        if (cursor === undefined || collected.length >= GROUP_FETCH_LIMIT) break;
      }
      // THE PAGE BUDGET RAN OUT WITH ROWS STILL BEHIND IT (fix wave 4, item 7).
      // Every other truncation on this route is announced by `warnIfCapped`, and
      // this one was not: a partition holding more than ~1000 excluded rows
      // ahead of the real unknowns exhausts the walk with a short block, and the
      // block reads as "nothing needs triage" - which is exactly the loud
      // problem turned silent that the fill loop was added to prevent, one layer
      // further out.
      if (cursor !== undefined && collected.length < GROUP_FETCH_LIMIT) {
        log.warn(
          { group: 'contacts:triage', pages: pagesWalked, found: collected.length },
          'today: the untriaged-contacts walk ran out of pages before filling the block - some untriaged contacts are NOT shown',
        );
      }
      // HARD CAP THE RESULT, NOT JUST THE READ. The loop breaks on `>=`, so a
      // last page could take the total to 199 - twice the bound every other
      // group on this route respects, and a block a human is meant to work
      // through.
      const triaged = collected.slice(0, GROUP_FETCH_LIMIT);
      warnIfCapped('contacts:triage', triaged.length, GROUP_FETCH_LIMIT);
```

Element-by-element with CURRENT line numbers:

| element | line(s) | exact text |
| --- | --- | --- |
| `TRIAGE_MAX_PAGES` decl | 196 | `const TRIAGE_MAX_PAGES = 10;` |
| `GROUP_FETCH_LIMIT` decl | 173 | `const GROUP_FETCH_LIMIT = 100;` |
| loop head | 863 | `for (let page = 0; page < TRIAGE_MAX_PAGES; page += 1) {` |
| the Query | 865-872 | `await contacts.listByType('unknown', {...})` |
| `excludeOrigin` use | 870 | `excludeOrigin: GROUP_DETECTION_ORIGIN,` |
| break-on-KEPT | 875 | `if (cursor === undefined \|\| collected.length >= GROUP_FETCH_LIMIT) break;` |
| truncation WARN gate | 884 | `if (cursor !== undefined && collected.length < GROUP_FETCH_LIMIT) {` |
| truncation WARN body | 885-888 | `log.warn({ group: 'contacts:triage', pages: pagesWalked, found: collected.length }, 'today: the untriaged-contacts walk ran out of pages before filling the block - some untriaged contacts are NOT shown');` |
| result `slice` (the hard cap) | 894 | `const triaged = collected.slice(0, GROUP_FETCH_LIMIT);` |
| result cap WARN | 895 | `warnIfCapped('contacts:triage', triaged.length, GROUP_FETCH_LIMIT);` |
| belt-to-braces STATUS re-check | 897 | `if (!UNTRIAGED_CONTACT_STATUSES.has(contact.status ?? '')) continue;` |
| belt-to-braces ORIGIN re-check | 919 | `if (contact.origin === GROUP_DETECTION_ORIGIN) continue;` |

**The comment that says why `excludeOrigin` is safe there** - the one the spec
places "four lines past" the cited range, actually at `today.ts:912-919`:

```
912	        // Their triage surface is the GROUP THREAD, which is where a human can
913	        // actually tell who these people are - and Today already states that
914	        // group conversations are structurally absent from it. This makes the
915	        // contacts they create absent too, rather than only the conversations.
916	        // A stub that a human later triages loses `needs_review` and leaves this
917	        // partition anyway; a real unknown caller who TEXTED still surfaces
918	        // through the conversation-row source above.
919	        if (contact.origin === GROUP_DETECTION_ORIGIN) continue;
```

The load-bearing half is `:917-918`. See **D3** for the locator drift.

Two more facts a copier needs:
- `pagesWalked` is assigned at the TOP of the loop body (`:864`), so it reports
  pages ATTEMPTED, and it is `1` after the first iteration even if that page came
  back empty.
- The WARN gate is `cursor !== undefined && collected.length < GROUP_FETCH_LIMIT` -
  it does NOT fire when the loop stopped because the block filled. The plan's Task 4
  "conservatively truncated on an exact page-multiple" test is a DIFFERENT policy
  (it reports truncated whenever a LEK is in hand at the cap), which is a deliberate
  departure worth stating in the collector's own docstring.

---

## F. `app/src/lib/logger.ts`

The `Logger` type is a RE-EXPORT of pino's, `logger.ts:10` and `:13`:

```ts
import { destination as pinoDestination, pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getContext } from './context.js';

export type { Logger } from 'pino';
```

The default instance, `logger.ts:243-244`:

```ts
/** Default process-wide logger (JSON to stdout). */
export const logger: Logger = createLogger();
```

pino version: `"pino": "^9.14.0"` (`app/package.json:40`).

**Methods** (pino `BaseLogger`, `node_modules/pino/pino.d.ts:136+`): `level`
(a property, `LevelWithSilentOrString`), plus the six `LogFn`s `fatal`, `error`,
`warn`, `info`, `debug`, `trace`, plus `silent`. The full `Logger` adds `child()`,
`bindings()`, `isLevelEnabled()`, `flush()`, `setBindings()`, `levels`, and
EventEmitter members. A structural fake supplying only `{ info, warn, error, debug }`
does NOT satisfy `Logger` - which is why the plan's Task 4 fake carries `as never`.
That cast is required, not decorative.

**Argument order of `warn`** - `LogFn`, `pino.d.ts:345-352`:

```ts
    export interface LogFn {
        // Simple case: When first argument is always a string message, use parsed arguments directly
        <TMsg extends string = string>(msg: TMsg, ...args: ParseLogFnArgs<TMsg>): void;
        // Complex case: When first argument can be any type - if it's a string, no message needed; otherwise require a message
        <T, TMsg extends string = string>(obj: T extends object ? T & LogFnFields : T, msg?: T extends string ? never: TMsg, ...args: ParseLogFnArgs<TMsg> | []): void;
        ...
    }
```

So `warn(obj, msg)` - **fields object FIRST, message SECOND**. The plan's
assertions (`warn.mock.calls[0][0]` is the fields object, `[1]` is the message) are
CORRECT, PROVIDED the collector is written in the repo's house style, which it is
everywhere: `today.ts:885-888`, `unreadFeed.ts:543`, `unreadFeed.ts:584-587`.
Note the string-first overload also exists, so `warn('message')` compiles - a
builder who writes it that way silently breaks `[0][0]`.

`createLogger` (`:177-241`) attaches a `mixin` that injects `correlationId` and, in
hermetic-local only, wraps the destination in a ring buffer (`:239`). Neither
affects the call signature.

---

## G. INVARIANT SWEEP

Protected state: **which contacts land in the `(type='unknown')` byTypeStatus
partition.** An item is in that partition iff it has BOTH a `type` attribute equal
to `'unknown'` AND a `status` attribute (any value). `deleted_at` and `origin` do
not affect MEMBERSHIP - they affect what `listByType`'s FilterExpression returns.

### G1. Every WRITE that sets a contact's `type`

| file:line | note |
| --- | --- |
| `app/src/services/contactCapture.ts:79` | `type: 'unknown'` on the auto-capture stub (inbound SMS/call from an unknown number). Written via `createIfAbsent` at `:111`. **THE primary producer of this partition.** |
| `app/src/services/groupMembers.ts:111` | `type: 'unknown'` on a group-detection member stub; `createIfAbsent` at `:155`. |
| `app/src/services/groupConvert.ts:339` | `type: 'unknown'` on the convert-groups re-mint of a roster member; `createIfAbsent` at `:347`. |
| `app/src/routes/contacts.ts:1049` | `contacts.create(parsed.item)` - manual POST /api/contacts. `type` validated by `parseCreateBody`; can be `'unknown'`. |
| `app/src/routes/contacts.ts:1520` | `contacts.update(contactId, parsed.patch)` - the triage PATCH. `patch['type']` set at `:524`, validated `isContactType`. **The only path that RE-TYPES an existing contact, in or out of `unknown`.** |
| `app/src/routes/public.ts:257-258` | `contacts.create({ type: 'tenant', ... })` - housing-fair public intake. Never `unknown`. |
| `app/src/routes/unmatchedEmail.ts:462-463` | `contacts.create({ type, ... })` from an unmatched inbound email; `type` is a `CreateContactType`. |
| `app/src/lib/import/apply.ts:967` + `:976` | `upsertContact` SETs `#type = :type` unconditionally from `resolved.type`. |
| seeds: `lib/seed/cast.ts:114,170,281,400,677,887,911,1027,1130,1256,1270`; `lean.ts:83,130,162`; `live.ts:140,157,172`; `matrix.ts:448,516,582,802,843`; `performance.ts:543-557` (`buildContact`) | Direct Puts of whole contact documents. `cast.ts:114` is the one seeded `type: 'unknown'`. |

No other writer of `type` exists in `app/src`. `services/extraction/apply.ts` can
never write it: `EXTRACTABLE_FIELDS` (`services/extraction/schema.ts:23-32`) is
`firstName, lastName, voucherSize, housingAuthority, pets, evictions, tenure,
porting` - no `type`, no `status`. And accepting a `type` SUGGESTION is explicitly
refused: `services/suggestionResolution.ts:188`
`if (target === 'type') throw new SuggestionResolutionError(400, 'accept_type_via_triage');`

### G2. Every WRITE that sets a contact's `status`

| file:line | note |
| --- | --- |
| `contactCapture.ts:80` | `status: 'needs_review'` on the auto-capture stub. |
| `groupMembers.ts:112` | `status: 'needs_review'` on the detection stub. |
| `groupConvert.ts:340` | `status: 'needs_review'` on the convert re-mint. |
| `routes/contacts.ts:881-884` | create default: tenant->`onboarding`, landlord->`interested`, **else `active`** (so a created `unknown` is `active` - spec class f, CONFIRMED). |
| `routes/contacts.ts:783-790` | explicit `status` on create, allowlist-checked (`statusAllowlistFor(item.type)`). |
| `routes/contacts.ts:547-562` (`parseTriageBody`) | explicit PATCH `status`; must be a STRING in an allowlist - **null is REJECTED**. |
| `routes/contacts.ts:1414-1424` | PATCH status-without-type is re-validated against the STORED type. |
| `routes/contacts.ts:1441-1445` | AUTO-ADVANCE: a re-type to tenant/landlord/partner without an explicit status sets one. |
| `routes/contacts.ts:1462-1478` | RE-TYPE NORMALIZER, the only reachable arms being `unknown` and `team_member`. **Only rewrites when the stored status is ILLEGAL for the new type** - so re-typing an `active` contact to `unknown` KEEPS `active`. Confirms the spec's "a re-type to unknown does not normalize an existing valid-but-wrong status." |
| `routes/public.ts:259` | `status: 'needs_review'`. |
| `routes/unmatchedEmail.ts:461,467` | computed `status` (tenant->onboarding, landlord->interested, else active). |
| `services/statusTransition.ts:342` | `update(tenantId, { status, status_source: 'derived' })` - tenant lifecycle derivation, guarded by override/no-op checks. |
| `services/statusTransition.ts:597` | `update(contactId, plan.patch)` - the explicit transition route. |
| `repos/suggestionResolutionRepo.ts:691` (`journal.plan.patch`) | phase-fenced replay of a status transition plan built by `buildContactStatusTransitionPlan`; the value is allowlist-checked at `services/suggestionResolution.ts:190`. |
| `lib/import/apply.ts:1023-1028` | `#status = :status` + `status_source`, ONLY when `!preserveStatus` (`:961-964`). |
| seeds (same list as G1) | `performance.ts:547-554` always computes a `status`; `cast.ts`/`lean.ts`/`live.ts`/`matrix.ts` all carry an explicit `status` on every contact (verified: 11/11 in `cast.ts`, 3/3 in `lean.ts`). |

### G3. Every WRITE that sets `origin`

Only two, both `'group_detection'`, both on CREATE:
- `app/src/services/groupMembers.ts:114` - `origin: GROUP_DETECTION_ORIGIN,`
- `app/src/services/groupConvert.ts:342` - `origin: GROUP_DETECTION_ORIGIN,`

(`GROUP_DETECTION_ORIGIN = 'group_detection'`, `services/groupMembers.ts:52`.)

**Nothing ever clears or rewrites `origin`.** Both writes go through
`createIfAbsent`, which never overwrites. This CONFIRMS the spec's class-(a)
argument verbatim: "A group-detection stub keeps its `origin` forever - nothing
rewrites it". The only readers are `today.ts:919`, `today.ts:870`
(`excludeOrigin`), and `lib/import/apply.ts:579` (the retract refusal).

### G4. Every WRITE that sets `deleted_at`

- `app/src/repos/contactsRepo.ts:1121-1135` `softDelete` -
  `UpdateExpression: 'SET #del = :at'`, `ConditionExpression: 'attribute_exists(contactId)'`,
  `ReturnValues: 'ALL_NEW'`. **Touches nothing else** - CONFIRMS the spec's
  "`softDelete` leaves `type` and `status` untouched, so soft-deleted unknowns
  accumulate in that partition permanently."
- `app/src/repos/contactsRepo.ts:1137-1150` `restore` - `UpdateExpression: 'REMOVE #del'`.
- Route call sites: `routes/contacts.ts:1959` (DELETE) and `:2082` (POST /restore).
- Seeds: `lib/seed/performance.ts:576` - `...(index % 7 === 0 && { deleted_at: ... })`,
  i.e. **1 in 7 perf-seed contacts is soft-deleted**. Relevant to
  `performanceSeed.integration.test.ts:414`.
- HARD delete (removes the item from the index entirely):
  `lib/import/apply.ts` `retractImported` (`:560+`), which REFUSES when
  `existing.Item.origin === GROUP_DETECTION_ORIGIN` (`:579`) or when the row was not
  import-created (`:599`) or when the contact is on a live group roster (`:607`).

### G5. VERDICT on the plan's claim "Every current write path sets a status"

**TRUE as of this commit, but the plan's list is INCOMPLETE and its reasoning is
one step short.** The five it names are all real; it MISSES:

1. `app/src/routes/public.ts:257-259` (housing-fair intake create) - sets status.
2. `app/src/routes/unmatchedEmail.ts:461-468` (create from an unmatched email) -
   sets status.
3. `app/src/routes/contacts.ts:1520` - the PATCH, which is the ONLY re-type path and
   the one that can move a contact INTO the `unknown` partition after creation. It
   sets status only conditionally (`:1462-1478`), relying on the stored status
   already being legal for `unknown`, which `NON_TENANT_STATUSES` guarantees for
   `needs_review`/`active` but NOT for a tenant lifecycle value - in which case
   `:1467-1477` normalizes to `'needs_review'`. Either way, a status exists.
4. `app/src/services/statusTransition.ts:342` / `:597` and
   `repos/suggestionResolutionRepo.ts:691` - status-only writers.
5. Every seed writer (`cast.ts`, `lean.ts`, `live.ts`, `matrix.ts`,
   `performance.ts:543-577`) - all set a status on every contact.
6. `lib/import/apply.ts` `upsertContact:1023-1028` - conditional, but the condition
   requires a pre-existing status.

**THE HOLE THE PLAN MISSES ENTIRELY.** `contactsRepo.update` implements a
`null -> REMOVE` convention (`contactsRepo.ts:1152-1180`):

```ts
    async update(contactId, patch) {
      // SET non-null fields; REMOVE explicit-null fields (the null → REMOVE
      // convention lets callers clear an attribute, e.g. role: null removes the
      // role attribute entirely rather than storing ''). Names are
      // expression-aliased so reserved words (`status`, `type`) are legal.
...
        if (value === '' && INDEX_KEY_ATTRIBUTES.has(key)) {
          throw new EmptyIndexKeyError(key);
        }
...
        if (value === null) {
          removes.push(nameKey);
        } else {
```

and the `EmptyIndexKeyError` docstring (`:421-441`) says the quiet part out loud:

```
428	 * unhandled 500. Callers clear an indexed attribute with null (→ REMOVE), which
429	 * also correctly drops the item out of the sparse index. Non-key attributes are
```

So `update(id, { status: null })` is a LEGAL, DOCUMENTED, index-dropping write, and
`status` IS in `INDEX_KEY_ATTRIBUTES` (`:415-419`). The `''` guard throws; the
`null` path does not. **No current caller does it** - `parseTriageBody:547-562`
requires an allowlisted string, the extraction writer only nulls `<field>_source`
keys (none of which are index attributes), and the transition service always writes
a concrete status. So the SHIPPING conclusion stands, but the correct wording is
"no current caller nulls `status`", NOT "the repo makes it impossible". The
difference matters: a future `update(id, { status: null })` would silently evict a
contact from the triage queue with no error and no log, and no test would catch it.

Suggested cheap guard for the build (optional, out of the plan's stated scope): a
unit test asserting `update` refuses `null` for `type`/`status`, or an
`INDEX_KEY_ATTRIBUTES`-based assertion in the collector's suite.

Second, smaller gap: the plan's `.filter((c) => c.status !== undefined)`
sparseness model does not cover a missing HASH key (`type`). See section B.

### G6. Every READER of `listByType('unknown')` in the tree

PRODUCTION (`app/src`):
- `app/src/routes/today.ts:865` - `contacts.listByType('unknown', { status: 'needs_review',
  limit: GROUP_FETCH_LIMIT, excludeOrigin: GROUP_DETECTION_ORIGIN, ... })`.
  **The ONLY production reader of this literal partition.**
- `app/src/routes/contacts.ts:1003` - `contacts.listByType(rawType, opts)`. GENERIC,
  but reachable as `unknown` via `GET /api/contacts?type=unknown&status=&deleted=`
  (`rawType` is validated by `isContactType` at `:958`). Worth knowing: this route
  is a SECOND consumer whose behavior the new collector must not disturb; it also
  applies `statusAllowlistFor(rawType)` to the `status` query param (`:974-979`).

OTHER `listByType` production readers (not `unknown`):
- `app/src/services/audienceResolution.ts:129` - `listByType('tenant', ...)`.

INSTRUMENT (not shipped in the request path):
- `app/scripts/measure-unread-contact-coverage.ts:619, 644, 775, 818` - the four
  audit modes, each `listByType('unknown', { ...(narrow ? { status: 'needs_review' } : {}), ... })`;
  `:818` is the `deleted: true` arm.

TESTS:
- `app/test/performanceSeed.integration.test.ts:282` -
  `expect((await readers.contacts.listByType('unknown', { limit: 20 })).items).toEqual([]);`
  **NOTE for Task 6**: this pin at `:282` expects the perf seed's `unknown` partition
  to be EMPTY, which sits alongside the plan's cited `:414` (`unknown.rows.length > 0`).
  Both must be re-read together before the flip - `:282` reads the CONTACT partition
  and `:414` reads the INBOX rows, and after the flip the second is derived from the
  first. If `:282` is genuinely `[]` and the flip makes the tab contact-sourced,
  `:414` cannot survive. Flagging it as the sharpest concrete risk in Task 6; the
  plan predicts `:414` SURVIVES and cites `performance.ts` seeding
  contact-backed unknowns. Someone must reconcile `:282` against that prediction
  before Task 5 lands. (`buildContact` at `performance.ts:543-577` DOES mint
  `type: 'unknown'` contacts via `contactTypeAndOrdinal:540`, so `:282` may be
  passing only because of the default 20-row limit interacting with the 1-in-7
  soft-delete at `:576`, or because the perf `resolvedContactTypeCounts` differ
  between the seed profile that test uses and the one at `:414`. NOT RESOLVED HERE -
  it needs a run, which this read-only pass did not do.)
- `app/test/audienceResolution.test.ts:53`, `app/test/contactCapture.test.ts:90`,
  `app/test/scheduledSendSuppression.test.ts:239`, `app/test/sendMessage.test.ts:188`,
  `app/test/helpers/twilioWebhookHarness.ts:1684` - fakes.

DASHBOARD: no direct reader; the tab goes through `GET /api/inbox?filter=unknown`.

---

## Appendix: other facts a builder will want

- `messagesRepo.listByConversation(conversationId, opts?)` returns
  `Promise<MessageItem[]>` (`app/src/repos/messagesRepo.ts:1193`) - an ARRAY.
  CONFIRMS the plan.
- `roleFromContact` (`app/src/routes/inbox.ts:395-403`):
  ```ts
  function roleFromContact(
    contact: ContactItem | undefined,
  ): 'tenant' | 'landlord' | 'partner' | 'unknown' {
    if (contact?.type === 'tenant') return 'tenant';
    if (contact?.type === 'landlord') return 'landlord';
    if (contact?.type === 'partner') return 'partner';
    return 'unknown';
  }
  ```
  A FALL-THROUGH, as the spec's class (g) says - `team_member`, `unknown`, and any
  FUTURE `ContactType` all return `'unknown'`.
- `isUnreadVisible` and `isOneToOneBucket` are BOTH exported from `unreadFeed.ts`
  (`:295`, `:309`) if the sweep branch needs them.
- `toExclusiveStartKey(position)` (`unreadFeed.ts:281-287`) is exported and is the
  only supported way to resume a byUnread walk from an arbitrary seen item.
- `lib/rateLimitedWarn.ts` exports `drainRateLimitedWarns()` (`:57`), called from
  the entrypoints' shutdown hooks. Not needed by the collector, but it is why a
  pending trailing flush is not a leak.
