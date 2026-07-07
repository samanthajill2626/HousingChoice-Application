// fake-twilio/test/engineGroups.test.ts
//
// Relay-group inference (spec §4): traffic-derived groups ALONGSIDE the thread
// store (pool legs still land in the recipient persona's 1:1 thread exactly as
// before — the group transcript is an additional view).
// - outbound leg with a non-app `from` ⇒ `from` is a pool number → group
// - sendAsParty with an explicit non-app `to` ⇒ `to` is a pool number → group
// - same-(body,media) legs within the rolling burst window collapse into ONE
//   entry with per-recipient delivery slots; each leg keeps its own SID so the
//   existing status-callback flow advances exactly its slot
// - roster = recipients(most recent burst) ∪ senders(inbound since the PREVIOUS
//   burst started) — SET semantics with the load-bearing sender union (§4.3)
// - APP_NUMBER traffic never creates or touches a group (both directions)
import { describe, expect, it } from 'vitest';
import { FakeTwilioEngine, type EngineEvent } from '../src/engine/engine.js';
import { EventHub } from '../src/engine/eventHub.js';
import { ManualClock } from '../src/engine/clock.js';
import { BURST_WINDOW_MS } from '../src/engine/groups.js';
import type { WebhookParams } from '../src/engine/signer.js';

const POOL = '+15550160001';
const APP = '+15550009999';
const MEMBER_A = '+15550170001';
const MEMBER_B = '+15550170002';
const MEMBER_C = '+15550170003';
const TASHA = '+15550100001'; // seeded persona 'Tasha Nguyen (tenant)'

function makeEngine() {
  const clock = new ManualClock('2026-06-15T00:00:00.000Z');
  const posted: Array<{ path: string; params: WebhookParams }> = [];
  const dispatcher = { post: async (path: string, params: WebhookParams) => { posted.push({ path, params }); return 200; } };
  const engine = new FakeTwilioEngine({ clock, dispatcher, hub: new EventHub() });
  const events: EngineEvent[] = [];
  engine.subscribe((e) => events.push(e));
  return { engine, clock, posted, events };
}

/** One fan-out leg from the pool, exactly as the REST route records it. */
function poolLeg(engine: FakeTwilioEngine, to: string, body: string): string {
  return engine.recordOutboundFromApp({ to, from: POOL, body });
}

describe('relay-group inference (engine)', () => {
  it('a group is born from an outbound pool leg; the pool number never becomes a persona', () => {
    const { engine } = makeEngine();
    poolLeg(engine, MEMBER_A, 'Group intro');
    const groups = engine.listGroups();
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g).toMatchObject({ poolNumber: POOL, lastActivityAt: '2026-06-15T00:00:00.000Z' });
    // Unknown recipients auto-register exactly as today → bare-number label.
    expect(g?.members).toEqual([{ number: MEMBER_A, label: MEMBER_A }]);
    expect(g?.entries).toHaveLength(1);
    const entry = g?.entries[0];
    expect(entry).toMatchObject({ kind: 'outbound', body: 'Group intro' });
    if (entry?.kind === 'outbound') {
      expect(entry.recipients).toHaveLength(1);
      expect(entry.recipients[0]).toMatchObject({ number: MEMBER_A, state: 'queued' });
      expect(entry.recipients[0]?.sid).toMatch(/^SM/);
    }
    // Only the recipient auto-registers; the pool `from` is NOT a persona.
    expect(engine.list().find((p) => p.number === POOL)).toBeUndefined();
    expect(engine.list().find((p) => p.number === MEMBER_A)).toMatchObject({ label: MEMBER_A, role: 'unknown' });
  });

  it('a group is born from an inbound sendAsParty to a pool; the sendAsParty contract itself is unchanged', async () => {
    const { engine, posted } = makeEngine();
    const sid = await engine.sendAsParty({ from: TASHA, to: POOL, body: 'hi group' });
    const g = engine.listGroups()[0];
    expect(g).toMatchObject({ poolNumber: POOL });
    expect(g?.members).toEqual([{ number: TASHA, label: 'Tasha Nguyen (tenant)' }]);
    expect(g?.entries[0]).toMatchObject({
      kind: 'inbound', id: sid, from: TASHA, fromLabel: 'Tasha Nguyen (tenant)', body: 'hi group',
    });
    // UNCHANGED contract: the message still lands in the SENDER's single 1:1 thread…
    const thread = engine.listThreads().find((t) => t.partyNumber === TASHA);
    expect(thread?.messages[0]).toMatchObject({ direction: 'inbound', from: TASHA, to: POOL, body: 'hi group' });
    // …and the inbound webhook still posts with To = pool, as today.
    expect(posted[0]?.path).toBe('/webhooks/twilio/sms');
    expect(posted[0]?.params).toMatchObject({ From: TASHA, To: POOL, Body: 'hi group' });
  });

  it('collapses identical-body legs within the burst window into ONE entry with per-recipient slots', () => {
    const { engine, clock } = makeEngine();
    const sid1 = poolLeg(engine, MEMBER_A, 'Renee C.: tour at 3pm');
    clock.advance(1000); // fan-out legs arrive ~1/s (app token bucket)
    const sid2 = poolLeg(engine, MEMBER_B, 'Renee C.: tour at 3pm');
    clock.advance(1000);
    const sid3 = poolLeg(engine, MEMBER_C, 'Renee C.: tour at 3pm');
    const g = engine.listGroups()[0];
    expect(g?.entries).toHaveLength(1);
    const entry = g?.entries[0];
    expect(entry?.kind).toBe('outbound');
    if (entry?.kind === 'outbound') {
      // Each leg keeps its own SID + delivery slot.
      expect(entry.recipients.map((r) => r.sid)).toEqual([sid1, sid2, sid3]);
      expect(entry.recipients.map((r) => r.number)).toEqual([MEMBER_A, MEMBER_B, MEMBER_C]);
      expect(new Set(entry.recipients.map((r) => r.sid)).size).toBe(3);
    }
    expect(g?.members.map((m) => m.number)).toEqual([MEMBER_A, MEMBER_B, MEMBER_C]);
    expect(g?.lastActivityAt).toBe('2026-06-15T00:00:02.000Z');
  });

  it('status callbacks advance exactly the matching recipient slot (per-sid wiring)', () => {
    const { engine, clock, events } = makeEngine();
    engine.setDeliveryOutcome({
      partyNumber: MEMBER_B,
      profile: { kind: 'fail', failState: 'undelivered', errorCode: '30005' },
    });
    poolLeg(engine, MEMBER_A, 'same body');
    clock.advance(1000);
    poolLeg(engine, MEMBER_B, 'same body');
    const groupEventsBefore = events.filter((e) => e.type === 'group.updated').length;
    clock.flush();
    // Delivery-slot advances also emit group.updated (chips move live).
    const groupEventsAfter = events.filter((e) => e.type === 'group.updated').length;
    expect(groupEventsAfter).toBeGreaterThan(groupEventsBefore);
    const entry = engine.listGroups()[0]?.entries[0];
    expect(entry?.kind).toBe('outbound');
    if (entry?.kind === 'outbound') {
      const slotA = entry.recipients.find((r) => r.number === MEMBER_A);
      const slotB = entry.recipients.find((r) => r.number === MEMBER_B);
      expect(slotA).toMatchObject({ state: 'delivered' });
      expect(slotA?.errorCode).toBeUndefined();
      expect(slotB).toMatchObject({ state: 'undelivered', errorCode: '30005' });
    }
    // The last emitted snapshot carries the final slot states.
    const last = [...events].reverse().find((e) => e.type === 'group.updated');
    expect(last).toBeDefined();
    if (last?.type === 'group.updated') {
      const emitted = last.group.entries[0];
      if (emitted?.kind === 'outbound') {
        expect(emitted.recipients.find((r) => r.number === MEMBER_B)).toMatchObject({
          state: 'undelivered', errorCode: '30005',
        });
      }
    }
  });

  it('differing-body legs in one burst stay separate entries but share the roster', () => {
    const { engine, clock } = makeEngine();
    poolLeg(engine, MEMBER_A, 'Welcome Diana!');
    clock.advance(1000);
    poolLeg(engine, MEMBER_B, 'Welcome Gloria!');
    const g = engine.listGroups()[0];
    expect(g?.entries).toHaveLength(2);
    expect(g?.entries.map((e) => (e.kind === 'outbound' ? e.body : undefined))).toEqual([
      'Welcome Diana!', 'Welcome Gloria!',
    ]);
    // Both legs contribute recipients to ONE roster burst.
    expect(g?.members.map((m) => m.number)).toEqual([MEMBER_A, MEMBER_B]);
  });

  it('roster is SET semantics: a member absent from the next burst disappears, a new one appears', () => {
    const { engine, clock } = makeEngine();
    poolLeg(engine, MEMBER_A, 'first burst');
    clock.advance(1000);
    poolLeg(engine, MEMBER_B, 'first burst');
    expect(engine.listGroups()[0]?.members.map((m) => m.number)).toEqual([MEMBER_A, MEMBER_B]);
    clock.advance(BURST_WINDOW_MS + 1000); // quiet gap → the next fan-out is a NEW burst
    poolLeg(engine, MEMBER_A, 'second burst');
    clock.advance(1000);
    poolLeg(engine, MEMBER_C, 'second burst');
    // B (absent from the burst) disappeared; C appeared — SET, not accumulate.
    expect(engine.listGroups()[0]?.members.map((m) => m.number)).toEqual([MEMBER_A, MEMBER_C]);
  });

  it('an inbound-only sender survives the next burst (∪ clause) and ages out after the one after', async () => {
    const { engine, clock } = makeEngine();
    // Tasha texts the group; the app's relay fan-out EXCLUDES the sender, so the
    // resulting burst goes only to A. Tasha must survive via the sender union.
    await engine.sendAsParty({ from: TASHA, to: POOL, body: 'hi all' });
    clock.advance(1000);
    poolLeg(engine, MEMBER_A, 'Tasha N.: hi all');
    expect(engine.listGroups()[0]?.members.map((m) => m.number)).toEqual([MEMBER_A, TASHA]);
    // After the burst FOLLOWING her relay (she neither received a leg nor texted
    // again — i.e. removed, or just quiet), she ages out of the roster.
    clock.advance(BURST_WINDOW_MS + 1000);
    poolLeg(engine, MEMBER_A, 'team reply after Tasha was removed');
    expect(engine.listGroups()[0]?.members.map((m) => m.number)).toEqual([MEMBER_A]);
  });

  it('reset clears groups; personas persist', () => {
    const { engine } = makeEngine();
    poolLeg(engine, MEMBER_A, 'x');
    const personasBefore = engine.list().length;
    expect(engine.listGroups()).toHaveLength(1);
    engine.reset();
    expect(engine.listGroups()).toHaveLength(0);
    expect(engine.list().length).toBe(personasBefore); // personas persist (incl. auto-registered)
  });

  it('APP_NUMBER traffic never creates a group (both directions)', async () => {
    const { engine, events } = makeEngine();
    await engine.sendAsParty({ from: TASHA, body: 'default to = app number' });
    await engine.sendAsParty({ from: TASHA, to: APP, body: 'explicit app number' });
    engine.recordOutboundFromApp({ to: TASHA, body: 'no from (defaults to app)' });
    engine.recordOutboundFromApp({ to: TASHA, from: APP, body: 'explicit app from' });
    expect(engine.listGroups()).toHaveLength(0);
    expect(events.some((e) => e.type === 'group.updated')).toBe(false);
  });

  describe('burst-window edges', () => {
    it('a same-body leg exactly AT the rolling deadline still joins the burst', () => {
      const { engine, clock } = makeEngine();
      poolLeg(engine, MEMBER_A, 'same body');
      clock.advance(BURST_WINDOW_MS); // exactly at the deadline (inclusive)
      poolLeg(engine, MEMBER_B, 'same body');
      expect(engine.listGroups()[0]?.entries).toHaveLength(1);
    });

    it('a same-body leg PAST the window starts a new entry and a new roster burst', () => {
      const { engine, clock } = makeEngine();
      poolLeg(engine, MEMBER_A, 'same body');
      clock.advance(BURST_WINDOW_MS + 1);
      poolLeg(engine, MEMBER_B, 'same body');
      const g = engine.listGroups()[0];
      expect(g?.entries).toHaveLength(2); // same body OUTSIDE the window = separate entry
      expect(g?.members.map((m) => m.number)).toEqual([MEMBER_B]); // roster reset to the new burst
    });

    it('the window is ROLLING: each leg refreshes the deadline', () => {
      const { engine, clock } = makeEngine();
      poolLeg(engine, MEMBER_A, 'same body');
      clock.advance(4000);
      poolLeg(engine, MEMBER_B, 'same body');
      clock.advance(4000); // 8s after the first leg, 4s after the last — still one burst
      poolLeg(engine, MEMBER_C, 'same body');
      expect(engine.listGroups()[0]?.entries).toHaveLength(1);
    });
  });

  it('emits group.updated (after message.appended) carrying the full recomputed snapshot', () => {
    const { engine, events } = makeEngine();
    poolLeg(engine, MEMBER_A, 'x');
    const types = events.map((e) => e.type);
    expect(types.indexOf('message.appended')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('group.updated')).toBeGreaterThan(types.indexOf('message.appended'));
    const ev = events.find((e) => e.type === 'group.updated');
    expect(ev).toBeDefined();
    if (ev?.type === 'group.updated') {
      expect(ev.group.poolNumber).toBe(POOL);
      expect(ev.group.members).toEqual([{ number: MEMBER_A, label: MEMBER_A }]);
      expect(ev.group.entries).toHaveLength(1);
      expect(ev.group.lastActivityAt).toBe('2026-06-15T00:00:00.000Z');
    }
  });
});
