# Relay Open-Path STOP/HELP Processing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A relay-group member (or any sender) who texts STOP / HELP / an
opt-in keyword to a pool number on the OPEN path gets the keyword processed
exactly like the 1:1 and closed-group paths: flags set/cleared, filed reply
on the TwiML, and the bare keyword never relayed to the other members.

**Architecture:** One pure classifier in lib/smsCompliance.ts becomes the
single source of keyword detection for all three inbound paths.
handleRelayInbound gains a keyword branch that (a) skips the fan-out
enqueue and (b) runs the SHARED processInboundKeywords against the
sender's own 1:1 conversation (closed-intercept idiom). The per-leg gate
isMemberSuppressed widens to also honor the member phone's 1:1
conversation sms_opt_out flag (BE1 per-phone scope) so the opt-out
suppresses legs even when the contact flag is out of reach (secondary
attached number).

**Tech Stack:** Express + DynamoDB (lib-dynamodb) + vitest/supertest
(app), Playwright (e2e). No dashboard changes.

## Global Constraints

- Spec: docs/superpowers/specs/2026-07-17-relay-open-path-stop-design.md -
  APPROVED (including the 3.3 conversation-flag mechanism); deviations
  stop-and-report.
- ASCII only in every added line (`tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0).
- Phone numbers are PII: log member keys / conversation ids / SIDs, never
  a number.
- NO new catalog copy (keyword.stop / keyword.help / welcome.sms already
  exist); the do-not-remove consent gates in lib/smsCompliance.ts are
  byte-untouched (only ADD the classifier).
- Behavior of the 1:1 path and the closed path must be BYTE-IDENTICAL
  after the classifier refactor - their existing tests are the proof and
  may not be weakened.
- Gates after each task: `npm run typecheck` + `npm test --workspace app`,
  bare, from /w/tmp/relay-open-path-stop. e2e deferred to Task 4.
- Commit per task, explicit paths, gating `git status` read first,
  Co-Authored-By trailer naming the authoring model.

## Suppression-state mutation surfaces (invariant rule - verified sweep)

The protected invariant: "an opted-out phone is never sent a relay leg".
Every mutator of the two suppression stores, for reviewer orientation:

- Conversation flag (`conversations.setSmsOptOut`): ONE writer -
  processInboundKeywords (twilio.ts) - now reached from all three inbound
  paths. No other caller exists (verified by grep 2026-07-17).
- Contact flag (`sms_opt_out` via contacts.setFlag/clearFlag): (a)
  processInboundKeywords (primary-number scope), (b) the staff manual
  toggle in routes/contacts.ts (~1428), (c) the DLR 21610 auto-flag in
  twilio.ts (~1244). All three are honored by the leg gate's existing
  contact check - unchanged.
- Watch item: a staff manual UNMUTE (contacts.ts clearFlag) does NOT
  clear a 1:1 conversation flag the person set by texting STOP - legs
  stay suppressed until the person texts START. That is the A2P-correct
  precedence (the person's own opt-out outranks staff), pre-existing on
  the 1:1 path; do not "fix" it.
- `relay_opted_out_members` is a display/attention ANNOTATION only -
  suppression truth NEVER reads it (spec 3.4).

## File structure (decomposition)

- `app/src/lib/smsCompliance.ts` - ADD `InboundKeywordKind` +
  `classifyInboundKeyword` (pure; below the keyword sets).
- `app/src/routes/webhooks/twilio.ts` - processInboundKeywords uses the
  classifier (identical behavior); handleRelayInbound returns
  `string | undefined`, gains the keyword branch; two open-path router
  call sites send messageTwiml(reply).
- `app/src/services/relayAnnouncements.ts` - isMemberSuppressed gains the
  conversations repo + the 1:1-flag check; its announcement call site
  updates.
- `app/src/jobs/relayFanOut.ts` - the skip call site updates.
- Tests: `app/test/smsCompliance.test.ts`, `app/test/relayWebhook.test.ts`,
  `app/test/relayAnnouncements.test.ts`, `app/test/relayFanOut.test.ts`.
- E2E: `e2e/tests/dashboard-next/relay-open-stop.spec.ts` (new; reuses the
  relay-number-lifecycle spec's group-building steps).

---

### Task 1: classifyInboundKeyword - one source of keyword truth

**Files:**
- Modify: `app/src/lib/smsCompliance.ts` (ADD only, after OPT_IN_KEYWORDS)
- Modify: `app/src/routes/webhooks/twilio.ts` (processInboundKeywords
  detection lines only)
- Test: `app/test/smsCompliance.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2-3):

```ts
export type InboundKeywordKind = 'help' | 'opt_out' | 'opt_in';
export function classifyInboundKeyword(
  body: string | undefined,
  optOutType: string | undefined,
): InboundKeywordKind | undefined;
```

- [ ] **Step 1: Write the failing tests** (append a describe to
  app/test/smsCompliance.test.ts):

```ts
import { classifyInboundKeyword } from '../src/lib/smsCompliance.js';

describe('classifyInboundKeyword', () => {
  it('classifies every filed opt-out keyword, case/whitespace-insensitive', () => {
    for (const k of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']) {
      expect(classifyInboundKeyword(k, undefined)).toBe('opt_out');
    }
  });
  it('classifies every filed opt-in keyword', () => {
    for (const k of ['START', 'join', 'HOME', 'yes', 'UNSTOP']) {
      expect(classifyInboundKeyword(k, undefined)).toBe('opt_in');
    }
  });
  it('classifies HELP, and HELP wins over a conflicting OptOutType', () => {
    expect(classifyInboundKeyword('HELP', undefined)).toBe('help');
    expect(classifyInboundKeyword('help', 'STOP')).toBe('help');
    expect(classifyInboundKeyword('whatever', 'HELP')).toBe('help');
  });
  it('honors OptOutType STOP/START regardless of body', () => {
    expect(classifyInboundKeyword('I want out', 'STOP')).toBe('opt_out');
    expect(classifyInboundKeyword('add me back', 'START')).toBe('opt_in');
  });
  it('a message CONTAINING a keyword is not a keyword', () => {
    expect(classifyInboundKeyword('please stop by at 3', undefined)).toBeUndefined();
    expect(classifyInboundKeyword('can you help me', undefined)).toBeUndefined();
  });
  it('undefined/empty body with no OptOutType is not a keyword', () => {
    expect(classifyInboundKeyword(undefined, undefined)).toBeUndefined();
    expect(classifyInboundKeyword('', undefined)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**
  `npm test --workspace app -- smsCompliance` -> FAIL (no export).

- [ ] **Step 3: Implement** in app/src/lib/smsCompliance.ts, directly
  after OPT_IN_KEYWORDS:

```ts
// --- Inbound keyword classification ----------------------------------------

/** What an inbound body/OptOutType pair IS, for the three inbound paths. */
export type InboundKeywordKind = 'help' | 'opt_out' | 'opt_in';

/**
 * do-not-fork - the ONE keyword detector for every inbound path (1:1,
 * closed-group intercept, open relay). Precedence mirrors the webhook's
 * historical logic exactly: HELP first (OptOutType or bare keyword), then
 * opt-out, then opt-in. A message that merely CONTAINS a keyword is NOT a
 * keyword (exact match on the trimmed uppercased body).
 */
export function classifyInboundKeyword(
  body: string | undefined,
  optOutType: string | undefined,
): InboundKeywordKind | undefined {
  const keyword = (body ?? '').trim().toUpperCase();
  if (optOutType === 'HELP' || keyword === 'HELP') return 'help';
  if (optOutType === 'STOP' || OPT_OUT_KEYWORDS.has(keyword)) return 'opt_out';
  if (optOutType === 'START' || OPT_IN_KEYWORDS.has(keyword)) return 'opt_in';
  return undefined;
}
```

- [ ] **Step 4: Refactor processInboundKeywords** (twilio.ts ~466-471) to
  the classifier - identical behavior:

```ts
      const kind = classifyInboundKeyword(Body, OptOutType);
      const isHelp = kind === 'help';
      const optedOut = kind === 'opt_out';
      const optedIn = kind === 'opt_in';
```

  (Remove the now-unused local `keyword` computation; import
  `classifyInboundKeyword` from '../../lib/smsCompliance.js' alongside the
  existing keyword-set imports - the sets stay imported only if still used
  elsewhere in the file; if not, drop them from the import.)

- [ ] **Step 5: Run the full app suite to prove byte-identical behavior**
  `npm run typecheck` then `npm test --workspace app` -> all green,
  including every existing twilioSmsWebhook + relayWebhook keyword test
  untouched.

- [ ] **Step 6: Commit**
  `git status` (gating read), then explicit-path commit:
  "feat(compliance): classifyInboundKeyword - one keyword detector for all inbound paths".

---

### Task 2: isMemberSuppressed honors the per-phone 1:1 flag

**Files:**
- Modify: `app/src/services/relayAnnouncements.ts` (isMemberSuppressed +
  its internal call site)
- Modify: `app/src/jobs/relayFanOut.ts` (call site)
- Test: `app/test/relayAnnouncements.test.ts`, `app/test/relayFanOut.test.ts`

**Interfaces:**
- Produces (consumed by Task 3's fan-out expectations and every leg send):

```ts
export async function isMemberSuppressed(
  contacts: ContactsRepo,
  conversations: ConversationsRepo,
  member: ConversationParticipant,
): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests.** In relayAnnouncements.test.ts
  (follow the file's existing fake-repo arrange idiom) add a describe:

```ts
describe('isMemberSuppressed - per-phone 1:1 flag (BE1 scope)', () => {
  it('suppresses on the contact flag alone (existing behavior)', async () => { /* contact sms_opt_out=true, findByParticipantPhone returns [] */ });
  it('suppresses on the 1:1 conversation flag alone', async () => {
    // contact without sms_opt_out; conversations.findByParticipantPhone
    // resolves [{ type: 'tenant', sms_opt_out: true, ... }] -> true
  });
  it('ignores relay_group rows returned by the phone query', async () => {
    // findByParticipantPhone -> [{ type: 'relay_group', sms_opt_out: true }] -> false
  });
  it('not suppressed when neither store is flagged', async () => { /* -> false */ });
  it('never creates a conversation (read-only lookup)', async () => {
    // assert the fake's createOrGetByParticipantPhone was NOT called
  });
});
```

- [ ] **Step 2: Run to verify failure**
  `npm test --workspace app -- relayAnnouncements` -> FAIL (arity/behavior).

- [ ] **Step 3: Implement** in relayAnnouncements.ts:

```ts
export async function isMemberSuppressed(
  contacts: ContactsRepo,
  conversations: ConversationsRepo,
  member: ConversationParticipant,
): Promise<boolean> {
  const contact =
    typeof member.contactId === 'string' && member.contactId.length > 0
      ? await contacts.getById(member.contactId)
      : await contacts.findByPhone(member.phone);
  if (contact?.sms_opt_out === true) return true;
  // BE1 per-phone scope: a STOP texted from this phone (to the pool number
  // via the open-path handler, or to the main number) flags the phone's OWN
  // 1:1 conversation - the correct suppression record when the contact flag
  // is out of reach (roster phone became a secondary attached number).
  // Read-only GSI query - a leg check must never mint a conversation.
  const threads = await conversations.findByParticipantPhone(member.phone);
  return threads.some((c) => c.type !== 'relay_group' && c.sms_opt_out === true);
}
```

  Update the two call sites:
  - relayAnnouncements.ts (~206): `await isMemberSuppressed(deps.contactsRepo, deps.conversationsRepo, member)`
  - relayFanOut.ts (~433): `await isMemberSuppressed(contacts, conversations, member)`
  Add the `ConversationsRepo` type import in relayAnnouncements.ts if not
  already present (it is - the deps interface uses it).

- [ ] **Step 4: Extend the fan-out skip test** in relayFanOut.test.ts: a
  recipient whose contact has NO flag but whose phone resolves to a 1:1
  with `sms_opt_out: true` is skipped, slot marked
  `failed/contact_opted_out`, `setRelayMemberOptedOut` called - mirror the
  file's existing opted-out-skip test, changing only the arrange.

- [ ] **Step 5: Run** `npm run typecheck` + `npm test --workspace app` ->
  green (any other test file constructing isMemberSuppressed callers'
  fakes may need the findByParticipantPhone stub added - default it to
  `[]` so existing behavior is unchanged).

- [ ] **Step 6: Commit** (explicit paths):
  "feat(relay): leg suppression honors the member phone's 1:1 opt-out flag (BE1 per-phone scope)".

---

### Task 3: open-path keyword handling in handleRelayInbound

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts` (handleRelayInbound + the
  two open-path router call sites)
- Test: `app/test/relayWebhook.test.ts`

**Interfaces:**
- Consumes: `classifyInboundKeyword` (Task 1), the existing
  `processInboundKeywords`, `messageTwiml`, `conversationTypeFor`,
  `relayMemberKey`, `conversations.setRelayMemberOptedOut` /
  `clearRelayMemberOptedOut` / `createOrGetByParticipantPhone`,
  `contacts.findByPhone`.
- Produces: `handleRelayInbound(...): Promise<string | undefined>` (the
  keyword reply riding the TwiML).

- [ ] **Step 1: Write the failing tests** in relayWebhook.test.ts (follow
  the file's existing open-path arrange idiom - a pool number fronting an
  open group with rostered members). Cases:

```ts
describe('open-path keyword handling', () => {
  it('STOP from a roster member: persisted on the relay thread, NO fan-out enqueue, 1:1 conversation flagged, contact flagged (primary), annotation set, STOP confirmation TwiML', async () => {
    // POST /webhooks/twilio/sms { To: POOL, From: MEMBER_PRIMARY, Body: 'STOP' }
    // - response body contains the filed STOP confirmation copy
    // - enqueueImmediate (relay fan-out) NOT called
    // - messages on the relay thread include the inbound 'STOP'
    // - conversations.setSmsOptOut called with the member's 1:1 id, true
    // - contacts.setFlag(memberContactId, 'sms_opt_out') called
    // - conversations.setRelayMemberOptedOut(groupId, memberKey, ...) called
  });
  it('STOP from a roster member whose phone is NOT the contact primary: 1:1 flagged, contact flag NOT set (BE1 corner)', async () => {});
  it('HELP from a member: filed HELP reply TwiML, no flags, no fan-out', async () => {});
  it('START from a previously opted-out member: flags cleared, clearRelayMemberOptedOut called, welcome TwiML', async () => {});
  it('a body merely CONTAINING a keyword fans out normally with empty TwiML and no flags', async () => {
    // Body: 'please stop by at 3' -> enqueueImmediate called, no setSmsOptOut
  });
  it('unknown-sender STOP on the open fallback: 1:1 + contact flagged, NO annotation, confirmation TwiML, no fan-out', async () => {});
  it('redelivered STOP (same MessageSid): still no fan-out enqueue, idempotent flag re-writes, confirmation TwiML again', async () => {});
});
```

- [ ] **Step 2: Run to verify failure**
  `npm test --workspace app -- relayWebhook` -> FAIL.

- [ ] **Step 3: Implement.** In handleRelayInbound:

  (a) Signature: `async function handleRelayInbound(relay, msg): Promise<string | undefined>`.

  (b) After the existing append + mirror block, classify once:

```ts
    const kind = classifyInboundKeyword(Body, msg.params['OptOutType']);
```

  (c) Fan-out decision chain - insert the keyword branch so a bare
  keyword NEVER enqueues (order: closed guard, non-member guard, keyword
  guard, fresh-append enqueue):

```ts
    if (isClosed) {
      /* existing log line, unchanged */
    } else if (!sender) {
      /* existing log line, unchanged */
    } else if (kind !== undefined) {
      // A bare keyword is a command to the SYSTEM, not group content (spec
      // sec 2 decision 2): persisted above for the audit trail, processed
      // below, NEVER relayed to the other members.
      log.info({ providerSid: MessageSid, kind }, 'relay inbound keyword - processed, not fanned out');
    } else if (!appended.deduped) {
      /* existing enqueueImmediate block unchanged */
    }
```

  (d) After the inbox-touch/SSE block (which stays - staff see the STOP
  bubble in the group transcript), the keyword processing block:

```ts
    // Keyword processing (spec 3.2): the SHARED seam runs against the
    // sender's OWN 1:1 (closed-intercept idiom) - the conversation flag
    // must land on their per-phone thread, NEVER on the group. The message
    // itself stays on the relay thread (persisted above).
    let keywordReply: string | undefined;
    if (kind !== undefined) {
      const effectiveContact = senderContact ?? (await contacts.findByPhone(From));
      const oneToOne = await conversations.createOrGetByParticipantPhone(
        From,
        conversationTypeFor(effectiveContact),
      );
      keywordReply = await processInboundKeywords({
        conversation: oneToOne,
        effectiveContact,
        From,
        Body,
        OptOutType: msg.params['OptOutType'],
        MessageSid,
      });
      // Immediate staff visibility (spec 3.4): annotation only, for a
      // current roster member; suppression truth lives in the flags.
      if (sender) {
        try {
          if (kind === 'opt_out') {
            await conversations.setRelayMemberOptedOut(relay.conversationId, senderKey, {
              ...(sender.contactId !== undefined &&
                sender.contactId.length > 0 && { contactId: sender.contactId }),
              phone: sender.phone,
              ...(sender.name !== undefined && { name: sender.name }),
              at: new Date().toISOString(),
            });
          } else if (kind === 'opt_in') {
            await conversations.clearRelayMemberOptedOut(relay.conversationId, senderKey);
          }
        } catch (err) {
          log.error(
            { err, providerSid: MessageSid, memberKey: senderKey },
            'relay keyword annotation failed - flags recorded, attention item stale until next fan-out',
          );
        }
      }
    }
```

  NOTE: `senderContact` is the existing roster-contact lookup
  (`sender?.contactId ? await contacts.getById(...) : undefined`); the
  `?? findByPhone(From)` fallback covers member-without-contactId and the
  unknown-sender open-fallback route. processInboundKeywords itself is
  UNTOUCHED (Task 1's refactor aside) and guards its own repo failures.

  (e) Return `keywordReply` (undefined on the non-keyword path); update
  the final log line to include `keyword: kind !== undefined`.

  (f) Router call sites - open-roster match (~749) and unknown-sender open
  fallback (~785) become:

```ts
        const relayReply = await handleRelayInbound(openMatch, { MessageSid, From, To, Body, params });
        res.type('text/xml').send(relayReply !== undefined ? messageTwiml(relayReply) : EMPTY_TWIML);
        return;
```

  (same shape for `openFallback`).

- [ ] **Step 4: Run** `npm test --workspace app -- relayWebhook`, then the
  full `npm run typecheck` + `npm test --workspace app` -> green.

- [ ] **Step 5: Commit** (explicit paths):
  "feat(relay): process STOP/HELP/opt-in on the open relay path (A2P parity)".

---

### Task 4: e2e - STOP/START round-trip on a live open group

**Files:**
- Create: `e2e/tests/dashboard-next/relay-open-stop.spec.ts`
- Reference: `e2e/tests/dashboard-next/relay-number-lifecycle.spec.ts`
  (group-building + pool-number + outbox idioms; reuse its steps/helpers
  verbatim - do NOT invent new plumbing), `e2e/support/selectors.md`.

- [ ] **Step 1: Write the spec.** Flow (one serial spec; assert via
  `GET /__dev/outbox` like the lifecycle spec does):
  1. Reseed; build ONE open relay group with 3 members (tenant + landlord
     + navigator or whatever trio the lifecycle spec builds) on a pool
     number.
  2. Member A texts 'STOP' to the pool number (the same inbound-injection
     seam the lifecycle spec uses for member texts).
     Assert: outbox gained EXACTLY ONE new message - the filed STOP
     confirmation, from the pool number, to member A. Members B/C received
     NOTHING (no relayed 'STOP').
  3. Staff (or member B) sends a group message.
     Assert: member C (and staff-path recipients) receive the relayed
     message; member A receives NOTHING.
  4. Member A texts 'START' to the pool number.
     Assert: welcome reply to A from the pool number.
  5. Member B sends another group message.
     Assert: member A receives it again.

- [ ] **Step 2: Run it** from the worktree:
  `npm run e2e` (full suite - the harness boots hermetically). Expected:
  new spec green, no regressions. Honor the two filed flakes (re-run the
  full suite before blaming the change; report both runs).

- [ ] **Step 3: Commit** (explicit paths):
  "test(e2e): relay open-path STOP/START round-trip".

---

### Task 5: full gates + sweeps on the final tree

- [ ] `npm run typecheck` -> 0.
- [ ] `npm test` (all workspaces) -> green.
- [ ] `timeout 1500 npm run e2e` -> green (full suite, from the worktree).
- [ ] ASCII sweep of every added line (`git diff main --unified=0 | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0 modulo pre-existing non-ASCII context; the spec/plan files were swept at write time).
- [ ] PII sweep: no added log line carries a raw phone (`git diff main -- app/src | grep '^+' | grep -iE 'log\.(info|warn|error)'` - eyeball each).
- [ ] Confirm lib/smsCompliance.ts do-not-remove blocks are byte-identical
  to main outside the added classifier section (`git diff main -- app/src/lib/smsCompliance.ts`).
- [ ] Commit any stragglers; handback per the operating manual.

## Self-review checklist (done at plan-writing time)

- Spec coverage: 3.1 -> Task 1; 3.2 -> Task 3; 3.3 -> Task 2; 3.4 ->
  Task 3 step 3d; 3.5 non-changes -> Task 1 step 5 + Task 5 sweeps;
  sec 5 tests -> Tasks 1-4; sec 6 rollout -> nothing owed.
- Type consistency: classifyInboundKeyword consumed with the same
  signature in Tasks 1 and 3; isMemberSuppressed's new arity updated at
  BOTH call sites in Task 2.
- No placeholders: every code step carries the actual code; test sketches
  name the exact arrange idiom file to mirror.
