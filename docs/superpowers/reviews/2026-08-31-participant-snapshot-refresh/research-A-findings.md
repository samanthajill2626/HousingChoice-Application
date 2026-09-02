# Research A findings - plan Tasks 2 and 3 vs the live tree

Reader: read-only anchor verification of
`docs/superpowers/plans/2026-09-01-participant-snapshot-refresh.md` Tasks 2 and 3
against `W:\tmp\participant-snapshot-refresh` @ `e6599b4f`.
Byte-exact quotations: `.superpowers/sdd/research-A-reference.md`.

Every line number the plan cites for Tasks 2 and 3 is CORRECT in the live tree, and
every helper it names exists with the signature it assumes. Four deltas follow. None is
blocking; the two that matter are wrong VALUES in the plan's "Verify RED" step, not wrong
anchors.

---

## F1 - HIGH - Task 3 Step 2's expected RED value for the relay test is wrong

Plan line 607 says the red run fails with `'With Ann'` for the relay test. It cannot.
`relayThreadLabel` (`app/src/lib/groupTitle.ts:142`) takes its name rung from
`relayMemberLabels` (`app/src/lib/groupTitle.ts:89`), which pushes the FULL trimmed
participant name. Only `groupThreadLabel` (`app/src/lib/groupTitle.ts:29`) reduces a name
to its first whitespace token. The plan's relay fixture stores `name: 'Ann Tenant'`, so
the current title is `'With Ann Tenant'`.

Delta: the plan's stated red string, and the belief behind it that the two label helpers
share a first-name rung. They deliberately do not - `groupTitle.ts` documents the
asymmetry in `relayMemberLabels`'s docblock.

Not blocking: the GREEN expectation (`'With Annika'`, plan line 595) is still right,
because `'Annika'` is a single token and the full-name and first-name rungs coincide on
it. Only the diagnostic string in Step 2 is wrong. Fix the plan text to
`'With Ann Tenant'` so a builder does not read the mismatch as a broken fixture and go
looking for a first-name rung in `relayThreadLabel` that was never there.

## F2 - MED - Task 3 Step 2's expected RED value for the group test is incomplete

Plan line 607 also names `'With Ann & (404) 555-0112'` as the group test's red value. The
assertion (plan line 572) compares an ARRAY of two titles. `gt-2` is built by
`groupConv({ conversationId: 'gt-2', ... })` with no `participants` override, so it keeps
that helper's DEFAULT roster - `'Ann Tenant'` plus `'Marcus Landlord'`
(`app/test/inboxGroups.test.ts:140-143`, both members NAMED). Its current title is
therefore `'With Ann & Marcus'`, not `'With Ann & (404) 555-0112'`.

Delta: the red run reports
`['With Ann & (404) 555-0112', 'With Ann & Marcus']`, and the same test also fails its
second assertion at `calls.displayBatches` length 0 (nothing populates it before the
change). The plan's parenthetical at line 600 already states the underlying fact
correctly - only the Step 2 diagnostic omits it.

The GREEN expectation `['With Annika & Marc', 'With Annika & Marc']` is correct: both
rows resolve `c-ann` and `c-marcus`, and `groupThreadLabel`'s first-token rule turns the
plan's fake display names into `Annika` and `Marc`.

## F3 - LOW - the harness citation in the Task 2 close-nag fixture points one line short

The comment the plan asks the builder to paste (plan lines 419-420) attributes the
`relay_status` filter to `app/test/helpers/twilioWebhookHarness.ts:777`. Line 777 builds
the `relay_group#<status>` key; the comparison that actually filters is
`app/test/helpers/twilioWebhookHarness.ts:779`, inside `listRelayGroups` which opens at
`:756`. The fixture's `relay_status: 'relay_group#open'` is correct and the fixture will
be surfaced.

Delta: a one-line-off citation in a comment that ships into the test file. Cite `:756`
(the method) or `:777-779` (key plus filter).

## F4 - LOW - `formatPhone` at the Task 2 Step 4 anchor is file-local, not imported

`dashboard/src/routes/today/buildToday.ts:106` is exactly the line the plan replaces, and
the `formatPhone` its replacement calls is defined at
`dashboard/src/routes/today/buildToday.ts:95` in the same file. No import exists or is
needed. Recording it because the anchor list could be read as implying one.

---

## Verified, no delta (for the adjudicator's benefit)

- Task 2 anchors: `nameFromContact` `today.ts:222`; `getContact` memo `:357`; index walk
  `:742` with the deleted-contact check `:743`; the emit loop `:777` with today's
  `who` at `:778`; the close-nag loop `:994` through the `memberNames` map at
  `:1000-1002`; `whoOfConversation` docblock `:1073-1074` and function `:1075-1080`;
  `oneToOneContactId` `:1086`. `whoOfConversation` has exactly ONE call site and is not
  exported, so the plan's signature change reaches nothing else.
- `contacts` (`today.ts:311`), `log` (`:306`), `nowIso` (`:331`), `formatPhoneForDisplay`
  (`:85`), `ContactItem` / `ContactsRepo` (`:66-71`) and `ConversationItem` (`:61-65`) are
  all in scope where the plan's replacement code uses them. The `../lib/` import block is
  `:79-86`.
- `formatPhoneForDisplay('+15550107777')` returns `'(555) 010-7777'`
  (`app/src/lib/phone.ts:73-77`). Plan expectation CONFIRMED, as are
  `'(555) 010-0012'` and `'(404) 555-0112'`.
- `dashboard/src/routes/today/buildToday.ts:106` is the exact current expression.
- `app/test/todayApi.test.ts`: `authedGet` `:40`, `seedTenant` `:44`, `seedConversation`
  `:81`, `iso` `:103`, `getItems` `:128`, `world` `:29`, `TodayResponse` imported at
  `:24`, top-level describe `:27`. `seedConversation` takes a FULL `ConversationItem`;
  every field the plan's two fixtures set is a declared property of that interface
  (`conversationsRepo.ts:112-282`), so the plan's conditional `as ConversationItem` note
  never fires. `RelayCloseNagItem.memberNames` exists (`today.ts:120`).
- `world.contactsRepo` is a plain object literal typed `ContactsRepo`
  (`twilioWebhookHarness.ts:1667`) with no `readonly`, so the PIN tests' reassignment of
  `getById` (`:1688`) type-checks and takes effect at runtime. The fake ALREADY has
  `getDisplaysByIds` (`:1695`) returning the same narrow projection as the real repo, so
  Task 2 needs no harness edit.
- Task 3 anchors: `aggregateInbox` `inbox.ts:709`, `log` `:713`, `contacts` `:715`,
  `relayRowFor` `:1154`, `groupRowFor` `:1190`, call sites `:1237`, `:1418`, `:2293`,
  `:2358`, and the reconcile comment `:1391-1398`. `aggregateInbox` closes at `:2396`, so
  all four sites are inside it - the plan's scope claim at line 670 CONFIRMED. There are
  exactly four call sites; no other module calls either builder.
- `ContactDisplayItem` is NOT currently imported by `inbox.ts` (the plan's check answers
  no); it is exported at `contactsRepo.ts:296`. A block from `'../repos/contactsRepo.js'`
  already exists at `inbox.ts:70-75`, so the cleaner edit is to widen it, but a second
  `import type` line is not a lint error - `eslint.config.mjs` loads no
  `eslint-plugin-import`.
- `relayThreadLabel` takes the whole `ConversationItem` and `groupThreadLabel` takes the
  roster, matching the plan's two rewrite shapes.
- `app/test/inboxGroups.test.ts`: `Calls` `:35`, `makeDeps` `:40` with its initialiser
  `:41`, the `contactsRepo` fake `:102-117` (`findByPhone` / `getById` / `listByType`, no
  `getDisplaysByIds`), `groupConv` `:132` with the default roster `:140-143`, the relay
  literals `:396-406`, `ConversationItem` imported `:19`, `aggregateInbox` imported `:10`.
  `seed.contacts` entries are `{ contactId; phone; name? }` (`:32`), which the plan's
  `firstName: c.name` mapping handles. The fake is behind `as unknown as
  NonNullable<InboxRouterDeps['contactsRepo']>`, so the added method is not contextually
  checked and compiles as written.
- NOTE for the builder, not a defect: `inbox.ts:1237` and `:2358` call `groupRowFor`
  POINT-FREE via `.map(groupRowFor)`. A two-argument `groupRowFor` would silently receive
  the array index as `names`, so the plan's arrow-wrapped rewrites at both sites are
  required for correctness, not style.
- `app/test/inboxFeed.test.ts:196-224` and `app/test/inboxUnreadParity.test.ts:234-245`
  each hold their `contactsRepo` fake behind the same `as unknown as NonNullable<...>`
  cast, so adding `async getDisplaysByIds() { return new Map(); }` to either raises no
  type error.
