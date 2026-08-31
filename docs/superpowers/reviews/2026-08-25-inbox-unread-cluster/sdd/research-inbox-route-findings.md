> **FINDINGS HALF ONLY.** Extracted 2026-08-27 from `research-inbox-route.md`, which was ~90%
> byte-exact quotation of code git already holds at the commits cited below. Only the
> drift/corrections section - what the plan and spec got WRONG - is kept here. The
> reference half was not committed.

# Research: `app/src/routes/inbox.ts` as it exists NOW

Read-only survey taken 2026-08-26 from `W:\tmp\inbox-unread-cluster`, branch
`feat/inbox-unread-cluster`, working tree CLEAN. File is 2003 lines.

Contract checked against:
- `docs/superpowers/specs/2026-08-25-inbox-unknown-tab-walk-design.md`
- `docs/superpowers/plans/2026-08-25-inbox-unknown-tab-contact-side-read.md`
  (facts block + Task 5)

QUOTING CONVENTION (this file is ASCII-only per AGENTS.md): the source contains
a small number of non-ASCII bytes. Where a quoted line carries one, it is
written here as `[EMDASH]` (U+2014) or `[ARROW]` (U+2192). Those markers are
NOT in the source; everything else is byte-exact. Any line you TOUCH must be
ASCII, so treat a marker as "do not retype this character".

---
## DRIFT / CORRECTIONS (read these first)

### D1. The plan's Step 6 names FOUR stale-comment sites. There are EIGHT.

Step 6 lists: the read-accounting block (~599-623), `passesFilter`'s unknown
arm (~710-711), `rowForConversation`'s header + unknown arms (~836-838, ~901),
and the relay-merge / group-gate comments (~1571-1576, ~1599-1601). All four
are real and correctly located. The flip ALSO invalidates these, none of which
the plan mentions:

- **`inbox.ts:341-342`** - inside `decodeUnreadCursor`:
  ```
      // A cursor minted under `all`/`unknown` (a bare LastEvaluatedKey) or under
      // `groups` (the repo's `{t,k}`) carries no `u:1` and lands here.
  ```
  After Step 4 the unknown feed MINTS no cursor at all, so "a cursor minted
  under `all`/`unknown`" is false. This comment is the file's own record of the
  cursor namespacing; leaving it says the opposite of the new 400 posture.

- **`inbox.ts:804-807`** - inside `buildContactRow`:
  ```
      // A type='unknown' contact IS an untriaged inbound (it just already has a
      // record) - so it needs triage and belongs under the "unknown" filter, exactly
      // like a no-contact record. Keying triage off the ROLE (not "no contact
      // record") is what makes both cases surface.
  ```
  (Verified byte-exact; all four lines are ASCII.)
  "exactly like a no-contact number" is precisely the class (e) claim the flip
  RETIRES: a contactless number no longer surfaces on the tab. Worth an
  amendment, or the next reader re-derives class (e) as still covered.

- **`inbox.ts:930-931`**:
  ```
      // Deleted fast-path: nothing unread -> hidden, no message read needed. NOT
      // dead - it still runs for `all` and `unknown`.
  ```
  After the flip it runs for `all` ONLY.

- **`inbox.ts:1611-1617`** - the `filteredGroup` keep-comment:
  ```
      // `filteredGroup` is DEAD TODAY and kept deliberately: only `filter=all`
      // reaches this block (`groups` and `unread` returned earlier, `unknown` is
      // gated out above) and `passesFilter` is unconditionally true for `all`, so
      // the counter can never fire. It exists so a future filter that DOES reach
      // here cannot silently drop every group row - the shape `filteredRelay`
      // catches on `unknown` today. Read its absence as "no information", not as
      // "nothing was dropped".
  ```
  Two stale claims: `unknown` is no longer "gated out above" (it returns much
  earlier), and `filteredRelay` no longer "catches on `unknown` today" - which
  is the same fact Step 6 item 4 already asks you to fix at :1571.

### D2. "`groups` returns at 1034, `unread` at 1064" cites the BRANCH OPENINGS, not the returns.

- `1034` is `  if (filter === 'groups') {`. Its `return {` is at **1046**, closing
  `}` at **1053**.
- `1064` is `  if (filter === 'unread') {`. Its `return {` is at **1449**,
  closing `}` at **1454**.

Task 5 Step 5's own instruction ("insert after the closing `}` at ~1454") is
correct; the facts block's numbers are just not what the prose says they are.
Anchor the insertion on the CLOSING BRACE, not on 1064.

### D3. `app/test/inboxGroups.test.ts` - the `filter=unknown` test is NOT at 357.

The plan says line 357 twice (Task 2 Step 4 and Task 5's preamble). Actual:
`const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);` is
at **`inboxGroups.test.ts:367`**. Its `contactsRepo` fake block IS at 101-109 as
claimed.

### D4. Everything else in the facts block VERIFIED byte-exact.

Confirmed unchanged at the cited lines: cursor gate 576-579; `buildContactRow`
742-828; `contactConversations` 634-658; `roleFromContact` 396-403;
`InboxPage.truncated` 147-152; `messages.listByConversation` array read 690;
`satisfies Record<Union,true>` 439-448; `unreadFeed.js` import block 86-96;
pager start 1474; `moreChunks` bound 1481 / read 1522; `moreChunks` has exactly
one reader; unread discriminator base read 1148-1161; `warnUnreadScanned`
convention 1351; unread `scanned` field 1434; `collectUnreadRows`
`unreadFeed.ts:478`; flag semantics `unreadFeed.ts:695-709` with the cap set at
`:674-677`; `UNREAD_WALK_LIMIT = 2000` (`unreadFeed.ts:46`);
`contactsRepo.listByType` `:522` with `ListContactsOpts` `:472-490`;
`ContactType` `contactsRepo.ts:51`; `isDeleted` `contactsRepo.ts:306-308`;
`byTypeStatus` `lib/tables.ts:90-93`; harness `listByType` fake at
`twilioWebhookHarness.ts:1684` with the items-remaining LEK defect at `:1707`
and the deleted-before-Limit filter at `:1691` (both as described);
`unreadIndexFake.ts` LEK doc at ~104-118; dashboard
`serverEndedEarlyEmpty` at `Inbox.tsx:42`, banner `:183`, per-filter empty state
`:199`; `inboxFilters.ts:27` = `No unknown numbers`; `inboxApi.test.ts:199-218`;
`inbox.integration.test.ts:323-330`; `performanceSeed.integration.test.ts:414`.

---

