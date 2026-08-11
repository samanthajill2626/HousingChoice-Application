// Native group-text DETECTION at the inbound messaging webhook (S3, spec 5).
//
// The whole feature turns on one undocumented envelope: `OtherRecipients{N}`.
// These tests drive the REAL router (real signature, real keyword seam, real
// identity derivation) against the in-memory world, so what they pin is the
// actual filing decision - not a mock of it.
import { describe, expect, it } from 'vitest';

import { conversationIdForGroup, contactIdForPhone } from '../src/lib/import/ids.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import { GROUP_RAILED_INBOUND_LAST_AT_ID } from '../src/repos/settingsRepo.js';
import { STOP_CONFIRMATION } from '../src/lib/smsCompliance.js';
import {
  createFakeWorld,
  inboundSmsParams,
  makeWebhookHarness,
  OUR_NUMBER,
  signedTwilioPost,
  TENANT_PHONE,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const WARN = 40;
const ERROR = 50;
const SMS_PATH = '/webhooks/twilio/sms';

/** The three outside members of the standard test group. */
const SENDER = TENANT_PHONE; // +15550100001
const MEMBER_B = '+15550100002';
const MEMBER_C = '+15550100003';
const GROUP_ROSTER = [SENDER, MEMBER_B, MEMBER_C];
const GROUP_ID = conversationIdForGroup(GROUP_ROSTER);

/** Inbound params carrying a two-other-recipient group envelope. */
function groupParams(overrides: Record<string, string> = {}): Record<string, string> {
  return inboundSmsParams({
    MessageSid: 'MMgroup0001',
    OtherRecipients0: MEMBER_B,
    OtherRecipients1: MEMBER_C,
    ...overrides,
  });
}

function groupThread(world: FakeWorld): ConversationItem | undefined {
  return world.conversations.get(GROUP_ID);
}

/**
 * Make the `byPhone` GSI LAG - the one real-DynamoDB behavior no fake in this
 * suite reproduces, and the reason a live defect survived 229 e2e tests.
 *
 * `contactsRepo.findByPhone` is a QUERY on an eventually-consistent index, so a
 * contact written moments ago in the SAME request is legitimately invisible to
 * it, while `getById` (a point read on the base table) sees it immediately.
 * Every fake resolves both consistently, so a lookup that goes through the index
 * always hit in tests and never in production.
 *
 * Only `findByPhone` is darkened, and only for `lagged` phones while `on` is
 * true. Flip `on` to false to model the index having caught up.
 */
function withLaggingPhoneIndex(world: FakeWorld, lagged: string[]): { on: boolean } {
  const real = world.contactsRepo;
  const gate = { on: true };
  world.contactsRepo = {
    ...real,
    findByPhone: async (phone: string) =>
      gate.on && lagged.includes(phone) ? undefined : real.findByPhone(phone),
  };
  return gate;
}

// ---------------------------------------------------------------------------
// T3.2 - branch placement
// ---------------------------------------------------------------------------
describe('group detection: branch placement (T3.2)', () => {
  /**
   * INVARIANT 13.2. An envelope-less inbound must take the 1:1 path with a
   * BYTE-IDENTICAL repo-call sequence: the group branch's only cost on that
   * path is reading form params off an already-parsed object.
   *
   * The baseline is r4 section A.10 - the ordered call list of a plain
   * main-number inbound with a known, already-linked contact.
   */
  function recordingWorld(): { world: FakeWorld; calls: string[] } {
    const world = createFakeWorld();
    const calls: string[] = [];
    const spy = <T extends object>(label: string, repo: T): T =>
      new Proxy(repo, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push(`${label}.${String(prop)}`);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    world.conversationsRepo = spy('conversations', world.conversationsRepo);
    world.contactsRepo = spy('contacts', world.contactsRepo);
    world.messagesRepo = spy('messages', world.messagesRepo);
    world.settingsRepo = spy('settings', world.settingsRepo);
    return { world, calls };
  }

  it('an envelope-less inbound produces the UNCHANGED 1:1 repo-call sequence', async () => {
    const { world, calls } = recordingWorld();
    world.contacts.push({
      contactId: 'c-known',
      type: 'tenant',
      phone: SENDER,
      consent_method: 'inbound_text',
    });
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(calls).toEqual([
      // (1) echo check: ourNumberKind's pool membership probe
      'conversations.getByPoolNumber',
      // (1.5) relay routing on To
      'conversations.getAllByPoolNumber',
      // (2) contact + conversation
      'contacts.findByPhone',
      'conversations.createOrGetByParticipantPhone',
      // (3) append
      'messages.append',
      // (3.5) auto-capture (known phone, missing link -> the conversation claim)
      'conversations.setParticipantsIfAbsent',
      // (3.6) multi-phone lastSeenAt
      'contacts.touchPhoneLastSeen',
      // (4) keywords: plain inbound, contact already consented -> ZERO writes
      // (5) media: none
      // (6) inbox touch
      'conversations.incrementUnread',
      'conversations.touchLastActivity',
    ]);
  });

  it('adds NO pool-number read and NO group repo call to an envelope-less inbound', async () => {
    const { world, calls } = recordingWorld();
    // The pool read is the ONE piece of I/O the group branch needs, so it is the
    // one that must not touch the 1:1 path. Spy it for real - asserting that the
    // method merely EXISTS proves nothing.
    let poolReads = 0;
    const realListActive = world.poolNumbersRepo.listActive.bind(world.poolNumbersRepo);
    world.poolNumbersRepo = {
      async listActive() {
        poolReads += 1;
        return realListActive();
      },
    };
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(calls.filter((c) => c.includes('GroupText'))).toEqual([]);
    expect(calls.filter((c) => c.includes('putGroupTimestamp'))).toEqual([]);
    expect(poolReads).toBe(0);
  });

  it('DOES read the pool numbers once a group envelope is present (the spy is real)', async () => {
    // The control for the assertion above: same spy, envelope present.
    const world = createFakeWorld();
    let poolReads = 0;
    const realListActive = world.poolNumbersRepo.listActive.bind(world.poolNumbersRepo);
    world.poolNumbersRepo = {
      async listActive() {
        poolReads += 1;
        return realListActive();
      },
    };
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(poolReads).toBe(1);
  });

  it('A6: a group envelope addressed to a POOL number keeps relay behavior', async () => {
    // The relay block FALLS THROUGH when every group on a pool number is closed.
    // Without the business-number gate this inbound would mint a native thread
    // and quietly change relay behavior (invariant 13.6).
    const world = createFakeWorld();
    const poolNumber = '+15559990001';
    world.conversations.set('relay-closed', {
      conversationId: 'relay-closed',
      type: 'relay_group',
      status: 'closed',
      pool_number: poolNumber,
      participants: [{ contactId: 'c-x', phone: '+15550999999' }],
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, groupParams({ To: poolNumber }));

    expect(res.status).toBe(200);
    expect(groupThread(world)).toBeUndefined();
    // It fell through to the ordinary 1:1 intake, exactly as before this feature.
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
  });

  it('INVARIANT 13.1: a pool-addressed group envelope filed 1:1 still carries the marker + a WARN', async () => {
    // A6 keeps relay behavior byte-identical by not minting a thread here. That
    // decision is SEPARATE from the extraction marker: this message is proven
    // carrier-group content (the envelope is right here), so filing it 1:1
    // unmarked would feed group content to AI fact extraction as this one
    // contact's own speech - the precise harm the marker exists to prevent.
    const world = createFakeWorld();
    const poolNumber = '+15559990001';
    world.conversations.set('relay-closed', {
      conversationId: 'relay-closed',
      type: 'relay_group',
      status: 'closed',
      pool_number: poolNumber,
      participants: [{ contactId: 'c-x', phone: '+15550999999' }],
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams({ To: poolNumber }));

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_off_business_number'),
    ).toBe(true);
  });

  it('INVARIANT 13.1: a late text on a CLOSED relay group carrying an envelope is marked + WARNed', async () => {
    // THE FIFTH FILING PATH. The closed-group intercept runs at step (1.5),
    // BEFORE the group block computes an envelope at all, so a carrier group
    // that still includes a RETIRED POOL NUMBER lands here and is filed as one
    // contact's 1:1 speech. Routing is unchanged (invariant 13.6); the filing
    // is no longer silent.
    const world = createFakeWorld();
    const poolNumber = '+15559990001';
    world.conversations.set('relay-closed-member', {
      conversationId: 'relay-closed-member',
      type: 'relay_group',
      status: 'closed',
      pool_number: poolNumber,
      participants: [
        { contactId: 'c-sender', phone: SENDER },
        { contactId: 'c-x', phone: '+15550999999' },
      ],
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams({ To: poolNumber }));

    // Routing UNCHANGED: still the 1:1 intercept with closed-group provenance.
    expect(groupThread(world)).toBeUndefined();
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.via_closed_group).toBe('relay-closed-member');
    // ...and MARKED + LOUD like every other envelope-bearing 1:1 filing.
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_via_closed_relay_group'),
    ).toBe(true);
  });

  it('an ENVELOPE-LESS late text on a closed relay group is neither marked nor warned', async () => {
    // The negative control: the marker follows the ENVELOPE, not the intercept.
    const world = createFakeWorld();
    const poolNumber = '+15559990001';
    world.conversations.set('relay-closed-member', {
      conversationId: 'relay-closed-member',
      type: 'relay_group',
      status: 'closed',
      pool_number: poolNumber,
      participants: [{ contactId: 'c-sender', phone: SENDER }],
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams({ To: poolNumber }));

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.via_closed_group).toBe('relay-closed-member');
    expect(world.messages[0]?.group_ambiguous_origin).toBeUndefined();
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_via_closed_relay_group'),
    ).toBe(false);
  });

  it('WARNs AND marks instead of silently disabling when the business number is unset', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({
      world,
      env: { BUSINESS_PHONE_NUMBER: undefined },
    });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(groupThread(world)).toBeUndefined();
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_detection_unconfigured'),
    ).toBe(true);
    // The fourth exception to invariant 13.1 is MARKED like the other three.
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3.3 - filing
// ---------------------------------------------------------------------------
describe('group detection: filing (T3.3)', () => {
  it('(a) NOT FOUND: creates the native thread at the derived id and files the message there', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(res.status).toBe(200);
    expect(res.text).toContain('<Response/>');
    const thread = groupThread(world)!;
    expect(thread).toBeDefined();
    expect(thread.type).toBe('group_text');
    expect(thread.status).toBe(GROUP_TEXT_STATUS);
    expect((thread.participants ?? []).map((m) => m.phone).sort()).toEqual([...GROUP_ROSTER].sort());
    // The message is on the GROUP thread and NOWHERE else - never also 1:1.
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).toBe(GROUP_ID);
    expect(world.conversations.size).toBe(1);
  });

  it('mints a contact stub per member under the importer id scheme, with the group basis', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.contacts.map((c) => c.contactId).sort()).toEqual(
      GROUP_ROSTER.map(contactIdForPhone).sort(),
    );
    for (const c of world.contacts) {
      expect(typeof c.group_participation_at).toBe('string');
      expect(c.origin).toBe('group_detection');
      expect(c.type).toBe('unknown');
    }
  });

  it('leaves the SILENT members with no consent_method, while the SENDER gets inbound_text', async () => {
    // The load-bearing asymmetry (spec 5.3 + A7): the sender genuinely texted
    // us, so the shared keyword seam stamps their real basis. The other two
    // handsets have never messaged us - being added to a group by somebody else
    // is not consent, so they stay unsendable through all six hasSmsConsent
    // consumers.
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    const byId = new Map(world.contacts.map((c) => [c.contactId, c]));
    expect(byId.get(contactIdForPhone(SENDER))?.consent_method).toBe('inbound_text');
    expect(byId.get(contactIdForPhone(MEMBER_B))?.consent_method).toBeUndefined();
    expect(byId.get(contactIdForPhone(MEMBER_C))?.consent_method).toBeUndefined();
  });

  it('(b) FOUND group_text: files into it without re-creating or re-keying the roster', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, SMS_PATH, groupParams());
    const rosterBefore = JSON.stringify(groupThread(world)!.participants);

    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002', Body: 'again' }));

    expect(world.messages).toHaveLength(2);
    expect(world.messages.every((m) => m.conversationId === GROUP_ID)).toBe(true);
    expect(JSON.stringify(groupThread(world)!.participants)).toBe(rosterBefore);
  });

  it('(b) re-enqueues the rail on a RAIL-LESS thread (the create-then-crash heal)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002' }));

    expect(world.groupRailEnqueues.map((r) => r.reason)).toEqual(['created', 'rail_missing']);
    expect(world.groupRailEnqueues[0]?.conversationId).toBe(GROUP_ID);
  });

  it('does NOT re-enqueue the rail once the thread has one', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    await signedTwilioPost(app, SMS_PATH, groupParams());
    world.conversations.get(GROUP_ID)!.twilio_conversation_sid = 'CH00000000000000000000000000000001';
    world.groupRailEnqueues.length = 0;

    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002' }));

    expect(world.groupRailEnqueues).toEqual([]);
  });

  it('(c) FOUND connecting relay_group: AUTO-CONVERTS inline, files as a group, and WARNs', async () => {
    const world = createFakeWorld();
    world.conversations.set(GROUP_ID, {
      conversationId: GROUP_ID,
      type: 'relay_group',
      status: 'connecting',
      relay_status: 'connecting',
      participants: GROUP_ROSTER.map((phone) => ({ contactId: '', phone })),
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      imported_from: 'quo',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    const thread = groupThread(world)!;
    expect(thread.type).toBe('group_text');
    expect(thread.status).toBe(GROUP_TEXT_STATUS);
    expect(thread.relay_status).toBeUndefined();
    expect(world.messages[0]?.conversationId).toBe(GROUP_ID);
    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_autoconvert_self_heal'),
    ).toBe(true);
  });

  it('(c) AUTOCONVERT REFUSED: a roster that does not hash to its own id files 1:1 with an ERROR + the marker', async () => {
    // The refusal arm of the same inline auto-convert. The known producer is a
    // workbook `drop` applied to a group member: the id encodes the FULL sorted
    // roster while the stored roster is short, so the row cannot describe its
    // own thread and conversion refuses `roster_id_mismatch`. NEVER guess a
    // roster - file to the sender's 1:1, MARKED so AI extraction excludes it,
    // and alarm.
    const world = createFakeWorld();
    world.conversations.set(GROUP_ID, {
      conversationId: GROUP_ID,
      type: 'relay_group',
      status: 'connecting',
      relay_status: 'connecting',
      // SHORT: the derived id is over all three members, this roster has two.
      participants: [SENDER, MEMBER_B].map((phone) => ({ contactId: '', phone })),
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      imported_from: 'quo',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    // Nothing was converted and nothing was filed on the group thread.
    expect(groupThread(world)!.type).toBe('relay_group');
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    const alarm = capture
      .atLevel(ERROR)
      .find((l) => l['event'] === 'group_autoconvert_refused');
    expect(alarm).toBeDefined();
    expect(alarm?.['refusal']).toBe('roster_id_mismatch');
  });

  it('(c) AUTOCONVERT UNREADABLE: a convert that reports success but does not read back files 1:1 with an ERROR + the marker', async () => {
    // The post-convert re-read is a TRUST-NOTHING step: the converter answered
    // `converted`, but if the row does not read back as a group_text we do not
    // know what we are filing into. Modelled by a repo whose conditional
    // transition returns the converted item WITHOUT storing it - the same shape
    // as a lost write or a replica that has not caught up.
    const world = createFakeWorld();
    const stored = {
      conversationId: GROUP_ID,
      type: 'relay_group',
      status: 'connecting',
      relay_status: 'connecting',
      participants: GROUP_ROSTER.map((phone) => ({ contactId: '', phone })),
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
      imported_from: 'quo',
    } as ConversationItem;
    world.conversations.set(GROUP_ID, stored);
    const repo = world.conversationsRepo;
    world.conversationsRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop !== 'convertRelayGroupToGroupText') {
          return Reflect.get(target, prop, receiver) as unknown;
        }
        return async (conversationId: string, members: unknown) =>
          ({ ...stored, conversationId, type: 'group_text', status: GROUP_TEXT_STATUS, participants: members } as ConversationItem);
      },
    });
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(
      capture.atLevel(ERROR).some((l) => l['event'] === 'group_autoconvert_unreadable'),
    ).toBe(true);
  });

  it('CORRUPT SHAPE: an open relay group at the derived id files 1:1 with an ERROR + the marker', async () => {
    const world = createFakeWorld();
    world.conversations.set(GROUP_ID, {
      conversationId: GROUP_ID,
      type: 'relay_group',
      status: 'open',
      pool_number: '+15559990002',
      participants: GROUP_ROSTER.map((phone) => ({ contactId: '', phone })),
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(capture.atLevel(ERROR).some((l) => l['event'] === 'group_id_wrong_shape')).toBe(true);
  });

  it('COLLAPSED ROSTER: fewer than two outside members files 1:1 with a WARN + the marker', async () => {
    const world = createFakeWorld();
    // The only "other recipient" is our own business number - so after exclusion
    // the outside roster is just the sender. That IS a 1:1.
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ MessageSid: 'MMgroup0003', OtherRecipients0: OUR_NUMBER }),
    );

    expect(groupThread(world)).toBeUndefined();
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(capture.atLevel(WARN).some((l) => l['event'] === 'group_roster_collapsed')).toBe(true);
  });

  it('UNPARSEABLE ENVELOPE: never derives a smaller roster - files 1:1 with an ERROR + the marker', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      groupParams({ MessageSid: 'MMgroup0004', OtherRecipients1: 'not-a-phone' }),
    );

    expect(groupThread(world)).toBeUndefined();
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(capture.atLevel(ERROR).some((l) => l['event'] === 'group_envelope_unparseable')).toBe(
      true,
    );
  });

  it('a pool number in the OUTSIDE roster is excluded and warned about', async () => {
    const world = createFakeWorld();
    world.activePoolNumbers.push('+15559990003');
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      groupParams({ OtherRecipients2: '+15559990003' }),
    );

    // The derived id is still the three real members - the pool number is ours.
    expect(groupThread(world)).toBeDefined();
    expect(
      capture
        .atLevel(WARN)
        .some((l) => String(l['msg']).includes('relay pool number in a carrier group')),
    ).toBe(true);
  });

  it('a REDELIVERY dedupes: one message row, no double unread', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.messages).toHaveLength(1);
    expect(world.unreadIncrements.filter((id) => id === GROUP_ID)).toHaveLength(1);
  });

  it('touches the group thread and emits both SSE events on the GROUP id', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.touches.map((t) => t.conversationId)).toEqual([GROUP_ID]);
    const updated = world.emitted.find((e) => e.event === 'conversation.updated');
    expect((updated?.payload as { conversationId: string }).conversationId).toBe(GROUP_ID);
    const persisted = world.emitted.find((e) => e.event === 'message.persisted');
    expect((persisted?.payload as { conversationId: string }).conversationId).toBe(GROUP_ID);
  });

  // THE REPO PARTITION GUARD IS NOT PROVED IN THIS FILE, and no test here may
  // claim it is. `touchLastActivity`'s ConditionExpression
  // (`... OR #type <> :groupText`) lives in conversationsRepo and can only be
  // exercised against a real table; the in-memory world MODELS it
  // (helpers/twilioWebhookHarness.ts - `if (conv.type !== 'group_text')`), so
  // deleting the production ConditionExpression fails NOTHING under a bare
  // `npm test`.
  //
  // THE REAL PROOF IS DOCKER-GATED: app/test/groupTextRepo.integration.test.ts,
  // describe "touchLastActivity partition guard". It self-skips when nothing
  // answers at DYNAMODB_ENDPOINT - run `npm run db:start` to exercise it. Losing
  // a group thread out of its partition is unrecoverable (nothing points back
  // into `group_open`), so that suite is the one that must be run before a
  // release, not this one.
  //
  // What THIS test proves is the WEBHOOK's own half of the property: the only
  // status-bearing repo calls it makes on a group inbound are the guarded
  // create and the guarded touch - it performs no separate status write, so
  // there is no second writer for the repo guard to have to defend against.
  it('performs NO separate status write on a group inbound (the repo guard is the only defender)', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const statusWrites: string[] = [];
    const repo = world.conversationsRepo;
    world.conversationsRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          // Every repo method whose name says it writes a lifecycle status.
          if (/^(assignPoolNumberAndOpen|closeGroup|reopenGroup|setStatus)/.test(String(prop))) {
            statusWrites.push(String(prop));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(statusWrites).toEqual([]);
    // The touch went through the ONE guarded seam, on the group id.
    expect(world.touches.map((t) => t.conversationId)).toEqual([GROUP_ID]);
    // And the modelled guard held - see the header above for why this line is
    // NOT the proof of the production ConditionExpression.
    expect(groupThread(world)!.status).toBe(GROUP_TEXT_STATUS);
  });

  it('records the railed-inbound liveness mark ONLY when the thread has a rail', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    expect(world.groupTimestamps.get(GROUP_RAILED_INBOUND_LAST_AT_ID)).toBeUndefined();

    world.conversations.get(GROUP_ID)!.twilio_conversation_sid = 'CH00000000000000000000000000000001';
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002' }));
    expect(typeof world.groupTimestamps.get(GROUP_RAILED_INBOUND_LAST_AT_ID)).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// T3.4a - phone-scoped member keys
// ---------------------------------------------------------------------------
describe('group detection: PHONE-SCOPED member keys (T3.4a)', () => {
  it('attributes the message with phone#<E164>, never the contactId', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.messages[0]?.relay_sender_key).toBe(`phone#${SENDER}`);
    expect(world.messages[0]?.relay_sender_key).not.toBe(contactIdForPhone(SENDER));
  });

  it('gives ONE contact owning TWO member numbers two distinct slots and attributions', async () => {
    // relayMemberKey prefers contactId, which would collapse both handsets into
    // a single delivery/attribution slot (spec 15.6).
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-two-phones',
      type: 'tenant',
      phone: SENDER,
      phones: [{ phone: SENDER }, { phone: MEMBER_B }],
    } as never);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    await signedTwilioPost(
      app,
      SMS_PATH,
      groupParams({ MessageSid: 'MMgroup0002', From: MEMBER_B, OtherRecipients0: SENDER }),
    );

    const keys = world.messages.map((m) => m.relay_sender_key);
    expect(keys).toEqual([`phone#${SENDER}`, `phone#${MEMBER_B}`]);
    expect(new Set(keys).size).toBe(2);
    // Both messages landed on the SAME thread - the roster is identical either way.
    expect(world.messages.every((m) => m.conversationId === GROUP_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T3.5 - consent + keywords
// ---------------------------------------------------------------------------
describe('group detection: consent and keywords (T3.5)', () => {
  it('PLAIN group inbound creates ZERO conversations besides the group thread', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect([...world.conversations.keys()]).toEqual([GROUP_ID]);
  });

  it('group HELP creates ZERO extra conversations and sends NO reply', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, groupParams({ Body: 'HELP' }));

    expect([...world.conversations.keys()]).toEqual([GROUP_ID]);
    expect(res.text).toContain('<Response/>');
    expect(res.text).not.toContain('<Message>');
  });

  it('group STOP materializes the SENDER 1:1 and suppresses there, never on the group', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, groupParams({ Body: 'STOP' }));

    // Exactly ONE extra conversation: the sender's own 1:1.
    const ids = [...world.conversations.keys()];
    expect(ids).toHaveLength(2);
    const oneToOneId = ids.find((id) => id !== GROUP_ID)!;
    expect(world.optOutSets).toEqual([{ conversationId: oneToOneId, value: true }]);
    expect(groupThread(world)!.sms_opt_out).toBeUndefined();
    // The app sends NOTHING on a group keyword in v1.
    expect(res.text).not.toContain(STOP_CONFIRMATION);
    expect(res.text).toContain('<Response/>');
  });

  it('group STOP flags the CONTACT when the sender number is their primary', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams({ Body: 'STOP' }));

    expect(world.flagWrites).toEqual([
      { contactId: contactIdForPhone(SENDER), flag: 'sms_opt_out', value: true },
    ]);
  });

  it('group START restores the sender independently', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams({ Body: 'STOP' }));
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002', Body: 'START' }));

    expect(world.flagWrites.map((f) => f.value)).toEqual([true, false]);
    expect(world.optOutSets.map((o) => o.value)).toEqual([true, false]);
  });

  it('a group keyword audit carries the GROUP provenance', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams({ Body: 'STOP' }));

    const entry = world.auditEvents.find((e) => e.event_type === 'sms_opt_out_recorded')!;
    expect(entry.payload).toMatchObject({ groupConversationId: GROUP_ID, via: 'group_text' });
  });

  it('a PLAIN group inbound still stamps inbound_text consent on an EXISTING contact', async () => {
    // The consent call is never suppressed for groups - only the reply is.
    const world = createFakeWorld();
    world.contacts.push({ contactId: 'c-known', type: 'tenant', phone: SENDER } as never);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.contacts.find((c) => c.contactId === 'c-known')?.consent_method).toBe(
      'inbound_text',
    );
  });

  it('stamps the SENDER even when the byPhone index has not caught up with their own new stub', async () => {
    // THE LIVE DEFECT (S9, fix wave 5). The sender's stub is minted by
    // resolveGroupMembers in THIS request, so a `findByPhone` GSI read for the
    // sender legitimately returns nothing - and the consent stamp, guarded on
    // the contact being present, silently no-ops. Live dev left the sender with
    // `group_participation_at` and NO `consent_method`, which JIT-gates the next
    // proactive 1:1 to somebody who already texted us.
    //
    // This test FAILS if the sender lookup goes back through the index.
    const world = createFakeWorld();
    withLaggingPhoneIndex(world, GROUP_ROSTER);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    const byId = new Map(world.contacts.map((c) => [c.contactId, c]));
    const sender = byId.get(contactIdForPhone(SENDER));
    expect(sender?.consent_method).toBe('inbound_text');
    expect(typeof sender?.consent_at).toBe('string');
    // The asymmetry survives the fix: a lagging index must not widen consent to
    // the silent members either.
    expect(byId.get(contactIdForPhone(MEMBER_B))?.consent_method).toBeUndefined();
    expect(byId.get(contactIdForPhone(MEMBER_C))?.consent_method).toBeUndefined();
  });

  it('attributes the message from the ROSTER contact when the byPhone index is lagging', async () => {
    // The SECOND effect of the same undefined read: `author` is derived from the
    // sender contact, so a known landlord's group message arrived attributed
    // `unknown` (Cameron saw it live). The thread roster already names the real
    // contactId, and a point read on it answers immediately.
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-landlord',
      type: 'landlord',
      phone: SENDER,
      consent_method: 'inbound_text',
    } as never);
    const gate = withLaggingPhoneIndex(world, [SENDER]);
    const { app } = makeWebhookHarness({ world });

    // First inbound with a healthy index: the thread is created and its roster
    // records the landlord's real contactId.
    gate.on = false;
    await signedTwilioPost(app, SMS_PATH, groupParams());
    expect(
      groupThread(world)!.participants?.find((p) => p.phone === SENDER)?.contactId,
    ).toBe('c-landlord');

    // Now the index goes dark for the sender.
    gate.on = true;
    await signedTwilioPost(app, SMS_PATH, groupParams({ MessageSid: 'MMgroup0002', Body: 'again' }));

    const second = world.messages.find((m) => m.provider_sid === 'MMgroup0002');
    expect(second?.author).toBe('landlord');
  });

  it('runs the sender touchPhoneLastSeen exactly as a 1:1 does', async () => {
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-known',
      type: 'tenant',
      phone: SENDER,
      phones: [{ phone: SENDER, lastSeenAt: '2026-01-01T00:00:00.000Z' }],
    } as never);
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    const phones = world.contacts.find((c) => c.contactId === 'c-known')?.phones as
      | { phone: string; lastSeenAt?: string }[]
      | undefined;
    expect(phones?.[0]?.lastSeenAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// T3.6 - media
// ---------------------------------------------------------------------------
describe('group detection: media (T3.6)', () => {
  it('mirrors inbound MMS media under the GROUP conversationId', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      groupParams({
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME1',
        MediaContentType0: 'image/jpeg',
      }),
    );

    expect(world.mediaPuts).toHaveLength(1);
    expect(world.mediaPuts[0]?.key).toBe(`media/${GROUP_ID}/MMgroup0001/0`);
    expect(world.messages[0]?.type).toBe('mms');
    expect(world.messages[0]?.media_attachments?.[0]?.s3Key).toBe(
      `media/${GROUP_ID}/MMgroup0001/0`,
    );
  });

  it('RECOVERS the media on a redelivery after a failed first mirror', async () => {
    // `mirrorInboundMedia` catches PER ATTACHMENT and never throws, so a Twilio
    // media 404 or an S3 5xx leaves the row with no attachment and the webhook
    // still answers 200. Twilio then redelivers the same MessageSid - and
    // Twilio's media URLs expire, so a redelivery that skipped the mirror on
    // `deduped` alone would lose the photo PERMANENTLY. The 1:1 path gates on
    // COMPLETENESS instead; this proves the group path does too.
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const mediaUrl = 'https://api.twilio.com/media/ME1';
    const params = groupParams({
      NumMedia: '1',
      MediaUrl0: mediaUrl,
      MediaContentType0: 'image/jpeg',
    });

    world.failMediaUrls.add(mediaUrl);
    await signedTwilioPost(app, SMS_PATH, params);
    expect(world.mediaPuts).toHaveLength(0);
    expect(world.messages[0]?.media_attachments ?? []).toHaveLength(0);

    world.failMediaUrls.delete(mediaUrl);
    await signedTwilioPost(app, SMS_PATH, params);

    // Still ONE message (the append deduped), now WITH its attachment.
    expect(world.messages).toHaveLength(1);
    expect(world.mediaPuts).toHaveLength(1);
    expect(world.messages[0]?.media_attachments?.[0]?.s3Key).toBe(
      `media/${GROUP_ID}/MMgroup0001/0`,
    );
  });

  it('does NOT re-mirror when the first pass already stored every attachment', async () => {
    const world = createFakeWorld();
    const { app } = makeWebhookHarness({ world });
    const params = groupParams({
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/ME1',
      MediaContentType0: 'image/jpeg',
    });

    await signedTwilioPost(app, SMS_PATH, params);
    await signedTwilioPost(app, SMS_PATH, params);

    expect(world.mediaPuts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// T3.7 - tripwire
// ---------------------------------------------------------------------------
describe('group detection: envelope tripwire (T3.7)', () => {
  it('files an MM/no-media/no-envelope inbound as 1:1 with the marker and a WARN', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({ MessageSid: 'MMsuspect0001', NumMedia: '0' }),
    );

    // FAIL OPEN: never lose a message.
    expect(res.status).toBe(200);
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    const warn = capture.atLevel(WARN).find((l) => l['event'] === 'group_envelope_missing');
    expect(warn).toBeDefined();
    expect(warn?.['suppressedCount']).toBe(0);
    // Deliberately NOT an ERROR - that channel feeds the production alarm and a
    // subject-only 1:1 MMS legitimately matches this shape.
    expect(capture.atLevel(ERROR).some((l) => l['event'] === 'group_envelope_missing')).toBe(false);
  });

  it('RATE-LIMITS the tripwire WARN instead of flooding on every inbound', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    for (let i = 0; i < 4; i++) {
      await signedTwilioPost(
        app,
        SMS_PATH,
        inboundSmsParams({ MessageSid: `MMsuspect000${i}`, NumMedia: '0' }),
      );
    }

    expect(capture.atLevel(WARN).filter((l) => l['event'] === 'group_envelope_missing')).toHaveLength(
      1,
    );
    expect(world.messages).toHaveLength(4);
    expect(world.messages.every((m) => m.group_ambiguous_origin === true)).toBe(true);
  });

  it('does NOT trip on an ordinary SM-prefixed inbound', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, inboundSmsParams());

    expect(world.messages[0]?.group_ambiguous_origin).toBeUndefined();
    expect(capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_missing')).toBe(false);
  });

  it('does NOT trip on a real MMS that carries media', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({
        MessageSid: 'MMreal0001',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/media/ME1',
        MediaContentType0: 'image/jpeg',
      }),
    );

    expect(world.messages[0]?.group_ambiguous_origin).toBeUndefined();
    expect(capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_missing')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix wave 1 - the roster-shrinking and roster-divergence tripwires
// ---------------------------------------------------------------------------
describe('group detection: loud failures', () => {
  it('REFUSES the group branch when the pool-number read fails with no cached list', async () => {
    // COLD START. The stale-if-error cache has nothing to be stale WITH, and
    // installing an empty exclusion set would (a) do the exact silent shrink the
    // cache comment forbids and (b) silence poolNumbersInEnvelope, which is
    // computed from the same set. A wrong group id is permanent data; a 1:1
    // refile is recoverable, so this fails 1:1 WITH the marker.
    const world = createFakeWorld();
    world.poolNumbersRepo = {
      async listActive() {
        throw new Error('ProvisionedThroughputExceededException');
      },
    };
    const { app, capture } = makeWebhookHarness({ world });

    const res = await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(res.status).toBe(200);
    // No group thread was minted from an incomplete exclusion set.
    expect(groupThread(world)).toBeUndefined();
    // The message is NOT lost (invariant 13.3) and it is MARKED (invariant 13.1).
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
    expect(
      capture.atLevel(ERROR).some((l) => l['event'] === 'group_exclusions_unavailable'),
    ).toBe(true);
  });

  it('REFUSES the group branch when the OtherRecipients scan truncates at the cap', async () => {
    // The one roster-SHRINKING condition that used to WARN and then mint a
    // thread anyway - under an id its own log line called WRONG. The two
    // sibling shrinking conditions (unparseable address, cold-start exclusion
    // failure) both REFUSE, and this is the same fact pattern: file 1:1 with
    // the marker, which is recoverable, rather than forking the thread
    // permanently.
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    const wide: Record<string, string> = {};
    for (let i = 0; i <= 32; i++) wide[`OtherRecipients${i}`] = `+1555010${4000 + i}`;
    wide['OtherRecipients33'] = '+15550104099';

    await signedTwilioPost(app, SMS_PATH, groupParams(wide));

    const warn = capture.atLevel(WARN).find((l) => l['event'] === 'group_envelope_truncated');
    expect(warn).toBeDefined();
    expect(warn?.['maxIndex']).toBe(32);
    // No thread minted under the SHORT roster's id, and the message is filed
    // 1:1 with the extraction marker (invariants 13.1 + 13.3).
    const shortRoster = [SENDER, ...Object.values(wide)].filter(
      (p) => p !== '+15550104099',
    );
    expect(world.conversations.get(conversationIdForGroup(shortRoster))).toBeUndefined();
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
  });

  it('catches a SPARSE envelope that skips the probe index (the scanner is gap-tolerant)', async () => {
    // The cap check used to probe exactly OtherRecipients33 and argue that a
    // gap-tolerant scan made one probe enough. Gap-tolerance says the OPPOSITE:
    // the envelope may be sparse, so a next-populated-index of 34 truncated in
    // silence - the exact condition the tripwire exists for.
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    const wide: Record<string, string> = {};
    for (let i = 0; i <= 32; i++) wide[`OtherRecipients${i}`] = `+1555010${4000 + i}`;
    wide['OtherRecipients34'] = '+15550104099'; // 33 deliberately absent

    await signedTwilioPost(app, SMS_PATH, groupParams(wide));

    expect(
      capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_truncated'),
    ).toBe(true);
    expect(world.messages[0]?.group_ambiguous_origin).toBe(true);
  });

  it('a REDELIVERY never re-classifies: no phantom group thread after a 1:1 first delivery', async () => {
    // The cold-start refusal is the one TRANSIENT fail-open path in the feature,
    // so one MessageSid could be filed 1:1 on delivery 1 (pool read down) and
    // classified GROUP on delivery 2. The group thread was then minted, the
    // append deduped against the 1:1 row, and touchLastActivity dressed the new
    // thread with a preview of a message it does not contain.
    const world = createFakeWorld();
    let poolReads = 0;
    const realListActive = world.poolNumbersRepo.listActive.bind(world.poolNumbersRepo);
    world.poolNumbersRepo = {
      async listActive() {
        poolReads += 1;
        if (poolReads === 1) throw new Error('ProvisionedThroughputExceededException');
        return realListActive();
      },
    };
    const { app, capture } = makeWebhookHarness({ world });

    // Delivery 1: refused, filed into the sender's 1:1 with the marker.
    await signedTwilioPost(app, SMS_PATH, groupParams());
    // Delivery 2: Twilio redelivers the SAME MessageSid; the pool read is healthy.
    await signedTwilioPost(app, SMS_PATH, groupParams());

    // The first delivery's filing stands, and no phantom thread exists.
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).not.toBe(GROUP_ID);
    expect(groupThread(world)).toBeUndefined();
    expect(
      capture
        .atLevel(ERROR)
        .some((l) => l['event'] === 'group_inbound_already_filed_elsewhere'),
    ).toBe(true);
  });

  it('an ORDINARY redelivery of a group message still files onto its own thread', async () => {
    // The control for the guard above: same sid twice, both classified group.
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());
    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]?.conversationId).toBe(GROUP_ID);
    expect(groupThread(world)).toBeDefined();
    expect(
      capture
        .atLevel(ERROR)
        .some((l) => l['event'] === 'group_inbound_already_filed_elsewhere'),
    ).toBe(false);
  });

  it('does NOT warn about truncation on an ordinary two-member envelope', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(capture.atLevel(WARN).some((l) => l['event'] === 'group_envelope_truncated')).toBe(
      false,
    );
  });

  it('ERRORs when the sender is not on the resolved thread roster', async () => {
    // The workbook-`drop` shape reaching the runtime: the thread was written
    // under the FULL-set id but carries a TRUNCATED roster, so the sender is a
    // non-member of the thread its own message lands on. Report, never repair -
    // a silent re-key would change thread identity.
    const world = createFakeWorld();
    world.conversations.set(GROUP_ID, {
      conversationId: GROUP_ID,
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      participants: [
        { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
        { contactId: contactIdForPhone(MEMBER_C), phone: MEMBER_C },
      ],
      ai_mode: 'manual',
      last_activity_at: '2026-08-01T00:00:00.000Z',
      created_at: '2026-08-01T00:00:00.000Z',
    } as ConversationItem);
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    // The message is still correctly filed BY ID - the roster is what is wrong.
    expect(world.messages[0]?.conversationId).toBe(GROUP_ID);
    const err = capture.atLevel(ERROR).find((l) => l['event'] === 'group_sender_not_on_roster');
    expect(err).toBeDefined();
    expect(err?.['rosterMatchesId']).toBe(false);
  });

  it('says NOTHING about the roster when the sender IS on it', async () => {
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({ world });

    await signedTwilioPost(app, SMS_PATH, groupParams());

    expect(
      capture.atLevel(ERROR).some((l) => l['event'] === 'group_sender_not_on_roster'),
    ).toBe(false);
  });

  it('says NOTHING when the sender is one of OUR OWN excluded org numbers', async () => {
    // THE CORRECTLY-CONFIGURED STEADY STATE (spec 4.1, r3 finding 9). The
    // exclusion set exists to subtract the org's OTHER numbers, so when the
    // founder texts one of her own groups from the office line the sender is
    // CORRECTLY absent from the roster. Alarming on it at ERROR - the channel
    // that feeds the production alarm - would fire on ordinary staff traffic
    // across all 132 groups and bury the one alarm that means imported-roster
    // corruption. The roster here is perfect: it hashes to its own id.
    const OFFICE_LINE = '+15550100777';
    const world = createFakeWorld();
    const { app, capture } = makeWebhookHarness({
      world,
      env: { GROUP_IDENTITY_EXCLUDED_NUMBERS: OFFICE_LINE },
    });

    await signedTwilioPost(
      app,
      SMS_PATH,
      inboundSmsParams({
        MessageSid: 'MMoffice0001',
        From: OFFICE_LINE,
        OtherRecipients0: MEMBER_B,
        OtherRecipients1: MEMBER_C,
      }),
    );

    const thread = world.conversations.get(conversationIdForGroup([MEMBER_B, MEMBER_C]));
    expect(thread).toBeDefined();
    expect((thread?.participants ?? []).map((p) => p.phone).sort()).toEqual(
      [MEMBER_B, MEMBER_C].sort(),
    );
    expect(
      capture.atLevel(ERROR).some((l) => l['event'] === 'group_sender_not_on_roster'),
    ).toBe(false);
  });
});
