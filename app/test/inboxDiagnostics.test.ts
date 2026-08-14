import { describe, expect, it } from 'vitest';
import {
  assertLocalInboxProfileTarget,
  createInboxProfilePlan,
  createTimedRepository,
  summarizeInboxTrace,
  type InboxTraceEvent,
} from '../src/lib/inboxDiagnostics.js';

describe('createInboxProfilePlan', () => {
  it('runs five comparable samples with dashboard page size 30 and badge size 100', () => {
    const plan = createInboxProfilePlan();

    expect(plan).toHaveLength(25);
    expect(plan.filter((sample) => sample.repeat === 0)).toEqual([
      { caseId: 'all-page', filter: 'all', limit: 30, repeat: 0 },
      { caseId: 'unread-page', filter: 'unread', limit: 30, repeat: 0 },
      { caseId: 'unknown-page', filter: 'unknown', limit: 30, repeat: 0 },
      { caseId: 'groups-page', filter: 'groups', limit: 30, repeat: 0 },
      { caseId: 'unread-badge', filter: 'unread', limit: 100, repeat: 0 },
    ]);
    expect([...new Set(plan.map((sample) => sample.repeat))]).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('createTimedRepository', () => {
  it('records the real async repository result with absolute and relative timing', async () => {
    const trace: InboxTraceEvent[] = [];
    const ticks = [110, 135];
    const repository = createTimedRepository(
      'contacts',
      {
        async findByPhone(phone: string) {
          return [{ contactId: 'contact-1', phone }];
        },
      },
      trace,
      {
        caseId: 'unread-page',
        repeat: 0,
        originMs: 100,
        nowMs: () => ticks.shift()!,
        wallNow: () => '2026-08-14T15:00:00.000Z',
      },
    );

    await expect(repository.findByPhone('+14045550100')).resolves.toEqual([
      { contactId: 'contact-1', phone: '+14045550100' },
    ]);
    expect(trace).toEqual([
      {
        caseId: 'unread-page',
        repeat: 0,
        operation: 'contacts.findByPhone',
        startedAt: '2026-08-14T15:00:00.000Z',
        startOffsetMs: 10,
        durationMs: 25,
        outcome: 'ok',
        arguments: ['+14045550100'],
        resultCount: 1,
      },
    ]);
  });

  it('records a failed repository call before rethrowing the original error', async () => {
    const trace: InboxTraceEvent[] = [];
    const failure = new Error('lookup failed');
    const ticks = [50, 58];
    const repository = createTimedRepository(
      'messages',
      {
        async listByConversation() {
          throw failure;
        },
      },
      trace,
      {
        caseId: 'all-page',
        repeat: 1,
        originMs: 40,
        nowMs: () => ticks.shift()!,
        wallNow: () => '2026-08-14T15:00:01.000Z',
      },
    );

    await expect(repository.listByConversation()).rejects.toBe(failure);
    expect(trace).toEqual([
      {
        caseId: 'all-page',
        repeat: 1,
        operation: 'messages.listByConversation',
        startedAt: '2026-08-14T15:00:01.000Z',
        startOffsetMs: 10,
        durationMs: 8,
        outcome: 'error',
        arguments: [],
        resultCount: 0,
        error: 'lookup failed',
      },
    ]);
  });
});

describe('summarizeInboxTrace', () => {
  it('groups calls by case and operation and calculates literal timing statistics', () => {
    const trace: InboxTraceEvent[] = [
      {
        caseId: 'unread-page', repeat: 0, operation: 'contacts.findByPhone',
        startedAt: '2026-08-14T15:00:00.000Z', startOffsetMs: 0, durationMs: 10,
        outcome: 'ok', arguments: ['one'], resultCount: 1,
      },
      {
        caseId: 'unread-page', repeat: 0, operation: 'contacts.findByPhone',
        startedAt: '2026-08-14T15:00:00.010Z', startOffsetMs: 10, durationMs: 20,
        outcome: 'ok', arguments: ['two'], resultCount: 1,
      },
      {
        caseId: 'unread-page', repeat: 0, operation: 'contacts.findByPhone',
        startedAt: '2026-08-14T15:00:00.030Z', startOffsetMs: 30, durationMs: 30,
        outcome: 'error', arguments: ['three'], resultCount: 0, error: 'failed',
      },
      {
        caseId: 'all-page', repeat: 0, operation: 'messages.listByConversation',
        startedAt: '2026-08-14T15:00:01.000Z', startOffsetMs: 0, durationMs: 5,
        outcome: 'ok', arguments: ['conversation-1'], resultCount: 1,
      },
    ];

    expect(summarizeInboxTrace(trace)).toEqual([
      {
        caseId: 'all-page',
        operation: 'messages.listByConversation',
        calls: 1,
        failures: 0,
        totalMs: 5,
        medianMs: 5,
        p95Ms: 5,
        maxMs: 5,
        totalResultCount: 1,
      },
      {
        caseId: 'unread-page',
        operation: 'contacts.findByPhone',
        calls: 3,
        failures: 1,
        totalMs: 60,
        medianMs: 20,
        p95Ms: 30,
        maxMs: 30,
        totalResultCount: 2,
      },
    ]);
  });
});

describe('assertLocalInboxProfileTarget', () => {
  it('accepts only the local DynamoDB endpoint and hc-local table prefix', () => {
    expect(() => assertLocalInboxProfileTarget('http://localhost:8000', 'hc-local-')).not.toThrow();
    expect(() => assertLocalInboxProfileTarget('http://127.0.0.1:8000', 'hc-local-')).not.toThrow();
    expect(() => assertLocalInboxProfileTarget('https://dynamodb.us-east-1.amazonaws.com', 'hc-local-'))
      .toThrow('Inbox profiling is restricted to DynamoDB Local');
    expect(() => assertLocalInboxProfileTarget('http://localhost:8000', 'hc-dev-'))
      .toThrow('Inbox profiling is restricted to the hc-local- table prefix');
  });
});
