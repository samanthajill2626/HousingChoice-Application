// M1.4 integration tests against DynamoDB Local — the new persistence:
//   - settingsRepo: defaults when absent, field-level merge on putOrgSettings
//   - usersRepo push-subscription ARRAY writes: add (dedupe + cap), remove
//   - conversation-type propagation: contactsRepo.update + conversationsRepo
//     findByParticipantPhone/setType (the triage seam) on real conditional
//     writes
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAuditRepo } from '../src/repos/auditRepo.js';
import { createContactsRepo } from '../src/repos/contactsRepo.js';
import { createConversationsRepo, type ConversationItem } from '../src/repos/conversationsRepo.js';
import {
  createSettingsRepo,
  DEFAULT_ORG_SETTINGS,
} from '../src/repos/settingsRepo.js';
import { createUsersRepo, MAX_PUSH_SUBSCRIPTIONS, type PushSubscriptionRecord } from '../src/repos/usersRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(
    `[m14.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

function pushSub(endpointUrl: string, createdAt: string): PushSubscriptionRecord {
  return { endpoint: endpointUrl, keys: { p256dh: `p-${endpointUrl}`, auth: `a-${endpointUrl}` }, created_at: createdAt };
}

describe.skipIf(!reachable)('M1.4 persistence against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const settings = createSettingsRepo(repoDeps);
  const users = createUsersRepo(repoDeps);
  const contacts = createContactsRepo(repoDeps);
  const conversations = createConversationsRepo(repoDeps);
  const audit = createAuditRepo(repoDeps);

  const bases = ['settings', 'users', 'contacts', 'conversations', 'audit_events'] as const;

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  describe('settingsRepo', () => {
    it('returns CO2 defaults when no item exists', async () => {
      const s = await settings.getOrgSettings();
      expect(s).toEqual(DEFAULT_ORG_SETTINGS);
    });

    it('putOrgSettings merges field-level (an omitted field is untouched)', async () => {
      await settings.putOrgSettings({ missedCallAutoTextEnabled: false });
      let s = await settings.getOrgSettings();
      expect(s.missedCallAutoTextEnabled).toBe(false);
      // quickReplies still the default (not blanked by a partial patch).
      expect(s.quickReplies).toEqual(DEFAULT_ORG_SETTINGS.quickReplies);

      await settings.putOrgSettings({ missedCallAutoText: 'Updated text' });
      s = await settings.getOrgSettings();
      expect(s.missedCallAutoText).toBe('Updated text');
      expect(s.missedCallAutoTextEnabled).toBe(false); // prior patch preserved
      // An item written WITHOUT preRingPauseSeconds (the prior patches never set
      // it) reads back as the 2s default — existing records keep working.
      expect(s.preRingPauseSeconds).toBe(2);
    });

    it('persists preRingPauseSeconds and merges it field-level', async () => {
      await settings.putOrgSettings({ preRingPauseSeconds: 6 });
      let s = await settings.getOrgSettings();
      expect(s.preRingPauseSeconds).toBe(6);

      // A later unrelated patch leaves the pause untouched (field-level merge).
      await settings.putOrgSettings({ missedCallAutoTextEnabled: true });
      s = await settings.getOrgSettings();
      expect(s.preRingPauseSeconds).toBe(6);
    });

    it('welcomeText: set projects it; null CLEARS it (REMOVE) so it is absent again', async () => {
      // Set a custom welcomeText — it rides the GET projection.
      await settings.putOrgSettings({ welcomeText: 'Hi {firstName}, welcome!' });
      let s = await settings.getOrgSettings();
      expect(s.welcomeText).toBe('Hi {firstName}, welcome!');

      // A null CLEAR issues a DynamoDB REMOVE — the attribute is deleted, so the
      // projection no longer carries welcomeText (public.ts falls back to default).
      await settings.putOrgSettings({ welcomeText: null });
      s = await settings.getOrgSettings();
      expect(s.welcomeText).toBeUndefined();
      expect('welcomeText' in s).toBe(false);

      // The REMOVE is field-level too: other fields survive the clear.
      expect(s.preRingPauseSeconds).toBe(6);
    });
  });

  describe('usersRepo push-subscription array writes', () => {
    it('adds (deduping by endpoint) and removes subscriptions', async () => {
      const { user } = await users.invite({ email: `push-${randomUUID()}@housingchoice.org`, role: 'admin' });
      const userId = user.userId;

      await users.addPushSubscription(userId, pushSub('https://push/a', '2026-06-01T00:00:00.000Z'));
      await users.addPushSubscription(userId, pushSub('https://push/b', '2026-06-02T00:00:00.000Z'));
      // Re-add /a (dedupe by endpoint) — count stays 2.
      const afterDedupe = await users.addPushSubscription(
        userId,
        pushSub('https://push/a', '2026-06-03T00:00:00.000Z'),
      );
      expect(afterDedupe.map((s) => s.endpoint).sort()).toEqual(['https://push/a', 'https://push/b']);

      const afterRemove = await users.removePushSubscription(userId, 'https://push/a');
      expect(afterRemove.map((s) => s.endpoint)).toEqual(['https://push/b']);
      // Removing an absent endpoint is a no-op.
      const stillB = await users.removePushSubscription(userId, 'https://push/absent');
      expect(stillB.map((s) => s.endpoint)).toEqual(['https://push/b']);
    });

    it('caps at MAX_PUSH_SUBSCRIPTIONS, dropping the OLDEST (LRU by created_at)', async () => {
      const { user } = await users.invite({ email: `cap-${randomUUID()}@housingchoice.org`, role: 'va' });
      const userId = user.userId;
      // Add MAX+3, each newer than the last.
      for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS + 3; i++) {
        const ts = `2026-06-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`;
        await users.addPushSubscription(userId, pushSub(`https://push/${i}`, ts));
      }
      const fresh = await users.findById(userId);
      expect(fresh?.push_subscriptions).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
      // The three OLDEST (0,1,2) are dropped; the newest remain.
      const endpoints = fresh?.push_subscriptions?.map((s) => s.endpoint) ?? [];
      expect(endpoints).not.toContain('https://push/0');
      expect(endpoints).toContain(`https://push/${MAX_PUSH_SUBSCRIPTIONS + 2}`);
    });
  });

  describe('usersRepo remove (hard delete)', () => {
    it('deletes the row and frees the key for a clean re-invite of the same email', async () => {
      const email = `remove-${randomUUID()}@housingchoice.org`;
      const { user, created } = await users.invite({ email, role: 'va' });
      expect(created).toBe(true);
      expect(await users.findById(user.userId)).toBeDefined();

      // Hard delete -> the row is gone.
      await users.remove(user.userId);
      expect(await users.findById(user.userId)).toBeUndefined();

      // Re-invite the SAME email -> same deterministic key, created:true again.
      const again = await users.invite({ email, role: 'admin' });
      expect(again.created).toBe(true);
      expect(again.user.userId).toBe(user.userId);
      expect(again.user.role).toBe('admin');

      // remove is idempotent -- deleting an absent id is a no-op (does not throw).
      await users.remove('usr_doesnotexist000000000');
    });
  });

  describe('conversation-type propagation (triage seam)', () => {
    it('contactsRepo.update merges, and setType flips the linked unknown_1to1 thread', async () => {
      const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
      const contactId = `contact-${randomUUID()}`;
      const conversationId = `conv-${randomUUID()}`;

      await contacts.createIfAbsent({
        contactId,
        type: 'unknown',
        status: 'needs_review',
        phone,
        created_at: new Date().toISOString(),
      });
      const conv: ConversationItem = {
        conversationId,
        participant_phone: phone,
        status: 'open',
        last_activity_at: new Date().toISOString(),
        type: 'unknown_1to1',
        ai_mode: 'auto',
        created_at: new Date().toISOString(),
        participants: [{ contactId, phone }],
      };
      await conversations.createOrGetByParticipantPhone(phone, 'unknown_1to1');
      // Use the real row the repo created (it owns the id); set our known type/link.
      const created = (await conversations.findByParticipantPhone(phone)).find(
        (c) => c.status === 'open',
      );
      expect(created).toBeDefined();
      const realConvId = created!.conversationId;
      void conv;

      // Triage: set the contact type to tenant (merge — name untouched if absent).
      const updated = await contacts.update(contactId, { type: 'tenant', firstName: 'Keisha' });
      expect(updated.type).toBe('tenant');
      expect(updated.firstName).toBe('Keisha');

      // Propagate to the linked thread(s) — setType now returns ALL_NEW.
      const linked = await conversations.findByParticipantPhone(phone);
      for (const c of linked) {
        if (c.type === 'unknown_1to1') {
          const fresh = await conversations.setType(c.conversationId, 'tenant_1to1');
          expect(fresh.type).toBe('tenant_1to1'); // ALL_NEW returns the post-update item
        }
      }
      const after = await conversations.getById(realConvId);
      expect(after?.type).toBe('tenant_1to1');
    });

    it('applyTriage flips type AND denormalizes participant_display_name in one write (ALL_NEW)', async () => {
      const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
      await conversations.createOrGetByParticipantPhone(phone, 'unknown_1to1');
      const created = (await conversations.findByParticipantPhone(phone)).find(
        (c) => c.status === 'open',
      );
      expect(created).toBeDefined();
      const convId = created!.conversationId;

      // Type + name together (the triage resolve-identity path).
      const resolved = await conversations.applyTriage(convId, {
        type: 'tenant_1to1',
        displayName: 'Keisha Jones',
      });
      expect(resolved.type).toBe('tenant_1to1');
      expect(resolved.participant_display_name).toBe('Keisha Jones');

      // Name-only (no type change): the stored type is preserved, name updated.
      const renamed = await conversations.applyTriage(convId, { displayName: 'Keisha J Jones' });
      expect(renamed.type).toBe('tenant_1to1'); // untouched
      expect(renamed.participant_display_name).toBe('Keisha J Jones');

      // displayName: null leaves the name untouched (honesty: never blanked here).
      const unchanged = await conversations.applyTriage(convId, {
        type: 'landlord_1to1',
        displayName: null,
      });
      expect(unchanged.type).toBe('landlord_1to1');
      expect(unchanged.participant_display_name).toBe('Keisha J Jones'); // preserved
    });

    it('triage PATCH end-to-end: contactsRepo.update auto-advances status to active', async () => {
      // The route layer adds status:'active'; assert the repo write the route
      // makes lands the contact off the needs_review queue.
      const phone = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
      const contactId = `contact-${randomUUID()}`;
      await contacts.createIfAbsent({
        contactId,
        type: 'unknown',
        status: 'needs_review',
        phone,
        created_at: new Date().toISOString(),
      });
      // Mirror the route's auto-advance patch (type resolved → status active).
      const updated = await contacts.update(contactId, {
        type: 'tenant',
        firstName: 'Keisha',
        lastName: 'Jones',
        status: 'active',
      });
      expect(updated.status).toBe('active');
      expect(updated.type).toBe('tenant');
    });
  });

  describe('auditRepo byActor GSI (M1)', () => {
    it('lifts payload.actor to a top-level actorId so "all actions by actor X" is queryable', async () => {
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
      const actor = `usr_${randomUUID().slice(0, 16)}`;

      // Append events for this actor (the convention: actor inside payload).
      await audit.append('users#target-1', 'role_changed', { from: 'va', to: 'admin', actor });
      await audit.append('contacts#c-1', 'contact_updated', { fields: ['type'], actor });
      // A system event with NO actor must stay OFF the sparse GSI.
      await audit.append('conversations#conv-1', 'assignment_changed', { from: null, to: 'x' });

      const { Items } = await doc.send(
        new QueryCommand({
          TableName: tableName('audit_events', testEnv),
          IndexName: 'byActor',
          KeyConditionExpression: 'actorId = :a',
          ExpressionAttributeValues: { ':a': actor },
        }),
      );
      const items = (Items ?? []) as {
        actorId: string;
        event_type: string;
        payload: Record<string, unknown>;
      }[];
      // BOTH of this actor's events come back via the GSI (the actorless one does not).
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.actorId === actor)).toBe(true);
      expect(items.map((i) => i.event_type).sort()).toEqual(['contact_updated', 'role_changed']);
      // The actor also stays in the payload (call sites/tests read it there).
      const roleChange = items.find((i) => i.event_type === 'role_changed')!;
      expect(roleChange.payload).toMatchObject({ from: 'va', to: 'admin', actor });
    });
  });
});
