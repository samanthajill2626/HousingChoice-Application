# Inbound-Message Push Notifications - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fresh inbound message (SMS/MMS on all four webhook paths,
matched email, fresh unmatched email) sends a web push to every
subscribed staff user, coalesced per conversation client-side and
deep-linking to the thread (or /email for unmatched).

**Architecture:** A new pushService.sendToAll (60s-TTL cached users
scan, shared per-device send loop) is called fire-and-forget from the
six inbound persist points. One small dashboard SW change adds
renotify for message kinds, a queue-level unmatched_email tag, and the
/email deep link, mirrored verbatim into public/sw.js.

**Tech Stack:** TypeScript, Express, DynamoDB repos, web-push, Vitest;
dashboard service worker is plain JS mirrored from tested TS modules.

**Spec:** docs/superpowers/specs/2026-08-16-inbound-message-push-design.md
(rev 4, commit da3460be). The plan argues from the spec; read it first.

## Global Constraints (copied from the spec - verbatim hard values)

- Recipients: EVERYONE with a push subscription; enumeration =
  usersRepo.listAll() behind a per-instance 60-second TTL cache
  (60_000 ms). No role/status filtering; subscription presence is the
  filter.
- Emission is FIRE-AND-FORGET at every site (void + .catch log); a push
  must never delay or fail a webhook ack or the email ingest.
- NO TTL on message pushes (ttlSeconds absent -> adapter receives
  undefined options).
- capPushText caps: title 100, body 300, counted in CODE POINTS
  (Array.from), ASCII "..." suffix, result INCLUDING suffix never
  exceeds the cap.
- Unmatched-email emit condition, literally:
  `created === true && row.status === 'unmatched' && !opts.reingest`.
  It is deliberately NARROWER than the SSE condition - do not copy the
  SSE condition.
- Payloads are FLAT ({ title, body, kind, conversationId? }) - never
  nested under `data`.
- kinds: 'message' (has conversationId) and 'unmatched_email' (no id).
- SW: renotify true for 'message' + 'unmatched_email' (tag present);
  requireInteraction stays ONLY missed_call/pre_ring. unmatched tag is
  the bare string 'unmatched_email' (queue-level). Route: kind
  'unmatched_email' -> '/email'; allowlist adds EXACT '/email' (not a
  prefix). Notification data allowlist stays {kind, callId,
  conversationId}.
- Voice pushes (pre_ring/missed_call/voicemail) stay byte-identical:
  payloads, recipients, TTLs, log lines, and their tests.
- ASCII only in all new/edited lines. New copy strings: inline literals
  (deliberate catalog exception per spec D8). New strings: "Sent an
  attachment." and "<sender> sent an attachment.".
- Commit discipline: bare `git status` before EVERY commit; explicit
  pathspecs only (never `git add -A`); Co-Authored-By trailer naming
  the authoring model on every commit.
- Gates run BARE from the worktree W:\tmp\inbound-message-push - never
  piped: `npm run typecheck`, `npm test`, `npm run e2e` (with an outer
  timeout mechanism, not a pipe).
- Focused test runs used below: `npm run test -w app -- <filter>` and
  `npm run test -w dashboard -- <filter>` from the worktree root
  (both workspace test scripts are `vitest run`; the filter is a file
  substring).

## File map (who owns what)

- Create: `app/src/lib/pushText.ts` (+ `app/test/pushText.test.ts`) -
  capPushText.
- Create: `app/src/lib/contactName.ts` (+ `app/test/contactName.test.ts`)
  - contactDisplayName.
- Modify: `app/src/lib/groupTitle.ts` (+ `app/test/groupTitle.test.ts`
  extend or create) - add relayThreadLabel.
- Modify: `app/src/routes/inbox.ts` (relayRowFor re-points to
  relayThreadLabel).
- Modify: `app/src/services/pushService.ts` (+ extend
  `app/test/pushService.test.ts`) - sendToAll + shared loop + TTL cache.
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (fake PushService
  gains sendToAll -> world.pushBroadcasts) and
  `app/test/founderTriage.test.ts` (its local fake gains sendToAll).
- Modify: `app/src/routes/webhooks/twilio.ts` (+ new
  `app/test/inboundMessagePush.test.ts` driven through the harness) -
  four emit sites.
- Modify: `app/src/services/inboundEmail.ts` (+ extend
  `app/test/inboundEmail.test.ts` - the existing inbound email suite;
  if the suite lives under a different name, extend THAT file - locate
  with `dir app\test | findstr /i email`), `app/src/worker.ts`,
  `app/src/routes/webhooks/ses.ts`, `app/src/routes/unmatchedEmail.ts`.
- Modify: `dashboard/src/sw/display.ts`, `dashboard/src/sw/route.ts`,
  `dashboard/public/sw.js`, extend `dashboard/src/sw/display.test.ts` +
  `dashboard/src/sw/route.test.ts`, create
  `dashboard/src/sw/mirror.test.ts`.
- Modify: `app/src/repos/usersRepo.ts` (ONLY the stale premise comment
  near lines 585-587).
- Create: `docs/issues/push-subscription-prune-rmw-lost-update.md`,
  `docs/issues/consolidate-contact-display-name-helpers.md`,
  `docs/issues/e2e-push-seam-missing.md`.

Line-number anchors below are from main @d0c28678. If a line has
drifted, anchor by the QUOTED code, not the number.

---

### Task 1: capPushText (app/src/lib/pushText.ts)

**Files:**
- Create: `app/src/lib/pushText.ts`
- Test: `app/test/pushText.test.ts`

**Interfaces:**
- Produces: `capPushText(text: string, maxCodePoints: number): string`
  and constants `PUSH_TITLE_MAX = 100`, `PUSH_BODY_MAX = 300`. Tasks 5,
  6 consume all three.

- [ ] **Step 1: Write the failing test**

`app/test/pushText.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { capPushText, PUSH_BODY_MAX, PUSH_TITLE_MAX } from '../src/lib/pushText.js';

describe('capPushText', () => {
  it('returns short text unchanged', () => {
    expect(capPushText('hello', 10)).toBe('hello');
  });

  it('returns text exactly at the cap unchanged', () => {
    expect(capPushText('a'.repeat(10), 10)).toBe('a'.repeat(10));
  });

  it('truncates over-cap text; result INCLUDING the suffix equals the cap', () => {
    const out = capPushText('a'.repeat(11), 10);
    expect(out).toBe('a'.repeat(7) + '...');
    expect(Array.from(out).length).toBe(10);
  });

  it('counts code points, never splitting a surrogate pair', () => {
    // 6 emoji (each one code point, two UTF-16 units) over a cap of 5
    const out = capPushText('\u{1F600}'.repeat(6), 5);
    expect(out).toBe('\u{1F600}'.repeat(2) + '...');
    expect(Array.from(out).length).toBe(5);
  });

  it('exports the spec caps', () => {
    expect(PUSH_TITLE_MAX).toBe(100);
    expect(PUSH_BODY_MAX).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w app -- pushText`
Expected: FAIL (cannot resolve ../src/lib/pushText.js)

- [ ] **Step 3: Write the implementation**

`app/src/lib/pushText.ts`:

```ts
// pushText - server-side caps for push notification copy (spec D12).
//
// WHY: a web-push payload over ~4KB is REJECTED by the push service with
// a non-Gone status, so pushService counts it `failed`, KEEPS the
// subscription, and the notification is silently lost - and would be
// lost again on every send. An uncapped matched-email push body can be
// the stored body text (up to 100KB), so the cap must run server-side
// at the send site. Counted in CODE POINTS so a surrogate pair (emoji)
// is never split mid-character.

/** Max code points for a push title (spec D12). */
export const PUSH_TITLE_MAX = 100;
/** Max code points for a push body (spec D12). */
export const PUSH_BODY_MAX = 300;

/**
 * Cap `text` at `maxCodePoints`. Over-cap input is truncated so the
 * result INCLUDING the ASCII "..." suffix is exactly the cap.
 */
export function capPushText(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  if (points.length <= maxCodePoints) return text;
  return points.slice(0, Math.max(0, maxCodePoints - 3)).join('') + '...';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w app -- pushText`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/pushText.ts app/test/pushText.test.ts
git commit -m "feat(push): capPushText - code-point caps for push copy" -m "Co-Authored-By: <authoring model>"
```

---

### Task 2: contactDisplayName (app/src/lib/contactName.ts)

**Files:**
- Create: `app/src/lib/contactName.ts`
- Test: `app/test/contactName.test.ts`

**Interfaces:**
- Consumes: `ContactItem` from `app/src/repos/contactsRepo.ts`
  (firstName/lastName ride the index signature - they are NOT declared
  fields; read defensively exactly as below).
- Produces: `contactDisplayName(contact: ContactItem | undefined):
  string | undefined`. Tasks 5, 6 consume it.

- [ ] **Step 1: Write the failing test**

`app/test/contactName.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { contactDisplayName } from '../src/lib/contactName.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';

function contact(fields: Record<string, unknown>): ContactItem {
  return { contactId: 'c1', type: 'tenant', created_at: 'x', ...fields } as ContactItem;
}

describe('contactDisplayName', () => {
  it('joins trimmed first and last', () => {
    expect(contactDisplayName(contact({ firstName: ' Keisha ', lastName: 'Jones' }))).toBe(
      'Keisha Jones',
    );
  });
  it('returns a single present part alone', () => {
    expect(contactDisplayName(contact({ firstName: 'Keisha' }))).toBe('Keisha');
    expect(contactDisplayName(contact({ lastName: ' Jones ' }))).toBe('Jones');
  });
  it('returns undefined for no name parts, blank parts, or non-strings', () => {
    expect(contactDisplayName(contact({}))).toBeUndefined();
    expect(contactDisplayName(contact({ firstName: '  ', lastName: '' }))).toBeUndefined();
    expect(contactDisplayName(contact({ firstName: 42 }))).toBeUndefined();
  });
  it('returns undefined for an undefined contact', () => {
    expect(contactDisplayName(undefined)).toBeUndefined();
  });
});
```

NOTE: if the `contact()` helper above does not satisfy ContactItem's
required fields, open `app/src/repos/contactsRepo.ts`, find the
ContactItem interface, and adjust the base object to carry every
required field with dummy values. Do not weaken the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w app -- contactName`
Expected: FAIL (cannot resolve ../src/lib/contactName.js)

- [ ] **Step 3: Write the implementation**

`app/src/lib/contactName.ts`:

```ts
// contactDisplayName - the trimmed "First Last" join for push copy.
//
// SCOPE GUARD: five PRIVATE copies of this derivation already exist
// (routes/contacts.ts, routes/units.ts, lib/rosterResolution.ts,
// services/groupMembers.ts, services/inboundEmail.ts). This module is
// consumed by the inbound-message PUSH sites only; consolidating the
// older copies is tracked in
// docs/issues/consolidate-contact-display-name-helpers.md - do not
// re-point them here as a drive-by.
import type { ContactItem } from '../repos/contactsRepo.js';

/** Trimmed first/last join, or undefined when the contact has no name. */
export function contactDisplayName(contact: ContactItem | undefined): string | undefined {
  if (contact === undefined) return undefined;
  const first = typeof contact['firstName'] === 'string' ? contact['firstName'].trim() : '';
  const last = typeof contact['lastName'] === 'string' ? contact['lastName'].trim() : '';
  const joined = [first, last].filter((p) => p.length > 0).join(' ');
  return joined.length > 0 ? joined : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w app -- contactName`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/contactName.ts app/test/contactName.test.ts
git commit -m "feat(push): contactDisplayName helper for push titles" -m "Co-Authored-By: <authoring model>"
```

---

### Task 3: relayThreadLabel + inbox re-point

**Files:**
- Modify: `app/src/lib/groupTitle.ts` (append the new export)
- Modify: `app/src/routes/inbox.ts:620-636` (relayRowFor label chain)
- Test: `app/test/groupTitle.test.ts` (extend if it exists, else create)

**Interfaces:**
- Produces: `relayThreadLabel(conv: ConversationItem): string`. Task 5
  consumes it. Signature takes the WHOLE ConversationItem (it reads
  participants, the untyped placement_tag, pool_number).

- [ ] **Step 1: Write the failing tests**

Append to `app/test/groupTitle.test.ts` (create the file with the
imports below if it does not exist):

```ts
import { describe, expect, it } from 'vitest';
import { relayThreadLabel } from '../src/lib/groupTitle.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';

function relayConv(fields: Record<string, unknown>): ConversationItem {
  return { conversationId: 'r1', status: 'open', type: 'relay_group', ...fields } as ConversationItem;
}

describe('relayThreadLabel', () => {
  it('prefers member names: "With A & B"', () => {
    const conv = relayConv({
      participants: [
        { phone: '+15550100001', name: 'Ana Diaz' },
        { phone: '+15550100002', name: ' Jose ' },
        { phone: '+15550100003', name: '' },
      ],
    });
    expect(relayThreadLabel(conv)).toBe('With Ana Diaz & Jose');
  });
  it('falls back to the operator placement_tag', () => {
    expect(relayThreadLabel(relayConv({ placement_tag: ' 12 Oak St ' }))).toBe('12 Oak St');
  });
  it('falls back to the formatted pool number', () => {
    const label = relayThreadLabel(relayConv({ pool_number: '+15550100009' }));
    expect(label).toContain('555');
    expect(label).not.toBe('Relay group');
  });
  it('falls back to "Relay group" when nothing else exists', () => {
    expect(relayThreadLabel(relayConv({}))).toBe('Relay group');
  });
});
```

(If the base-object cast fails typecheck for missing required
ConversationItem fields, add dummy values for the required fields; do
not weaken assertions.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w app -- groupTitle`
Expected: FAIL (relayThreadLabel is not exported)

- [ ] **Step 3: Implement**

Append to `app/src/lib/groupTitle.ts`:

```ts
/**
 * The relay-group thread label - the EXACT precedence chain the inbox
 * row uses (member names -> operator placement_tag -> formatted pool
 * number -> "Relay group"), extracted from routes/inbox.ts relayRowFor
 * so the push title and the inbox row cannot drift.
 *
 * SCOPE GUARD: this consolidates ONLY the inbox row + push title.
 * Other relay-label chains (notably routes/poolNumbersAdmin.ts
 * serverLabel) are DELIBERATELY different precedences pinned by their
 * own tests - do not re-point them here.
 */
export function relayThreadLabel(conv: {
  participants?: readonly ConversationParticipant[];
  [key: string]: unknown;
}): string {
  const memberNames = (conv.participants ?? [])
    .map((p) => (typeof p.name === 'string' ? p.name.trim() : ''))
    .filter((n) => n.length > 0);
  if (memberNames.length > 0) return `With ${memberNames.join(' & ')}`;
  // GOTCHA: the operator tag rides ConversationItem's index signature
  // under the key `placement_tag` (NOT `tag`) and is untyped.
  const tag = typeof conv['placement_tag'] === 'string' ? conv['placement_tag'].trim() : '';
  if (tag.length > 0) return tag;
  const pool = typeof conv['pool_number'] === 'string' ? conv['pool_number'] : '';
  if (pool.length > 0) return formatPhoneForDisplay(pool) ?? pool;
  return 'Relay group';
}
```

Then in `app/src/routes/inbox.ts` relayRowFor (lines 620-636), replace
the inline chain:

```ts
  const relayRowFor = async (conv: ConversationItem): Promise<InboxRow> => {
    const label = relayThreadLabel(conv);
```

(delete the memberNames/tag/if-else block that computed `label`; keep
everything from `const preview =` down unchanged) and add
`relayThreadLabel` to the existing `groupTitle.js` import in inbox.ts
(it already imports `groupThreadLabel` - extend that import).

- [ ] **Step 4: Run the new tests AND the inbox suite**

Run: `npm run test -w app -- groupTitle`
Expected: PASS
Run: `npm run test -w app -- inbox`
Expected: PASS (the existing inbox label expectations, including the
parity pin around app/test/inboxFeed.test.ts:319, must be untouched)

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/lib/groupTitle.ts app/src/routes/inbox.ts app/test/groupTitle.test.ts
git commit -m "refactor(inbox): extract relayThreadLabel for push/inbox label parity" -m "Co-Authored-By: <authoring model>"
```

---

### Task 4: pushService.sendToAll (+ test doubles)

**Files:**
- Modify: `app/src/services/pushService.ts`
- Modify: `app/test/helpers/twilioWebhookHarness.ts` (fake PushService
  ~lines 1815-1824; FakeWorld type ~lines 268-271)
- Modify: `app/test/founderTriage.test.ts` (the local never-resolving
  fake ~lines 421-424)
- Test: `app/test/pushService.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface SendToAllResult { configured: boolean; users: number;
    attempted: number; sent: number; pruned: number; failed: number; }`
  - `PushService.sendToAll(notification: PushNotification):
    Promise<SendToAllResult>`
  - `PushServiceDeps.now?: () => number` (test clock, default Date.now)
  - Harness: `world.pushBroadcasts: Array<{ notification:
    PushNotification }>` (Tasks 5, 6 assert on it).
- Consumes: usersRepo.listAll() (returns full UserItems incl
  push_subscriptions), the existing adapter/prune machinery.

- [ ] **Step 1: Write the failing tests**

Append to `app/test/pushService.test.ts` a new describe. Reuse the
file's existing helpers (fake adapter factory, makeFakeUsersRepo,
createLogCapture, the VAPID config fixture) - read the top of the file
and follow its established construction pattern exactly. The new tests:

```ts
describe('sendToAll', () => {
  // Construction sketch - adapt to the file's existing helpers:
  //   const users = makeFakeUsersRepo(); // then add users with/without subscriptions
  //   const svc = createPushService({ config, usersRepo: users, adapter, logger, now });
  // The fake usersRepo must expose call counts for listAll and findById;
  // if makeFakeUsersRepo does not track calls, wrap it:
  //   let listAllCalls = 0;
  //   const counting = { ...users, listAll: async () => { listAllCalls += 1; return users.listAll(); } };

  it('fans out to every user with subscriptions and aggregates the tally', async () => {
    // user A: 2 subscriptions, user B: 1, user C: none
    // expect result { configured: true, users: 2, attempted: 3, sent: 3, pruned: 0, failed: 0 }
    // expect adapter saw exactly A's 2 + B's 1 endpoints
  });

  it('never calls findById on a fan-out with no Gone endpoints', async () => {
    // expect findByIdCalls === 0 after sendToAll
  });

  it('skips zero-subscription users with no log line', async () => {
    // capture logs; expect NO line mentioning the zero-sub user's userId
  });

  it('emits ONE aggregate info line per notification (kind + counts, never payload)', async () => {
    // expect exactly one info line for the send, containing kind and counts,
    // and JSON.stringify(capture.lines) NOT containing the payload title/body
  });

  it('isolates a failing user: one user whose sends all throw does not stop the next user', async () => {
    // adapter scripted to throw for user A's endpoint; expect B still sent,
    // result.failed counts A's device, no throw
  });

  it('returns a zeroed result and logs error when listAll throws', async () => {
    // counting.listAll = async () => { throw new Error('scan down'); }
    // expect { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 }
  });

  it('is a single-log no-op when VAPID is unconfigured', async () => {
    // construct with the file's unconfigured-config fixture
    // expect { configured: false, ... } and exactly one warn line
  });

  it('caches the user list for 60s: a second send does not re-scan', async () => {
    // let t = 0; const now = () => t;
    // sendToAll twice; expect listAllCalls === 1
    // t = 59_999; third send; expect listAllCalls === 1
    // t = 60_000; fourth send; expect listAllCalls === 2
  });

  it('prunes a Gone endpoint from the repo AND does not re-attempt it within the TTL', async () => {
    // adapter: endpoint X returns gone on first send
    // first sendToAll: pruned === 1; second sendToAll (same cached list):
    // adapter must NOT see X again; repo record no longer contains X
  });

  it('passes undefined options when ttlSeconds is unset (message pushes have no TTL)', async () => {
    // reuse the file's seenOptions pattern; sendToAll without ttlSeconds
    // expect seenOptions === [undefined, ...]
  });
});
```

Write these as REAL tests (the sketches above name every assertion;
fill in the construction using the file's own helpers - no `it.todo`).

Also update the two PushService doubles NOW so typecheck stays the
gate, not a surprise:

1. `app/test/helpers/twilioWebhookHarness.ts` (~1815-1824): extend the
   fake and the FakeWorld type:

```ts
const pushSends: FakeWorld['pushSends'] = [];
const pushBroadcasts: FakeWorld['pushBroadcasts'] = [];
const pushService: PushService = {
  async sendToUser(userId, notification) {
    pushSends.push({ userId, notification });
    return { configured: true, attempted: 1, sent: 1, pruned: 0, failed: 0 };
  },
  async sendToAll(notification) {
    pushBroadcasts.push({ notification });
    return { configured: true, users: 1, attempted: 1, sent: 1, pruned: 0, failed: 0 };
  },
};
```

   In the FakeWorld interface (~268-271), next to `pushSends`, add:

```ts
  /** sendToAll broadcasts (inbound-message pushes) - never used by voice. */
  pushBroadcasts: { notification: PushNotification }[];
```

   and expose `pushBroadcasts` wherever `pushSends` is returned on the
   world object.

2. `app/test/founderTriage.test.ts` (~421-424): the never-resolving
   fake gains a matching member, e.g.:

```ts
  sendToAll: () => new Promise<never>(() => {}),
```

   (match the shape the existing sendToUser member uses there).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npm run test -w app -- pushService`
Expected: FAIL (sendToAll does not exist). Typecheck of the harness
will also fail until Step 3 - that is expected mid-task.

- [ ] **Step 3: Implement sendToAll**

In `app/src/services/pushService.ts`:

1. Add to the interfaces:

```ts
/** Aggregate outcome of a send-to-all fan-out. */
export interface SendToAllResult {
  configured: boolean;
  /** Users that had at least one subscription. */
  users: number;
  attempted: number;
  sent: number;
  pruned: number;
  failed: number;
}
```

   Extend `PushService` with
   `sendToAll(notification: PushNotification): Promise<SendToAllResult>;`
   and `PushServiceDeps` with
   `/** Test clock for the users-list TTL cache; defaults to Date.now. */`
   `now?: () => number;`

2. Extract the per-device loop. The body of the current `for (const
   record of subscriptions)` loop in sendToUser (allowlist prune ->
   adapter send -> gone prune -> transient catch, with its EXACT log
   lines) moves into a shared closure inside createPushService:

```ts
  /** The shared per-device loop: allowlist prune, send, Gone prune,
   *  transient keep. Returns the tally + which endpoints were pruned
   *  so sendToAll can update its cached items. Log lines are the
   *  EXACT lines sendToUser has always emitted per device. */
  async function sendToDevices(
    userId: string,
    subscriptions: PushSubscriptionRecord[],
    body: string,
    kind: string,
  ): Promise<{ sent: number; pruned: number; failed: number; prunedEndpoints: string[] }> {
    let sent = 0;
    let pruned = 0;
    let failed = 0;
    const prunedEndpoints: string[] = [];
    for (const record of subscriptions) {
      if (!isAllowedPushEndpoint(record.endpoint)) {
        await users.removePushSubscription(userId, record.endpoint);
        pruned += 1;
        prunedEndpoints.push(record.endpoint);
        log.warn(
          { userId, kind },
          // CUT-PASTE the existing string from sendToUser VERBATIM - it
          // contains an em dash; do not retype it. ASCII stand-in here:
          'push: stored endpoint failed the host allowlist - pruned, not sent',
        );
        continue;
      }
      try {
        const outcome = await adapter!.sendToSubscription(
          toBrowserSubscription(record),
          body,
          undefined,
        );
        if (outcome.result === 'gone') {
          await users.removePushSubscription(userId, record.endpoint);
          pruned += 1;
          prunedEndpoints.push(record.endpoint);
        } else {
          sent += 1;
        }
      } catch (err) {
        failed += 1;
        log.warn(
          { userId, kind, err: (err as Error).message },
          // CUT-PASTE the existing string from sendToUser VERBATIM - it
          // contains an em dash; do not retype it. ASCII stand-in here:
          'push: send to one device failed (transient) - kept subscription',
        );
      }
    }
    return { sent, pruned, failed, prunedEndpoints };
  }
```

   IMPORTANT: the existing per-device loop passes ttl options through -
   keep that. Give sendToDevices a fifth parameter
   `options: { ttlSeconds: number } | undefined` and pass it to
   `adapter.sendToSubscription` (sendToUser passes
   `notification.ttlSeconds === undefined ? undefined : { ttlSeconds:
   notification.ttlSeconds }` exactly as today; sendToAll passes the
   same expression). The `undefined` literal in the sketch above is the
   sendToAll case - implement via the parameter, not a literal.
   Refactor sendToUser to call sendToDevices and keep its surrounding
   behavior BYTE-IDENTICAL: same unconfigured warn, same
   'user has no subscriptions' info, same final
   'push: sendToUser complete' info with the same fields. The existing
   pushService.test.ts suite is the regression gate - it must pass
   UNCHANGED (do not edit existing assertions).

   NOTE the non-ASCII em dashes in the two quoted log lines are
   PRE-EXISTING strings being MOVED verbatim - moving them keeps the
   log contract; do not retype them by hand, cut and paste the existing
   lines. (The ASCII-only rule applies to NEW lines; these move.)
   If your tooling flags them, keep the strings byte-identical anyway -
   the pushService PII test greps them.

3. Add the cache + sendToAll to the returned object:

```ts
  const USERS_CACHE_TTL_MS = 60_000;
  const now = deps.now ?? Date.now;
  let usersCache: { items: UserItem[]; fetchedAt: number } | undefined;

  ...

    async sendToAll(notification) {
      if (adapter === undefined || !isPushConfigured(config)) {
        log.warn(
          { kind: notification.kind },
          'push not configured (VAPID unset) - broadcast skipped (no-op)',
        );
        return { configured: false, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
      }
      // The 60s TTL cache (spec D10): notification fan-out is a
      // non-mission-critical consumer of a rarely-changing tiny table -
      // do not Scan per message. Staleness bound: a just-subscribed
      // device can lag up to 60s.
      if (usersCache === undefined || now() - usersCache.fetchedAt >= USERS_CACHE_TTL_MS) {
        try {
          usersCache = { items: await users.listAll(), fetchedAt: now() };
        } catch (err) {
          log.error({ err, kind: notification.kind }, 'push: listing users failed - broadcast not sent');
          return { configured: true, users: 0, attempted: 0, sent: 0, pruned: 0, failed: 0 };
        }
      }
      const body = JSON.stringify(notification.payload);
      const options =
        notification.ttlSeconds === undefined ? undefined : { ttlSeconds: notification.ttlSeconds };
      let usersWithSubs = 0;
      let attempted = 0;
      let sent = 0;
      let pruned = 0;
      let failed = 0;
      for (const user of usersCache.items) {
        const subs = user.push_subscriptions ?? [];
        if (subs.length === 0) continue; // silent: presence is the filter (D10)
        usersWithSubs += 1;
        attempted += subs.length;
        try {
          const r = await sendToDevices(user.userId, subs, body, notification.kind, options);
          sent += r.sent;
          pruned += r.pruned;
          failed += r.failed;
          if (r.prunedEndpoints.length > 0) {
            // Keep the cached item honest so repeat sends within the
            // TTL do not re-attempt a known-dead endpoint.
            user.push_subscriptions = subs.filter((s) => !r.prunedEndpoints.includes(s.endpoint));
          }
        } catch (err) {
          // Per-user isolation (the voice founder-loop shape): one
          // failing user never aborts the fan-out.
          failed += subs.length;
          log.warn(
            { userId: user.userId, kind: notification.kind, err: (err as Error).message },
            'push: broadcast to one user failed - continuing',
          );
        }
      }
      log.info(
        { kind: notification.kind, users: usersWithSubs, attempted, sent, pruned, failed },
        'push: sendToAll complete',
      );
      return { configured: true, users: usersWithSubs, attempted, sent, pruned, failed };
    },
```

   (Import `UserItem` from usersRepo for the cache type.)

- [ ] **Step 4: Run the full app suite for this area**

Run: `npm run test -w app -- pushService`
Expected: PASS - ALL existing tests unchanged and green + the new
sendToAll describe green.
Run: `npm run test -w app -- founderTriage`
Expected: PASS (doubles compile; voice behavior untouched).

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/pushService.ts app/test/pushService.test.ts app/test/helpers/twilioWebhookHarness.ts app/test/founderTriage.test.ts
git commit -m "feat(push): sendToAll broadcast with 60s user-list TTL cache" -m "Co-Authored-By: <authoring model>"
```

---

### Task 5: SMS/MMS emit sites (routes/webhooks/twilio.ts)

**Files:**
- Modify: `app/src/routes/webhooks/twilio.ts`
- Test: Create `app/test/inboundMessagePush.test.ts` (driven through
  `app/test/helpers/twilioWebhookHarness.ts` - read an existing
  harness-driven suite such as founderTriage.test.ts or a group-inbound
  suite first and copy its setup shape: createFakeWorld, buildApp,
  signed webhook POST helpers.)

**Interfaces:**
- Consumes: `capPushText/PUSH_TITLE_MAX/PUSH_BODY_MAX` (Task 1),
  `contactDisplayName` (Task 2), `relayThreadLabel` (Task 3),
  `pushService.sendToAll` + `world.pushBroadcasts` (Task 4),
  `groupThreadLabel` (existing), `formatPhoneForDisplay`
  (app/src/lib/phone.js, existing).
- Produces: flat payloads
  `{ title: string, body: string, kind: 'message', conversationId }`.

- [ ] **Step 1: Write the failing tests**

`app/test/inboundMessagePush.test.ts` - one describe per path. Use the
harness's real signed-webhook entry (the same way existing inbound
suites POST /webhooks/twilio/sms) and seed contacts/conversations with
the world's fixtures. The assertions (fill in setup per the harness's
conventions):

```ts
// 1:1 with a named contact
expect(world.pushBroadcasts).toHaveLength(1);
const b = world.pushBroadcasts[0]!;
expect(b.notification.kind).toBe('message');
expect(b.notification.ttlSeconds).toBeUndefined();
expect(b.notification.payload).toEqual({
  title: 'Keisha Jones',           // contactDisplayName wins
  body: 'hey are we still on',
  kind: 'message',
  conversationId: expect.any(String),
});

// 1:1 unknown number: title is the formatted phone
// MMS media-only: body === 'Sent an attachment.'
// MMS with body: body is the text (no attachment suffix)
// long body: body ends with '...' and Array.from(body).length === 300
// REDELIVERY (POST the same MessageSid twice): pushBroadcasts.length === 1
// echo drop (From === business number): pushBroadcasts.length === 0
// keyword STOP on a 1:1: still exactly 1 broadcast (persisted => push)
// relay inbound (member with roster name): title === relayThreadLabel
//   of the seeded relay conv; body === 'Ana: <text>'
// relay media-only: body === 'Ana sent an attachment.'
// relay REMOVED-member sender: body starts with the formatted phone + ': '
// closed-group intercept: kind message, conversationId === the sender 1:1,
//   title from the contact/phone chain (1:1 semantics)
// native group inbound: title === groupThreadLabel(thread participants);
//   body === '<senderName>: <text>'
// voice regression: run one existing missed-call flow (or assert after
//   an SMS test) that world.pushSends is UNTOUCHED by message paths
```

Every sketched line above becomes a real assertion in a real test with
real harness setup. Where the harness lacks a seeding helper for a
path (e.g. a relay conv with a removed member), follow how the
existing relay/group suites construct those worlds - do not invent new
harness APIs.

- [ ] **Step 2: Run to verify the suite fails**

Run: `npm run test -w app -- inboundMessagePush`
Expected: FAIL (pushBroadcasts stays empty - no emit sites yet)

- [ ] **Step 3: Implement the emit sites**

In `app/src/routes/webhooks/twilio.ts`:

1. Deps: add to `TwilioWebhookDeps`:

```ts
  /**
   * Inbound-message push broadcast (spec: inbound-message-push). The
   * real service by default (it no-ops when VAPID is unset); the
   * harness injects a recorder.
   */
  pushService?: PushService;
```

   with `import { createPushService, type PushService } from
   '../../services/pushService.js';` and in createTwilioWebhookRouter's
   construction block (after `groupCrossCheck`, ~line 312):

```ts
  const pushService =
    deps.pushService ?? createPushService({ config, logger: deps.logger });
```

2. Two local helpers near the other module-level helpers (below the
   imports, alongside e.g. isTerminalDeliveryFailure - they are pure):

```ts
/** The sender label for group/relay push bodies: roster name ->
 *  contact display name -> formatted phone (spec 3.4 fallback chain).
 *  All three inputs are already in scope at the persist points - no
 *  new lookups. */
function pushSenderLabel(
  rosterName: string | undefined,
  senderContact: ContactItem | undefined,
  from: string,
): string {
  const roster = typeof rosterName === 'string' ? rosterName.trim() : '';
  if (roster.length > 0) return roster;
  return contactDisplayName(senderContact) ?? formatPhoneForDisplay(from) ?? from;
}

/** The push body for an inbound SMS/MMS (spec 3.4): text when present,
 *  the attachment line for media-only, empty when neither (title-only
 *  render). `sender` prefixes group/relay bodies; undefined for 1:1. */
function pushMessageBody(
  body: string | undefined,
  mediaCount: number,
  sender?: string,
): string {
  const text = body !== undefined && body.length > 0 ? body : undefined;
  if (sender !== undefined) {
    if (text !== undefined) return capPushText(`${sender}: ${text}`, PUSH_BODY_MAX);
    if (mediaCount > 0) return capPushText(`${sender} sent an attachment.`, PUSH_BODY_MAX);
    return capPushText(sender, PUSH_BODY_MAX);
  }
  if (text !== undefined) return capPushText(text, PUSH_BODY_MAX);
  if (mediaCount > 0) return 'Sent an attachment.';
  return '';
}
```

   Imports to add: `capPushText, PUSH_BODY_MAX, PUSH_TITLE_MAX` from
   `../../lib/pushText.js`; `contactDisplayName` from
   `../../lib/contactName.js`; `relayThreadLabel` (extend the existing
   groupTitle import if twilio.ts has one, else add it);
   `formatPhoneForDisplay` from `../../lib/phone.js` (check whether
   twilio.ts already imports it - extend, do not duplicate).

3. One in-router fire-and-forget emitter (inside
   createTwilioWebhookRouter, after the pushService construction):

```ts
  /** Fire-and-forget message-push broadcast (spec D11): never delays
   *  or fails the webhook ack. */
  function emitMessagePush(title: string, body: string, conversationId: string): void {
    void pushService
      .sendToAll({
        kind: 'message',
        payload: {
          title: capPushText(title, PUSH_TITLE_MAX),
          body,
          kind: 'message',
          conversationId,
        },
      })
      .catch((err: unknown) => {
        log.warn({ err, conversationId }, 'inbound message push failed (fire-and-forget)');
      });
  }
```

4. Four call sites, each INSIDE the existing `if (!appended.deduped)`
   SSE block (fresh-append gating for free), placed AFTER the
   `conversation.updated` emit:

   a. Relay (block at ~610-618, `handleRelayInbound`):

```ts
      emitMessagePush(
        relayThreadLabel(relay),
        pushMessageBody(Body, mediaUrls.length, pushSenderLabel(sender?.name, senderContact, From)),
        relay.conversationId,
      );
```

   b. Closed-group intercept (block at ~917-925,
      `handleClosedGroupInbound` - 1:1 semantics, no sender prefix):

```ts
      emitMessagePush(
        contactDisplayName(contact) ??
          (typeof conversation.participant_display_name === 'string' &&
          conversation.participant_display_name.length > 0
            ? conversation.participant_display_name
            : undefined) ??
          formatPhoneForDisplay(From) ??
          From,
        pushMessageBody(Body, mediaUrls.length),
        conversation.conversationId,
      );
```

   c. Native group (block at ~1672-1680, `handleGroupInbound`):

```ts
      emitMessagePush(
        groupThreadLabel(thread.participants),
        pushMessageBody(
          Body,
          mediaUrls.length,
          pushSenderLabel(
            (thread.participants ?? []).find((p) => p.phone === senderE164)?.name,
            senderContact,
            From,
          ),
        ),
        thread.conversationId,
      );
```

   d. Plain 1:1 (block at ~2134-2146, after the conversation.updated
      emit, before the extraction scheduling):

```ts
      emitMessagePush(
        contactDisplayName(contact) ??
          (typeof conversation.participant_display_name === 'string' &&
          conversation.participant_display_name.length > 0
            ? conversation.participant_display_name
            : undefined) ??
          formatPhoneForDisplay(From) ??
          From,
        pushMessageBody(Body, mediaUrls.length),
        persistedConversationId,
      );
```

   Type note: if `ContactItem` is not already imported as a type in
   twilio.ts, add the type-only import from
   `../../repos/contactsRepo.js`.

- [ ] **Step 4: Run the suite to verify it passes**

Run: `npm run test -w app -- inboundMessagePush`
Expected: PASS, all paths.
Run: `npm run test -w app -- founderTriage`
Expected: PASS (voice untouched).

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/routes/webhooks/twilio.ts app/test/inboundMessagePush.test.ts
git commit -m "feat(push): message push broadcast from all four inbound SMS paths" -m "Co-Authored-By: <authoring model>"
```

---

### Task 6: Email emit sites + process wiring

**Files:**
- Modify: `app/src/services/inboundEmail.ts`
- Modify: `app/src/worker.ts` (~209-220 ingestDeps)
- Modify: `app/src/routes/webhooks/ses.ts` (its ingest-deps
  construction - find where it builds the InboundEmailDeps object /
  default ingest and add pushService the same way)
- Modify: `app/src/routes/unmatchedEmail.ts` (~189-198 default ingest
  deps)
- Test: extend the existing inbound-email unit suite (find it:
  `dir app\test | findstr /i email` - the suite that already tests
  ingestInboundEmail tiers/quarantine; extend THAT file so the
  existing fixture builders are reused).

**Interfaces:**
- Consumes: `PushService` (Task 4), `capPushText/PUSH_BODY_MAX/
  PUSH_TITLE_MAX` (Task 1). The service's existing private
  `displayNameOf` (inboundEmail.ts:385) stays for its current use;
  the push title uses it too (no new helper needed here).
- Produces: matched payload `{ title, body, kind: 'message',
  conversationId }`; unmatched payload `{ title, body,
  kind: 'unmatched_email' }` (NO conversationId, NO unmatchedId).

- [ ] **Step 1: Write the failing tests**

In the existing inbound-email suite, add a fake pushService recorder to
the deps the suite already builds:

```ts
const broadcasts: Array<{ kind: string; payload: Record<string, unknown> }> = [];
const pushService = {
  async sendToUser() {
    return { configured: true, attempted: 0, sent: 0, pruned: 0, failed: 0 };
  },
  async sendToAll(n: { kind: string; payload: Record<string, unknown> }) {
    broadcasts.push({ kind: n.kind, payload: n.payload });
    return { configured: true, users: 1, attempted: 1, sent: 1, pruned: 0, failed: 0 };
  },
};
```

(thread it into the deps object the suite passes to ingestInboundEmail;
reset `broadcasts.length = 0` in beforeEach). New cases:

```ts
// matched email (tier 6): 1 broadcast, kind 'message', payload
//   { title: <contact display name>, body: <subject>, kind: 'message',
//     conversationId: <threaded id> }
// matched email with EMPTY subject: body === capPushText(bodyText, 300)
// matched email rfc-id REDELIVERY: broadcasts.length stays 1
// reingest of a matched email (opts { reingest: true }): 0 broadcasts
// unmatched email: 1 broadcast, kind 'unmatched_email',
//   payload === { title: <from name or address>, body: <subject or snippet>,
//   kind: 'unmatched_email' } - assert with toEqual so NO conversationId
//   and NO unmatchedId sneak in
// unmatched REDELIVERY (same object key re-put, created false): 1 total
// oversize/parse-fail/virus/spam-unknown quarantine: 0 broadcasts
// blocklisted (dismissed): 0 broadcasts
// spam verdict from a KNOWN contact: threads AND broadcasts kind 'message'
// deps WITHOUT pushService: every path still works, 0 broadcasts, no throw
```

Each sketched case becomes a real test using the suite's existing
notice/fixture builders.

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npm run test -w app -- <email suite filename>`
Expected: the new cases FAIL (no push emission yet); existing cases
still PASS.

- [ ] **Step 3: Implement**

1. `app/src/services/inboundEmail.ts`:
   - Add to `InboundEmailDeps`:

```ts
  /**
   * Inbound-message push broadcast (spec: inbound-message-push).
   * OPTIONAL: absent means no pushes (unit tests that do not care).
   * Wired by the worker, the dev SES route, and the reingest route.
   */
  pushService?: Pick<PushService, 'sendToAll'>;
```

     with a type-only import of PushService from './pushService.js'
     and value imports `capPushText, PUSH_BODY_MAX, PUSH_TITLE_MAX`
     from '../lib/pushText.js'.
   - In `thread()` after the `conversation.updated` emit (after line
     ~727), add:

```ts
    // Inbound-message push (spec 3.3): fresh threaded mail only -
    // dedupe returned above, and a reingest is old mail being filed
    // (D7). Fire-and-forget: a push must never fail the ingest.
    if (deps.pushService !== undefined && !opts.reingest) {
      const push = deps.pushService;
      const title =
        (threadContact !== undefined ? displayNameOf(threadContact) : undefined) ??
        parsed.from.name ??
        fromNorm;
      const body = subjectCapped.length > 0 ? subjectCapped : bodyText;
      void push
        .sendToAll({
          kind: 'message',
          payload: {
            title: capPushText(title, PUSH_TITLE_MAX),
            body: capPushText(body, PUSH_BODY_MAX),
            kind: 'message',
            conversationId,
          },
        })
        .catch((err: unknown) => {
          log.warn(
            { bucket, key, conversationId, err: (err as Error).message },
            'inbound email message push failed (fire-and-forget)',
          );
        });
    }
```

   - In `quarantineRow` after the SSE emit block (after line ~441),
     add:

```ts
    // Unmatched-email push (spec 3.3, LITERAL condition - deliberately
    // NARROWER than the SSE above: quarantined rows SSE but never
    // push, a re-put (created false) never re-pushes, and a reingest
    // never pushes).
    if (
      created === true &&
      row.status === 'unmatched' &&
      !opts.reingest &&
      deps.pushService !== undefined
    ) {
      const push = deps.pushService;
      void push
        .sendToAll({
          kind: 'unmatched_email',
          payload: {
            title: capPushText(row.from.name ?? row.from.address, PUSH_TITLE_MAX),
            body: capPushText(row.subject.length > 0 ? row.subject : row.snippet, PUSH_BODY_MAX),
            kind: 'unmatched_email',
          },
        })
        .catch((err: unknown) => {
          log.warn(
            { bucket, key, err: (err as Error).message },
            'unmatched email push failed (fire-and-forget)',
          );
        });
    }
```

2. `app/src/worker.ts`: in the inbound-mail block (~192-220), add
   `const { createPushService } = await import('./services/pushService.js');`
   next to the other dynamic imports and
   `pushService: createPushService({ config, logger }),` to the
   ingestDeps object literal.

3. `app/src/routes/webhooks/ses.ts`: where the route builds its
   InboundEmailDeps (read the file; it mirrors the worker's deps
   shape), add a `pushService` member: injected dep if the route's
   deps interface carries one (add `pushService?: PushService;` to
   SesWebhookDeps for test injection), else
   `createPushService({ config, logger })`.

4. `app/src/routes/unmatchedEmail.ts`: same pattern at the default
   ingest deps (~189-198): add
   `pushService: deps.pushService ?? createPushService({ config, logger })`
   (with the matching optional dep on its router deps interface). The
   reingest call passes `{ reingest: true }` already, which suppresses
   emission - the wiring stays uniform.

- [ ] **Step 4: Run the email suite + worker typecheck**

Run: `npm run test -w app -- <email suite filename>`
Expected: PASS (all new + all existing).
Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git status
git add app/src/services/inboundEmail.ts app/src/worker.ts app/src/routes/webhooks/ses.ts app/src/routes/unmatchedEmail.ts app/test/<email suite filename>
git commit -m "feat(push): email message + unmatched-email push broadcasts, wired in worker/ses/reingest" -m "Co-Authored-By: <authoring model>"
```

---

### Task 7: Dashboard SW - renotify, unmatched tag, /email route, mirrors

**Files:**
- Modify: `dashboard/src/sw/display.ts`
- Modify: `dashboard/src/sw/route.ts`
- Modify: `dashboard/public/sw.js` (the verbatim mirrors of BOTH)
- Test: extend `dashboard/src/sw/display.test.ts`,
  `dashboard/src/sw/route.test.ts`; create
  `dashboard/src/sw/mirror.test.ts`

**Interfaces:**
- Consumes: server payloads from Tasks 5/6 (flat kind/conversationId).
- Produces: display/routing behavior only.

- [ ] **Step 1: Write the failing tests**

Extend `dashboard/src/sw/display.test.ts`:

```ts
it('message pushes renotify (alert per message) while staying non-time-sensitive', () => {
  const built = buildNotificationOptions({ kind: 'message', conversationId: 'conv-1' });
  expect(built.options.renotify).toBe(true);
  expect(built.options.requireInteraction).toBe(false);
  expect(built.options.tag).toBe('message:conv-1');
});

it('unmatched_email pushes use the queue-level tag and renotify', () => {
  const built = buildNotificationOptions({ kind: 'unmatched_email', title: 'Vendor' });
  expect(built.options.tag).toBe('unmatched_email');
  expect(built.options.renotify).toBe(true);
  expect(built.options.requireInteraction).toBe(false);
});

it('unmatched_email tag ignores stray ids (queue-level, always)', () => {
  expect(notificationTag({ kind: 'unmatched_email', conversationId: 'conv-9' })).toBe(
    'unmatched_email',
  );
});

it('requireInteraction remains exactly missed_call/pre_ring', () => {
  for (const kind of ['message', 'unmatched_email', 'voicemail', 'test']) {
    expect(buildNotificationOptions({ kind, callId: 'x', conversationId: 'y' }).options.requireInteraction).toBe(false);
  }
});
```

(Adjust the unmatched-tag-ignores-ids expectation ONLY if you instead
implement id-first - do not: the spec says queue-level ALWAYS for
unmatched_email.)

Extend `dashboard/src/sw/route.test.ts`:

```ts
it('routes kind unmatched_email to /email', () => {
  expect(resolveSafePath({ kind: 'unmatched_email' })).toBe('/email');
});

it('conversationId still wins over kind', () => {
  expect(resolveSafePath({ kind: 'unmatched_email', conversationId: 'c1' })).toBe(
    '/conversations/c1',
  );
});

it('allowlist admits exact /email only', () => {
  const origin = 'https://app.example';
  expect(assertSameOriginPath('/email', origin)).toBe('/email');
  expect(assertSameOriginPath('/email/quarantine', origin)).toBe('/');
  expect(assertSameOriginPath('/emails', origin)).toBe('/');
});
```

Create `dashboard/src/sw/mirror.test.ts`:

```ts
// The classic worker (public/sw.js) cannot import the tested modules -
// it carries verbatim mirrors. Nothing else verifies the mirror, and
// sw.js has been lost wholesale before (its own header says so). This
// smoke test pins the NEW tokens of the inbound-message-push feature
// into the artifact that actually runs. It is NOT a full equality
// check (out of scope by spec).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

describe('public/sw.js mirror carries the inbound-message-push changes', () => {
  it('has the queue-level unmatched_email tag branch', () => {
    expect(swSource).toContain("'unmatched_email'");
  });
  it('routes unmatched_email to /email and allowlists it', () => {
    expect(swSource).toContain("'/email'");
  });
  it('has the alerting renotify set', () => {
    expect(swSource).toContain('alerting');
  });
});
```

(If `__dirname` is unavailable under the dashboard's vitest ESM config,
use `new URL('../../public/sw.js', import.meta.url)` with
`fileURLToPath` - match whatever the dashboard's other node-side tests
do; if none exist, the URL form is the safe default.)

- [ ] **Step 2: Run to verify failures**

Run: `npm run test -w dashboard -- sw`
Expected: new display/route cases FAIL; mirror test FAILS.

- [ ] **Step 3: Implement the tested modules**

`dashboard/src/sw/display.ts`:

1. `notificationTag` - add the queue-level branch FIRST:

```ts
export function notificationTag(data: PushDisplayData | null | undefined): string | undefined {
  const d = data ?? {};
  // Queue-level tag: ALL unmatched-email pushes share one shade entry
  // (the triage queue), replaced in place by each new arrival.
  if (d.kind === 'unmatched_email') return 'unmatched_email';
  const id = d.callId || d.conversationId || undefined;
  if (!id) return undefined;
  return d.kind ? `${d.kind}:${id}` : id;
}
```

2. `buildNotificationOptions` - split alerting from time-sensitive:

```ts
  const timeSensitive = d.kind === 'missed_call' || d.kind === 'pre_ring';
  // Alerting kinds RE-ALERT on a same-tag replacement (renotify): the
  // native-SMS behavior where message 2 in a thread still buzzes.
  // Time-sensitive kinds additionally pin to the screen
  // (requireInteraction).
  const alerting = timeSensitive || d.kind === 'message' || d.kind === 'unmatched_email';
  const tag = notificationTag(d);
```

   and in the options: `renotify: alerting && Boolean(tag),`
   (requireInteraction stays `timeSensitive`). Update the function's
   doc comment to describe the alerting set.

`dashboard/src/sw/route.ts`:

```ts
  if (isPlausibleId(d.conversationId)) {
    return `/conversations/${encodeURIComponent(d.conversationId)}`;
  }
  // Unmatched email has NO conversation - the tap lands on the triage
  // queue page.
  if (d.kind === 'unmatched_email') {
    return '/email';
  }
  return '/';
```

   and in `assertSameOriginPath` the allowlist line becomes:

```ts
    if (
      url.pathname === '/' ||
      url.pathname === '/email' ||
      /^\/conversations\/[^/]+$/.test(url.pathname)
    ) {
```

   Update the file-header allow-list comment ('/', '/email',
   '/conversations/<id>').

- [ ] **Step 4: Run display/route tests**

Run: `npm run test -w dashboard -- sw`
Expected: display.test.ts + route.test.ts PASS (including every
pre-existing case); mirror.test.ts still FAILS (sw.js untouched).

- [ ] **Step 5: Mirror into public/sw.js**

In `dashboard/public/sw.js`, update the inlined copies VERBATIM to
match the modules edited in Step 3: the notificationTag copy, the
buildNotificationOptions copy (timeSensitive/alerting/renotify), the
resolveSafePath copy, and the assertSameOriginPath allowlist. Keep the
existing mirror-banner comments; update the documented payload-kind
list ('missed_call' | 'message' | 'unmatched_email' | 'test' | ...) and
the allow-list comment. Make sure every ADDED line is ASCII.

- [ ] **Step 6: Run the dashboard suite**

Run: `npm run test -w dashboard -- sw`
Expected: ALL PASS including mirror.test.ts.

- [ ] **Step 7: Commit**

```bash
git status
git add dashboard/src/sw/display.ts dashboard/src/sw/route.ts dashboard/src/sw/display.test.ts dashboard/src/sw/route.test.ts dashboard/src/sw/mirror.test.ts dashboard/public/sw.js
git commit -m "feat(sw): renotify for message kinds, queue-level unmatched tag, /email deep link" -m "Co-Authored-By: <authoring model>"
```

---

### Task 8: Issues, comment amendment, issue index

**Files:**
- Create: `docs/issues/push-subscription-prune-rmw-lost-update.md`
- Create: `docs/issues/consolidate-contact-display-name-helpers.md`
- Create: `docs/issues/e2e-push-seam-missing.md`
- Modify: `app/src/repos/usersRepo.ts` (~585-587, comment only)

Copy `docs/issues/_TEMPLATE.md` frontmatter conventions (id, title,
type, severity, status, area, created, refs - see any recent issue
file). Contents, one paragraph each plus a suggested-fix paragraph:

- [ ] **Step 1: push-subscription-prune-rmw-lost-update.md** (type:
  bug, severity: low, area: app/push): push_subscriptions
  add/removePushSubscription are whole-list read-modify-writes with no
  version condition (usersRepo.ts:581-631). The inbound-message push
  fan-out (spec: inbound-message-push) moved Gone-prunes onto the
  message path from two processes (app webhooks + mail worker),
  fire-and-forget, so overlapping writes on one user item are possible:
  a prune overlapping a re-subscribe clobbers the fresh subscription;
  two concurrent prunes of different dead endpoints can resurrect one.
  Accepted at team scale (spec section 5); recovery = the next Gone
  prune or re-toggling notifications. Suggested fix: an
  optimistic-version loop or endpoint-keyed storage.

- [ ] **Step 2: consolidate-contact-display-name-helpers.md** (type:
  debt, severity: low, area: app): six copies of the firstName/lastName
  join now exist (routes/contacts.ts, routes/units.ts,
  lib/rosterResolution.ts, services/groupMembers.ts,
  services/inboundEmail.ts, and the new canonical
  lib/contactName.ts contactDisplayName). Consolidate the five older
  private copies onto lib/contactName.ts in a dedicated sweep with
  their tests.

- [ ] **Step 3: e2e-push-seam-missing.md** (type: gap, severity: low,
  area: e2e): pushes have no e2e seam (no dev outbox / fake push
  service / control API); voice pushes and inbound-message pushes are
  unit-harness-tested only. A future seam could record adapter sends
  behind a dev flag like the SMS outbox did, or a fake web-push
  receiver in the hermetic lane.

  (If the template's `type:` vocabulary differs (e.g. no 'debt'/'gap'),
  use the nearest existing value seen in current issue files.)

- [ ] **Step 4: usersRepo comment amendment** - at the "Device-count
  contention on one user is not a real concern (a person adds devices
  serially), so a plain RMW is fine" comment (~585-587), append one
  ASCII line to the comment block:

```
  // (Since inbound-message push, prunes also run on the message path
  // from two processes - overlap is possible but accepted at team
  // scale; see docs/issues/push-subscription-prune-rmw-lost-update.md.)
```

- [ ] **Step 5: Regenerate the issue index**

Run: `npm run issues`
Expected: exits 0 (INDEX.md is gitignored - do not stage it).

- [ ] **Step 6: Commit**

```bash
git status
git add docs/issues/push-subscription-prune-rmw-lost-update.md docs/issues/consolidate-contact-display-name-helpers.md docs/issues/e2e-push-seam-missing.md app/src/repos/usersRepo.ts
git commit -m "docs(issues): file push RMW race, display-name consolidation, e2e push seam" -m "Co-Authored-By: <authoring model>"
```

---

### Task 9: Full gates, main sync, handback

- [ ] **Step 1: ASCII sweep of the branch diff**

Run (Git Bash): `git diff main...HEAD | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c`
Expected: 0. EXCEPTION: Task 4's two MOVED log-line strings carry
pre-existing em dashes - if the count is nonzero, verify every
non-ASCII byte sits on one of those two moved lines (and the
pushService PII test still passes); anything else must be fixed.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` (bare, from the worktree)
Expected: exit 0.

- [ ] **Step 3: Unit suites**

Run: `npm test` (bare, from the worktree)
Expected: exit 0, all workspaces. Known flakes
(tour-reminders-panel-e2e-flake, conversationdetail-members-mock-suite-
flake) get ONE re-run before blaming the change, both runs reported.

- [ ] **Step 4: Sync main ONCE**

Run: `git fetch` is unnecessary (same local repo); merge the shared
checkout's current main: `git merge main`. Resolve preserving both
sides' intent; re-run typecheck + `npm run test -w app -- pushService`
after any conflict resolution. If main has moved so far that the merge
conflicts with active work, STOP and report instead of improvising.

- [ ] **Step 5: e2e**

Run: `npm run e2e` (bare, from the worktree, with the orchestrator's
outer timeout mechanism - never piped)
Expected: exit 0. On a known-flake failure: one re-run, both reported.

- [ ] **Step 6: Handback**

Write the handback per the mission contract (gate exit codes verbatim,
per-spec-item map, deviations, the four commits' shas) to
`.superpowers/sdd/handback.md`. Do NOT merge; do NOT clean up.

---

## Self-review notes (plan author)

- Spec coverage walked: D1-D12 -> Tasks 4 (D1, D9, D10), 5/6 (D5, D6,
  D7, D11, D12 bodies), 7 (D2 renotify + tags + routing), 8 (deferred
  issues), 9 (gates). D3 (no quiet-hours gating) and D8 (inline copy)
  are delivered by NOT building anything - no task touches quiet hours
  or the catalog; the adversarial reviewer checks that nothing crept in.
- The voice byte-identical guarantee is pinned by founderTriage.test.ts
  running unchanged (Tasks 4, 5).
- Type consistency: SendToAllResult { configured, users, attempted,
  sent, pruned, failed } is used identically in Tasks 4, 5, 6 fakes.
  capPushText(text, max) and PUSH_TITLE_MAX/PUSH_BODY_MAX are used
  identically in Tasks 1, 5, 6.
- Known open risk for the builder: exact harness seeding APIs for
  relay/group worlds are described by POINTING at existing suites, not
  quoted - the harness is 3600+ lines and its helpers are the stable
  interface; inventing new harness APIs is forbidden.
