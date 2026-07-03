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
//          landlord recipient resolved via unit.landlordId.
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
  NUDGE_RUNGS,
  runDuePlacementNudges,
  type RunDuePlacementNudgesDeps,
} from '../src/jobs/placementNudges.js';

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

function makeFakeConversationsRepo(convs: ConversationItem[]): ConversationsRepo {
  return {
    async findByParticipantPhone(phone: string) {
      return convs.filter((c) => c.participant_phone === phone);
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
    expect(send.sent[0]!.body).toBe(NUDGE_RUNGS.awaiting_receipt!.body);
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
    expect(send.sent[0]!.body).toBe(NUDGE_RUNGS.awaiting_approval!.body);
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
});
