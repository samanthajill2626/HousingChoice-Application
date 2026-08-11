// Number-scoped SMS suppression (group-texting T3.5).
//
// One shared reader/writer over the EXISTING storage semantics (the
// twilio.ts:664-671 precedent): the CONTACT flag suppresses a contact's PRIMARY
// number; a SECONDARY (attached) number is suppressed by its OWN 1:1 thread
// flag. Three callers bind to this module - the inbound keyword path (T3.5),
// the 21610 receipts path (T5.3), and the group roster chips (T4.3).
import { describe, expect, it, vi } from 'vitest';

import {
  applyNumberSuppression,
  numberSuppressionScope,
  readNumberSuppression,
} from '../src/services/numberSuppression.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';

const PRIMARY = '+15550100001';
const SECONDARY = '+15550100002';

function contact(over: Partial<ContactItem> = {}): ContactItem {
  return { contactId: 'c1', type: 'tenant', phone: PRIMARY, ...over } as ContactItem;
}

function thread(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: 'conv-1',
    participant_phone: PRIMARY,
    status: 'open',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    last_activity_at: '2026-08-10T00:00:00.000Z',
    ...over,
  } as ConversationItem;
}

function readRig(opts: { contact?: ContactItem | undefined; threads?: ConversationItem[] } = {}) {
  return {
    contactsRepo: { findByPhone: vi.fn(async () => opts.contact) },
    conversationsRepo: { findByParticipantPhone: vi.fn(async () => opts.threads ?? []) },
  };
}

function writeRig() {
  const flags: { contactId: string; flag: string; value: boolean }[] = [];
  const optOuts: { conversationId: string; value: boolean }[] = [];
  const audits: { entityKey: string; eventType: string; payload: Record<string, unknown> }[] = [];
  const logs: { level: string; fields: unknown }[] = [];
  return {
    flags,
    optOuts,
    audits,
    logs,
    deps: {
      contactsRepo: {
        setFlag: vi.fn(async (contactId: string, flag: string) => {
          flags.push({ contactId, flag, value: true });
        }),
        clearFlag: vi.fn(async (contactId: string, flag: string) => {
          flags.push({ contactId, flag, value: false });
        }),
      },
      conversationsRepo: {
        setSmsOptOut: vi.fn(async (conversationId: string, value: boolean) => {
          optOuts.push({ conversationId, value });
        }),
      },
      auditRepo: {
        append: vi.fn(async (entityKey: string, eventType: string, payload: Record<string, unknown>) => {
          audits.push({ entityKey, eventType, payload });
        }),
      },
      logger: {
        info: (fields: unknown) => logs.push({ level: 'info', fields }),
        warn: (fields: unknown) => logs.push({ level: 'warn', fields }),
        error: (fields: unknown) => logs.push({ level: 'error', fields }),
        debug: (fields: unknown) => logs.push({ level: 'debug', fields }),
      },
    },
  };
}

describe('numberSuppressionScope', () => {
  it('is primary when the number IS the contact scalar phone', () => {
    expect(numberSuppressionScope(PRIMARY, contact())).toBe('primary');
  });

  it('is secondary when the contact owns the number but it is not the primary', () => {
    expect(numberSuppressionScope(SECONDARY, contact())).toBe('secondary');
  });

  it('is no_contact when nothing owns the number', () => {
    expect(numberSuppressionScope(PRIMARY, undefined)).toBe('no_contact');
  });
});

describe('readNumberSuppression', () => {
  it('reports a PRIMARY number suppressed by the contact flag', async () => {
    const rig = readRig({ contact: contact({ sms_opt_out: true }) });
    await expect(readNumberSuppression(rig, PRIMARY)).resolves.toMatchObject({
      suppressed: true,
      scope: 'primary',
    });
  });

  it('does NOT let a contact flag suppress the contact SECONDARY number', async () => {
    const rig = readRig({ contact: contact({ sms_opt_out: true }) });
    await expect(readNumberSuppression(rig, SECONDARY)).resolves.toMatchObject({
      suppressed: false,
      scope: 'secondary',
    });
  });

  it('reports a SECONDARY number suppressed by its OWN 1:1 thread flag', async () => {
    const rig = readRig({
      contact: contact(),
      threads: [thread({ conversationId: 'conv-2', participant_phone: SECONDARY, sms_opt_out: true })],
    });
    await expect(readNumberSuppression(rig, SECONDARY)).resolves.toMatchObject({
      suppressed: true,
      scope: 'secondary',
    });
  });

  it('reports a contact-less number suppressed by its own thread flag', async () => {
    const rig = readRig({ threads: [thread({ sms_opt_out: true })] });
    await expect(readNumberSuppression(rig, PRIMARY)).resolves.toMatchObject({
      suppressed: true,
      scope: 'no_contact',
    });
  });

  it('is false for a clean number', async () => {
    const rig = readRig({ contact: contact(), threads: [thread()] });
    await expect(readNumberSuppression(rig, PRIMARY)).resolves.toMatchObject({ suppressed: false });
  });

  it('never treats a multi-party thread flag as a per-number suppression', async () => {
    // A group_text thread carries no participant_phone, so it cannot reach this
    // GSI - the exclusion is invariant 13.6 defense-in-depth, stated explicitly.
    const rig = readRig({
      contact: contact(),
      threads: [thread({ type: 'group_text', sms_opt_out: true })],
    });
    await expect(readNumberSuppression(rig, PRIMARY)).resolves.toMatchObject({ suppressed: false });
  });

  it('uses a caller-supplied contact instead of re-reading it', async () => {
    const rig = readRig({ contact: contact({ sms_opt_out: true }) });
    const out = await readNumberSuppression(rig, PRIMARY, { contact: undefined });
    expect(out.scope).toBe('no_contact');
    expect(rig.contactsRepo.findByPhone).not.toHaveBeenCalled();
  });
});

describe('applyNumberSuppression', () => {
  const conversation = async (): Promise<ConversationItem> => thread();

  it('PRIMARY opt-out writes the thread flag, the contact flag, and a contact-keyed audit', async () => {
    const rig = writeRig();
    const out = await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: contact(),
      conversation,
      source: 'keyword',
      providerSid: 'SM1',
    });

    expect(out).toEqual({ scope: 'primary', conversationId: 'conv-1', contactId: 'c1' });
    expect(rig.optOuts).toEqual([{ conversationId: 'conv-1', value: true }]);
    expect(rig.flags).toEqual([{ contactId: 'c1', flag: 'sms_opt_out', value: true }]);
    expect(rig.audits).toEqual([
      {
        entityKey: 'contacts#c1',
        eventType: 'sms_opt_out_recorded',
        payload: { providerSid: 'SM1', conversationId: 'conv-1', source: 'keyword' },
      },
    ]);
  });

  it('PRIMARY opt-in CLEARS both flags and audits the cleared event', async () => {
    const rig = writeRig();
    await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: false,
      contact: contact(),
      conversation,
      source: 'OptOutType',
      providerSid: 'SM2',
    });

    expect(rig.optOuts).toEqual([{ conversationId: 'conv-1', value: false }]);
    expect(rig.flags).toEqual([{ contactId: 'c1', flag: 'sms_opt_out', value: false }]);
    expect(rig.audits[0]?.eventType).toBe('sms_opt_out_cleared');
  });

  it('SECONDARY opt-out suppresses ONLY that number thread - the contact flag is untouched', async () => {
    const rig = writeRig();
    const out = await applyNumberSuppression(rig.deps, {
      phone: SECONDARY,
      suppressed: true,
      contact: contact(),
      conversation: async () => thread({ conversationId: 'conv-2', participant_phone: SECONDARY }),
      source: 'keyword',
      providerSid: 'SM3',
    });

    expect(out.scope).toBe('secondary');
    expect(rig.optOuts).toEqual([{ conversationId: 'conv-2', value: true }]);
    expect(rig.flags).toEqual([]);
    expect(rig.audits[0]?.entityKey).toBe('conversations#conv-2');
  });

  it('a primary and a secondary number of ONE contact suppress and restore independently', async () => {
    const rig = writeRig();
    const owner = contact();
    await applyNumberSuppression(rig.deps, {
      phone: SECONDARY,
      suppressed: true,
      contact: owner,
      conversation: async () => thread({ conversationId: 'conv-2', participant_phone: SECONDARY }),
      source: 'keyword',
    });
    await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: owner,
      conversation,
      source: 'keyword',
    });
    await applyNumberSuppression(rig.deps, {
      phone: SECONDARY,
      suppressed: false,
      contact: owner,
      conversation: async () => thread({ conversationId: 'conv-2', participant_phone: SECONDARY }),
      source: 'keyword',
    });

    expect(rig.optOuts).toEqual([
      { conversationId: 'conv-2', value: true },
      { conversationId: 'conv-1', value: true },
      { conversationId: 'conv-2', value: false },
    ]);
    // Only the PRIMARY write ever touched the contact flag, and it still stands.
    expect(rig.flags).toEqual([{ contactId: 'c1', flag: 'sms_opt_out', value: true }]);
  });

  it('a contact-less number still suppresses its thread and WARNs', async () => {
    const rig = writeRig();
    const out = await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: undefined,
      conversation,
      source: 'keyword',
    });

    expect(out.scope).toBe('no_contact');
    expect(rig.optOuts).toEqual([{ conversationId: 'conv-1', value: true }]);
    expect(rig.flags).toEqual([]);
    expect(rig.audits[0]?.entityKey).toBe('conversations#conv-1');
    expect(rig.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('merges caller audit context (group provenance) into the audit payload', async () => {
    const rig = writeRig();
    await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: contact(),
      conversation,
      source: 'keyword',
      providerSid: 'SM4',
      auditContext: { groupConversationId: 'grp-1', via: 'group_text' },
    });

    expect(rig.audits[0]?.payload).toMatchObject({
      providerSid: 'SM4',
      conversationId: 'conv-1',
      source: 'keyword',
      groupConversationId: 'grp-1',
      via: 'group_text',
    });
  });

  it('resolves the target conversation LAZILY - exactly once, and only when called', async () => {
    const rig = writeRig();
    const resolve = vi.fn(async () => thread());
    await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: contact(),
      conversation: resolve,
      source: 'keyword',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('never logs a phone number (doc 9)', async () => {
    const rig = writeRig();
    await applyNumberSuppression(rig.deps, {
      phone: PRIMARY,
      suppressed: true,
      contact: undefined,
      conversation,
      source: 'keyword',
    });
    expect(JSON.stringify(rig.logs)).not.toContain('5550100001');
  });
});
