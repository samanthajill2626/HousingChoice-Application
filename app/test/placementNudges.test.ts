// Placement-nudge job unit tests (Post-Tour & Application, Task 4).
//
// Unit-style: injected FAKE repos + FIXED ISO clock strings (no wall-clock, no
// DynamoDB). Mirrors the tourReminders job's claim-before-send / error-isolation
// semantics — see app/src/jobs/tourReminders.ts.
//
// Covers:
//   arm — creates the right kind + dueAt per stage; cancels prior rows first;
//         rung-less stage (collect_rta) = cancel only; terminal stage = cancel only.
//   poll — sends the right body to the right party's 1:1 conversation;
//          claim-wins-once (fake claim returns false ⇒ no send);
//          stale-stage row is claimed-but-not-sent;
//          SendRefusedError keeps the claim + does not throw;
//          landlord recipient resolved via unit.landlordId;
//          create-on-demand — a landlord with NO 1:1 gets one minted (right type +
//          name denorm) then the nudge sent; the claim is idempotent per phone so
//          two rungs never duplicate; an sms_opt_out landlord's send still refuses.
import { describe, expect, it } from 'vitest';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import type {
  NudgeKind,
  PlacementNudgeItem,
  PlacementNudgesRepo,
} from '../src/repos/placementNudgesRepo.js';
import type { PlacementItem, PlacementsRepo } from '../src/repos/placementsRepo.js';
import type { UnitItem, UnitsRepo } from '../src/repos/unitsRepo.js';
import type { PlacementStage } from '../src/lib/statusModel.js';
import type {
  SendMessageInput,
  SendMessageOutcome,
  SendMessageService,
} from '../src/services/sendMessage.js';
import { SendRefusedError } from '../src/services/sendMessage.js';
import {
  armNudgeForStage,
  runDuePlacementNudges,
  type RunDuePlacementNudgesDeps,
} from '../src/jobs/placementNudges.js';
import { resolveMessage } from '../src/messages/index.js';

const FIXED_CREATED = '2026-07-03T00:00:00.000Z';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeNudgesRepo(seed: PlacementNudgeItem[] = []) {
  const rows: PlacementNudgeItem[] = [...seed];
  let counter = 0;
  const repo: PlacementNudgesRepo = {
    async create(input) {
      const row: PlacementNudgeItem = {
        nudgeId: `nudge-${++counter}`,
        placementId: input.placementId,
        kind: input.kind,
        dueAt: input.dueAt,
        _nudgePartition: 'nudges',
        createdAt: FIXED_CREATED,
      };
      rows.push(row);
      return row;
    },
    async listByPlacement(placementId) {
      return rows.filter((r) => r.placementId === placementId);
    },
    async listDue(nowIso) {
      return rows.filter(
        (r) => r.dueAt <= nowIso && r.sentAt === undefined && r.canceledAt === undefined,
      );
    },
    async claimSend(nudgeId, nowIso) {
      const row = rows.find((r) => r.nudgeId === nudgeId);
      if (!row || row.sentAt !== undefined || row.canceledAt !== undefined) return false;
      row.sentAt = nowIso;
      return true;
    },
    async cancel(nudgeId, canceledAt) {
      const row = rows.find((r) => r.nudgeId === nudgeId);
      if (!row || row.sentAt !== undefined || row.canceledAt !== undefined) return false;
      row.canceledAt = canceledAt;
      return true;
    },
    async uncancel(nudgeId) {
      const row = rows.find((r) => r.nudgeId === nudgeId);
      if (!row || row.canceledAt === undefined || row.sentAt !== undefined) return false;
      row.canceledAt = undefined;
      return true;
    },
    async cancelForPlacement(placementId) {
      for (const r of rows) {
        if (r.placementId === placementId && r.sentAt === undefined && r.canceledAt === undefined) {
          r.canceledAt = FIXED_CREATED;
        }
      }
    },
  };
  return { repo, rows };
}

function makePlacement(overrides: Partial<PlacementItem> & { placementId: string; stage: PlacementStage }): PlacementItem {
  return {
    tenantId: 'contact-tenant-1',
    unitId: 'unit-1',
    ...overrides,
  } as PlacementItem;
}

function makeFakePlacementsRepo(items: PlacementItem[]): PlacementsRepo {
  const byId = new Map(items.map((p) => [p.placementId, p]));
  return {
    async getById(placementId: string) {
      return byId.get(placementId);
    },
  } as unknown as PlacementsRepo;
}

function makeFakeContactsRepo(contacts: ContactItem[]): ContactsRepo {
  const byId = new Map(contacts.map((c) => [c.contactId, c]));
  return {
    async getById(contactId: string) {
      return byId.get(contactId);
    },
  } as unknown as ContactsRepo;
}

function makeFakeUnitsRepo(units: UnitItem[]): UnitsRepo {
  const byId = new Map(units.map((u) => [u.unitId, u]));
  return {
    async getById(unitId: string) {
      return byId.get(unitId);
    },
  } as unknown as UnitsRepo;
}

// Fake conversations repo. Models findByParticipantPhone AND the create-on-demand
// path: createOrGetByParticipantPhone is the one-active-conversation-per-phone
// CLAIM (idempotent per phone — two calls for the same phone return the SAME
// conversation, so a race can never mint a duplicate) and applyTriage stamps the
// display-name denorm. Returns the repo directly so existing call sites (which
// pass the result inline) are unchanged.
let convCounter = 0;
function makeFakeConversationsRepo(seed: ConversationItem[] = []): ConversationsRepo {
  const byId = new Map<string, ConversationItem>(seed.map((c) => [c.conversationId, c]));
  // The active claim: phone → conversationId (only OPEN conversations claim).
  const claimByPhone = new Map<string, string>();
  for (const c of seed) if (c.status === 'open') claimByPhone.set(c.participant_phone, c.conversationId);
  return {
    async findByParticipantPhone(phone: string) {
      return [...byId.values()].filter((c) => c.participant_phone === phone);
    },
    async createOrGetByParticipantPhone(phone: string, type: ConversationItem['type']) {
      const existingId = claimByPhone.get(phone);
      if (existingId !== undefined) return byId.get(existingId)!; // claim held → same conv
      const conv = conversation(`conv-created-${++convCounter}`, phone, type);
      byId.set(conv.conversationId, conv);
      claimByPhone.set(phone, conv.conversationId);
      return conv;
    },
    async applyTriage(
      conversationId: string,
      fields: { displayName?: string | null; type?: ConversationItem['type'] },
    ) {
      const conv = byId.get(conversationId);
      if (!conv) throw new Error(`applyTriage: conversation ${conversationId} not found`);
      const next: ConversationItem = { ...conv };
      if (fields.displayName !== undefined && fields.displayName !== null) {
        next.participant_display_name = fields.displayName;
      }
      if (fields.type !== undefined) next.type = fields.type;
      byId.set(conversationId, next);
      return next;
    },
  } as unknown as ConversationsRepo;
}

interface SendSpy {
  service: SendMessageService;
  sent: SendMessageInput[];
}

function makeSendSpy(opts: { throwErr?: Error } = {}): SendSpy {
  const sent: SendMessageInput[] = [];
  const service: SendMessageService = async (input) => {
    sent.push(input);
    if (opts.throwErr) throw opts.throwErr;
    return {
      conversationId: input.conversationId,
      providerSid: 'SM-fake',
      tsMsgId: 'ts-fake',
      status: 'queued',
    } as SendMessageOutcome;
  };
  return { service, sent };
}

function contact(id: string, type: ContactItem['type'], phone: string): ContactItem {
  return { contactId: id, type, phone, created_at: FIXED_CREATED } as ContactItem;
}

function conversation(
  conversationId: string,
  participant_phone: string,
  type: ConversationItem['type'],
): ConversationItem {
  return {
    conversationId,
    participant_phone,
    status: 'open',
    type,
    ai_mode: 'auto',
    last_activity_at: FIXED_CREATED,
    created_at: FIXED_CREATED,
  } as ConversationItem;
}

// ---------------------------------------------------------------------------
// arm
// ---------------------------------------------------------------------------

describe('armNudgeForStage', () => {
  const NOW = '2026-07-03T10:00:00.000Z';
  const H = 60 * 60 * 1000;

  it('creates the right kind + dueAt for each staged rung', async () => {
    const cases: Array<{ stage: PlacementStage; kind: NudgeKind; hours: number }> = [
      { stage: 'awaiting_receipt', kind: 'receipt_check', hours: 24 },
      { stage: 'awaiting_completion', kind: 'completion_check', hours: 24 },
      { stage: 'awaiting_approval', kind: 'approval_check', hours: 24 },
      { stage: 'awaiting_landlord_submission', kind: 'rta_window_closing', hours: 36 },
    ];
    for (const c of cases) {
      const { repo, rows } = makeFakeNudgesRepo();
      const p = makePlacement({ placementId: `p-${c.stage}`, stage: c.stage });
      await armNudgeForStage(p, c.stage, NOW, { placementNudgesRepo: repo });
      const pending = rows.filter((r) => r.canceledAt === undefined);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe(c.kind);
      expect(pending[0]!.placementId).toBe(p.placementId);
      expect(pending[0]!.dueAt).toBe(new Date(Date.parse(NOW) + c.hours * H).toISOString());
    }
  });

  it('cancels prior pending rows before creating the new stage row', async () => {
    const stale: PlacementNudgeItem = {
      nudgeId: 'nudge-old',
      placementId: 'p-1',
      kind: 'receipt_check',
      dueAt: '2026-07-04T10:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo, rows } = makeFakeNudgesRepo([stale]);
    const p = makePlacement({ placementId: 'p-1', stage: 'awaiting_completion' });
    await armNudgeForStage(p, 'awaiting_completion', NOW, { placementNudgesRepo: repo });

    expect(rows.find((r) => r.nudgeId === 'nudge-old')!.canceledAt).toBeDefined();
    const pending = rows.filter((r) => r.canceledAt === undefined);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('completion_check');
  });

  it('rung-less stage (collect_rta) cancels only — no new row', async () => {
    const stale: PlacementNudgeItem = {
      nudgeId: 'nudge-old',
      placementId: 'p-1',
      kind: 'approval_check',
      dueAt: '2026-07-04T10:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo, rows } = makeFakeNudgesRepo([stale]);
    const p = makePlacement({ placementId: 'p-1', stage: 'collect_rta' });
    await armNudgeForStage(p, 'collect_rta', NOW, { placementNudgesRepo: repo });

    expect(rows.find((r) => r.nudgeId === 'nudge-old')!.canceledAt).toBeDefined();
    expect(rows.filter((r) => r.canceledAt === undefined)).toHaveLength(0);
  });

  it('terminal stage (lost) cancels only — no new row', async () => {
    const stale: PlacementNudgeItem = {
      nudgeId: 'nudge-old',
      placementId: 'p-1',
      kind: 'receipt_check',
      dueAt: '2026-07-04T10:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo, rows } = makeFakeNudgesRepo([stale]);
    const p = makePlacement({ placementId: 'p-1', stage: 'lost' });
    await armNudgeForStage(p, 'lost', NOW, { placementNudgesRepo: repo });

    expect(rows.find((r) => r.nudgeId === 'nudge-old')!.canceledAt).toBeDefined();
    expect(rows.filter((r) => r.canceledAt === undefined)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

describe('runDuePlacementNudges', () => {
  const NOW = '2026-07-05T10:00:00.000Z';

  function tenantRig(stage: PlacementStage, kind: NudgeKind) {
    const tenantPhone = '+15550600001';
    const p = makePlacement({ placementId: 'p-1', tenantId: 'contact-tenant-1', unitId: 'unit-1', stage });
    const row: PlacementNudgeItem = {
      nudgeId: 'nudge-1',
      placementId: 'p-1',
      kind,
      dueAt: '2026-07-05T09:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo } = makeFakeNudgesRepo([row]);
    const send = makeSendSpy();
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: repo,
      placementsRepo: makeFakePlacementsRepo([p]),
      contactsRepo: makeFakeContactsRepo([contact('contact-tenant-1', 'tenant', tenantPhone)]),
      unitsRepo: makeFakeUnitsRepo([]),
      conversationsRepo: makeFakeConversationsRepo([
        conversation('conv-tenant-1', tenantPhone, 'tenant_1to1'),
      ]),
      sendMessageService: send.service,
    };
    return { repo, deps, send, row, tenantPhone };
  }

  it('sends the tenant rung body to the tenant 1:1 conversation', async () => {
    const { deps, send } = tenantRig('awaiting_receipt', 'receipt_check');
    await runDuePlacementNudges(NOW, deps);
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]!.conversationId).toBe('conv-tenant-1');
    expect(send.sent[0]!.body).toBe(resolveMessage('nudge.receipt_check'));
    expect(send.sent[0]!.author).toBe('teammate');
    expect(send.sent[0]!.automated).toBe(true);
  });

  it('resolves the landlord recipient via unit.landlordId and sends to the landlord 1:1', async () => {
    const landlordPhone = '+15550700002';
    const p = makePlacement({ placementId: 'p-1', stage: 'awaiting_approval', unitId: 'unit-9' });
    const row: PlacementNudgeItem = {
      nudgeId: 'nudge-1',
      placementId: 'p-1',
      kind: 'approval_check',
      dueAt: '2026-07-05T09:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo } = makeFakeNudgesRepo([row]);
    const send = makeSendSpy();
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: repo,
      placementsRepo: makeFakePlacementsRepo([p]),
      contactsRepo: makeFakeContactsRepo([
        contact('contact-tenant-1', 'tenant', '+15550600001'),
        contact('contact-landlord-1', 'landlord', landlordPhone),
      ]),
      unitsRepo: makeFakeUnitsRepo([
        { unitId: 'unit-9', landlordId: 'contact-landlord-1', status: 'available' } as UnitItem,
      ]),
      conversationsRepo: makeFakeConversationsRepo([
        conversation('conv-landlord-1', landlordPhone, 'landlord_1to1'),
      ]),
      sendMessageService: send.service,
    };
    await runDuePlacementNudges(NOW, deps);
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]!.conversationId).toBe('conv-landlord-1');
    expect(send.sent[0]!.body).toBe(resolveMessage('nudge.approval_check'));
  });

  it('claim-wins-once: when claimSend returns false, no send happens', async () => {
    const { deps, send, repo } = tenantRig('awaiting_receipt', 'receipt_check');
    // Force the claim to be lost (a concurrent tick / cancel won).
    repo.claimSend = async () => false;
    await runDuePlacementNudges(NOW, deps);
    expect(send.sent).toHaveLength(0);
  });

  it('stale-stage row is claimed (retired) but NOT sent', async () => {
    // Row is a receipt_check (rung stage awaiting_receipt) but the placement has
    // already moved on to awaiting_completion.
    const { deps, send, repo, row } = tenantRig('awaiting_completion', 'receipt_check');
    await runDuePlacementNudges(NOW, deps);
    expect(send.sent).toHaveLength(0);
    // The stale row was claimed so it won't reappear on the next poll.
    expect(row.sentAt).toBeDefined();
    // Nothing left due.
    expect(await repo.listDue(NOW)).toHaveLength(0);
  });

  it('SendRefusedError keeps the claim stamped and does not throw', async () => {
    const { repo, deps: baseDeps, row } = tenantRig('awaiting_receipt', 'receipt_check');
    const refusingSend = makeSendSpy({ throwErr: new SendRefusedError('conv-tenant-1', 'manual_mode') });
    const deps = { ...baseDeps, sendMessageService: refusingSend.service };
    await expect(runDuePlacementNudges(NOW, deps)).resolves.toBeUndefined();
    // Claim already stamped (no retry).
    expect(row.sentAt).toBeDefined();
    expect(await repo.listDue(NOW)).toHaveLength(0);
  });

  it('missing placement warns + skips (no send, no throw)', async () => {
    const row: PlacementNudgeItem = {
      nudgeId: 'nudge-1',
      placementId: 'ghost',
      kind: 'receipt_check',
      dueAt: '2026-07-05T09:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
    const { repo } = makeFakeNudgesRepo([row]);
    const send = makeSendSpy();
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: repo,
      placementsRepo: makeFakePlacementsRepo([]),
      contactsRepo: makeFakeContactsRepo([]),
      unitsRepo: makeFakeUnitsRepo([]),
      conversationsRepo: makeFakeConversationsRepo([]),
      sendMessageService: send.service,
    };
    await expect(runDuePlacementNudges(NOW, deps)).resolves.toBeUndefined();
    expect(send.sent).toHaveLength(0);
    // Missing placement is NOT claimed (row stays pending — a resurrected
    // placement could still be nudged; mirrors tourReminders' warn+skip).
    expect(row.sentAt).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Create-the-1:1-on-demand (FIX 7 — resolves placement-nudge-needs-landlord-1to1)
  // -------------------------------------------------------------------------

  function landlordRow(nudgeId: string, placementId: string, kind: NudgeKind): PlacementNudgeItem {
    return {
      nudgeId,
      placementId,
      kind,
      dueAt: '2026-07-05T09:00:00.000Z',
      _nudgePartition: 'nudges',
      createdAt: FIXED_CREATED,
    };
  }

  it('landlord with NO existing 1:1: creates the conversation (landlord_1to1, name denorm) then sends into it', async () => {
    const landlordPhone = '+15550700003';
    const p = makePlacement({ placementId: 'p-1', stage: 'awaiting_approval', unitId: 'unit-9' });
    const { repo } = makeFakeNudgesRepo([landlordRow('nudge-1', 'p-1', 'approval_check')]);
    const send = makeSendSpy();
    // Empty seed → the landlord has NO 1:1 thread (the DESIGNED masked-pool flow).
    const convRepo = makeFakeConversationsRepo([]);
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: repo,
      placementsRepo: makeFakePlacementsRepo([p]),
      contactsRepo: makeFakeContactsRepo([
        {
          contactId: 'contact-landlord-1',
          type: 'landlord',
          phone: landlordPhone,
          firstName: 'Larry',
          lastName: 'Landlord',
          created_at: FIXED_CREATED,
        } as ContactItem,
      ]),
      unitsRepo: makeFakeUnitsRepo([
        { unitId: 'unit-9', landlordId: 'contact-landlord-1', status: 'available' } as UnitItem,
      ]),
      conversationsRepo: convRepo,
      sendMessageService: send.service,
    };
    await runDuePlacementNudges(NOW, deps);

    // The 1:1 was minted on demand, typed landlord_1to1, with the display name denorm'd.
    const created = await convRepo.findByParticipantPhone(landlordPhone);
    expect(created).toHaveLength(1);
    expect(created[0]!.type).toBe('landlord_1to1');
    expect(created[0]!.participant_display_name).toBe('Larry Landlord');
    // ...and the nudge was sent into that new conversation.
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]!.conversationId).toBe(created[0]!.conversationId);
    expect(send.sent[0]!.body).toBe(resolveMessage('nudge.approval_check'));
    expect(send.sent[0]!.automated).toBe(true);
  });

  it('two landlord rungs for the same phone create EXACTLY ONE conversation (claim is idempotent)', async () => {
    const landlordPhone = '+15550700004';
    const pA = makePlacement({ placementId: 'p-A', stage: 'awaiting_approval', unitId: 'unit-9' });
    const pB = makePlacement({ placementId: 'p-B', stage: 'awaiting_landlord_submission', unitId: 'unit-9' });
    const { repo } = makeFakeNudgesRepo([
      landlordRow('nudge-A', 'p-A', 'approval_check'),
      landlordRow('nudge-B', 'p-B', 'rta_window_closing'),
    ]);
    const send = makeSendSpy();
    const convRepo = makeFakeConversationsRepo([]);
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: repo,
      placementsRepo: makeFakePlacementsRepo([pA, pB]),
      contactsRepo: makeFakeContactsRepo([
        contact('contact-landlord-1', 'landlord', landlordPhone),
      ]),
      unitsRepo: makeFakeUnitsRepo([
        { unitId: 'unit-9', landlordId: 'contact-landlord-1', status: 'available' } as UnitItem,
      ]),
      conversationsRepo: convRepo,
      sendMessageService: send.service,
    };
    await runDuePlacementNudges(NOW, deps);

    // The claim is idempotent per phone: both rungs resolve to the SAME single conv.
    const created = await convRepo.findByParticipantPhone(landlordPhone);
    expect(created).toHaveLength(1);
    expect(send.sent).toHaveLength(2);
    expect(send.sent[0]!.conversationId).toBe(created[0]!.conversationId);
    expect(send.sent[1]!.conversationId).toBe(created[0]!.conversationId);
  });

  it('sms_opt_out landlord: the 1:1 may be created but the send is REFUSED — claim stays stamped, no retry', async () => {
    const landlordPhone = '+15550700005';
    const p = makePlacement({ placementId: 'p-1', stage: 'awaiting_approval', unitId: 'unit-9' });
    const rows = makeFakeNudgesRepo([landlordRow('nudge-1', 'p-1', 'approval_check')]);
    const row = rows.rows[0]!;
    // sendMessageService is the sole enforcer of the opt-out gate: it throws
    // SendRefusedError('contact_opted_out') for a DNC landlord regardless of whether
    // the thread was just created. Thread existence is NOT a consent bypass.
    const refusingSend = makeSendSpy({
      throwErr: new SendRefusedError('conv-created', 'contact_opted_out'),
    });
    const convRepo = makeFakeConversationsRepo([]);
    const deps: RunDuePlacementNudgesDeps = {
      placementNudgesRepo: rows.repo,
      placementsRepo: makeFakePlacementsRepo([p]),
      contactsRepo: makeFakeContactsRepo([
        contact('contact-landlord-1', 'landlord', landlordPhone),
      ]),
      unitsRepo: makeFakeUnitsRepo([
        { unitId: 'unit-9', landlordId: 'contact-landlord-1', status: 'available' } as UnitItem,
      ]),
      conversationsRepo: convRepo,
      sendMessageService: refusingSend.service,
    };
    await expect(runDuePlacementNudges(NOW, deps)).resolves.toBeUndefined();

    // The 1:1 was created on demand (thread existence is not consent)...
    expect(await convRepo.findByParticipantPhone(landlordPhone)).toHaveLength(1);
    // ...the send was attempted and refused by the gate...
    expect(refusingSend.sent).toHaveLength(1);
    // ...and the claim is already stamped so no retry will fire (mirror the
    // existing SendRefusedError shape).
    expect(row.sentAt).toBeDefined();
    expect(await rows.repo.listDue(NOW)).toHaveLength(0);
  });
});
