# D1 - S1 Tasks 1.1-1.6: decisions record

Dispatch D1 of the feat/last-heard-from build (implementer, 2026-10-13). Scope:
the contact attribute, its one writer, the one attribution rule and the four SMS
inbound paths. Plan: `docs/superpowers/plans/2026-10-12-last-heard-from.md`
(S1 Tasks 1.1-1.6). Binding corrections applied: IB2 (Task 1.3), IB7.

## Commits

- 421a713d Task 1.1 - `touchLastHeardFrom`, `last_heard_from_at`, `normalizeInstant`,
  every typed ContactsRepo fake, harness `heardFromTouches`.
- a3498b23 Task 1.2 - `attributeInbound` + `repoLookup`.
- b2da0298 Task 1.3 - path 1 (1:1 SMS/MMS) + the IB2 knowing rewrite.
- 0f5e06d2 Task 1.4 - path 2 (relay group, open).
- 51be9552 Task 1.5 - path 3 (closed relay group late text).
- 46c16995 Task 1.6 - path 4 (native group text).

Every task went RED for the stated reason (module missing / "not a function" /
`world.heardFromTouches` empty) before GREEN; `npm run typecheck` exited 0 after
every commit. A regression sweep of every app suite that posts to the SMS webhook
plus the relay, inbox and status neighbours (21 files) passed before the 1.6
commit.

## Shipped contracts (as committed)

- `ContactItem.last_heard_from_at?` - app/src/repos/contactsRepo.ts:229.
- `ContactsRepo.touchLastHeardFrom` - interface app/src/repos/contactsRepo.ts:926
  (last member), implementation :1927. Carries `attribute_exists(contactId)`;
  `phoneref#` / `emailref#` ids and unparseable instants answer 'skipped' without
  a write; never throws; the caller logs 'failed'. The UpdateExpression text is
  `SET #lhf = :at` (IB3 in D2 matches on it).
- app/src/lib/heardFrom.ts:14 `normalizeInstant`, :22 `HeardFromLookup`, :28
  `HeardFromRow`, :40 `HeardFromThread`, :54 `attributeInbound`, :111
  `repoLookup`; type-only repo imports, so no runtime cycle with contactsRepo.
- app/test/helpers/twilioWebhookHarness.ts:521 `FakeWorld.heardFromTouches`
  (raw `at`), fake writer :2609.
- Caller log line on all four paths: exactly
  `last_heard_from touch failed - message persisted, last_heard_from stale`.
- Touch sites: app/src/routes/webhooks/twilio.ts:943 (relay open), :1371 (closed
  late text), :2170 (native group; persisted row hoisted at :2106/:2126), :2670
  (1:1; persisted row hoisted at :2590/:2614). All run on the fresh AND the
  deduped branch at the persisted key's instant; the echo direction check (the
  persisted row decides) exists only on the 1:1 and native-group paths, per plan
  section 11.

## Decisions and divergences (all keep the contract)

1. IB2 applied in the Task 1.3 commit: app/test/groupTextWebhook.test.ts:155
   gains `contacts.touchLastHeardFrom` after `contacts.touchPhoneLastSeen`, with
   a comment that the touch is 1:1-path work and adds no read (the touch reuses
   the conversation and the captured contact as the lookup cache).
2. IB7: the rule-1 comment in app/src/lib/heardFrom.ts names "the retry append
   in webhooks/twilio.ts" instead of the plan's line number, which rots.
3. app/test/contactsRepoHeardFrom.test.ts builds its logger at level debug (the
   plan named none); its warn/error assertions use exact levels, so nothing
   changes except that the debug line runs.
4. Additive test assertions beyond the plan (no plan assertion dropped): the
   1.1 integration case re-reads the stored value after each step; 1.3 asserts
   the stub exists and that the value is still absent after the failed first
   touch; 1.6 asserts one message row on redelivery.
5. 1.6 cases 2-4 push no contact first (the plan is silent); the group branch
   mints the sender stub, which is the touch target.
6. 1.5 case 2 (a phone on no contact touches nobody) was already green on
   unchanged code - a PIN in effect; cases 1 and 3 carry the RED.

## Open notes

- Harness parity gap kept as planned: the fake writer does not short-circuit
  pointer ids (they never exist in `world.contacts`, so it answers 'skipped' but
  records the call). No current test depends on it.
- `app/src/lib/sendOutcome.ts` untouched.
- Next dispatch (D2, Tasks 1.7-1.14): voice.ts, inboundEmail.ts and dev.ts need
  their own `heardFrom` / `splitTsMsgId` imports; IB1, IB3, IB4, IB5 apply there.
