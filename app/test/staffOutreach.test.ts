// services/staffOutreach.ts recordStaffOutreach (today-checklist spec
// docs/superpowers/specs/2026-10-23-today-checklist-design.md section 7.3;
// plan ruling PR5): the ONE path a live send uses to move
// last_reached_out_at. Pure - a recording contacts fake and a captured
// logger. Every writer (S2, S3) and a future staff agent rely on these
// rules: one touch per contact at its LATEST instant, an empty id dropped,
// a failure logged and swallowed (a stamp never fails a send), and the
// written ids returned so the caller can emit its one event.
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { recordStaffOutreach, type StaffOutreachStamp } from '../src/services/staffOutreach.js';
import { createLogCapture } from './helpers/logCapture.js';

type Answer = 'written' | 'skipped' | 'failed' | 'reject' | 'throw';

/** A touchLastReachedOut fake answering per contact (default 'written'). */
function rig(answers: Record<string, Answer> = {}) {
  const calls: Array<{ contactId: string; at: string }> = [];
  const capture = createLogCapture();
  const log = createLogger({ destination: capture.stream, level: 'debug' });
  const contacts = {
    touchLastReachedOut(contactId: string, at: string): Promise<'written' | 'skipped' | 'failed'> {
      calls.push({ contactId, at });
      const answer = answers[contactId] ?? 'written';
      if (answer === 'throw') throw new Error('synchronous fake failure');
      if (answer === 'reject') return Promise.reject(new Error('throttled'));
      return Promise.resolve(answer);
    },
  };
  return { calls, capture, deps: { contacts, log } };
}

const AT = '2026-10-24T09:00:00.000Z';

describe('recordStaffOutreach (today-checklist PR5)', () => {
  it('touches each contact ONCE at its latest instant, in first-seen order, and returns the written ids', async () => {
    const { calls, deps } = rig();
    const stamps: StaffOutreachStamp[] = [
      { contactId: 'c-a', at: '2026-10-24T09:00:00.000Z' },
      { contactId: 'c-b', at: '2026-10-24T08:00:00.000Z' },
      { contactId: 'c-a', at: '2026-10-24T11:00:00.000Z' },
      { contactId: 'c-a', at: '2026-10-24T10:00:00.000Z' },
    ];

    await expect(recordStaffOutreach(deps, stamps)).resolves.toEqual(['c-a', 'c-b']);

    expect(calls).toEqual([
      { contactId: 'c-a', at: '2026-10-24T11:00:00.000Z' },
      { contactId: 'c-b', at: '2026-10-24T08:00:00.000Z' },
    ]);
  });

  it('compares instants as TIME, not as text', async () => {
    // 06:00-04:00 is 10:00Z - later than 09:00Z, though it sorts first as text.
    const { calls, deps } = rig();
    await recordStaffOutreach(deps, [
      { contactId: 'c-a', at: '2026-10-24T09:00:00.000Z' },
      { contactId: 'c-a', at: '2026-10-24T06:00:00-04:00' },
    ]);
    expect(calls).toEqual([{ contactId: 'c-a', at: '2026-10-24T06:00:00-04:00' }]);
  });

  it('an unparseable instant never beats a parseable one for the same contact', async () => {
    const { calls, deps } = rig();
    await recordStaffOutreach(deps, [
      { contactId: 'c-a', at: 'not a time' },
      { contactId: 'c-a', at: AT },
      { contactId: 'c-a', at: 'also not a time' },
    ]);
    expect(calls).toEqual([{ contactId: 'c-a', at: AT }]);
  });

  it('drops a stamp with an empty contactId and makes no call for it', async () => {
    const { calls, deps } = rig();
    await expect(
      recordStaffOutreach(deps, [
        { contactId: '', at: AT },
        { contactId: 'c-a', at: AT },
      ]),
    ).resolves.toEqual(['c-a']);
    expect(calls.map((c) => c.contactId)).toEqual(['c-a']);
  });

  it('no stamps: no call, no log line, nothing written', async () => {
    const { calls, capture, deps } = rig();
    await expect(recordStaffOutreach(deps, [])).resolves.toEqual([]);
    expect(calls).toEqual([]);
    expect(capture.lines).toEqual([]);
  });

  it("'skipped' (no row, already as late) is neither returned nor logged", async () => {
    const { capture, deps } = rig({ 'c-a': 'skipped' });
    await expect(recordStaffOutreach(deps, [{ contactId: 'c-a', at: AT }])).resolves.toEqual([]);
    expect(capture.atLevel(40)).toEqual([]);
    expect(capture.atLevel(50)).toEqual([]);
  });

  it("'failed' logs ERROR with the contactId only, never throws, and the other contacts are still stamped", async () => {
    const { calls, capture, deps } = rig({ 'c-b': 'failed' });

    await expect(
      recordStaffOutreach(deps, [
        { contactId: 'c-a', at: AT },
        { contactId: 'c-b', at: AT },
        { contactId: 'c-c', at: AT },
      ]),
    ).resolves.toEqual(['c-a', 'c-c']);

    expect(calls.map((c) => c.contactId)).toEqual(['c-a', 'c-b', 'c-c']);
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]!['contactId']).toBe('c-b');
    expect(String(errors[0]!['msg'])).toContain('last_reached_out_at');
    // ids only: no instant, no error object (spec 7.3).
    expect(errors[0]).not.toHaveProperty('at');
    expect(errors[0]).not.toHaveProperty('err');
  });

  for (const answer of ['reject', 'throw'] as const) {
    it(`a touch that ${answer === 'reject' ? 'rejects' : 'throws synchronously'} is caught and treated as 'failed'`, async () => {
      const { capture, deps } = rig({ 'c-a': answer });
      await expect(
        recordStaffOutreach(deps, [
          { contactId: 'c-a', at: AT },
          { contactId: 'c-b', at: AT },
        ]),
      ).resolves.toEqual(['c-b']);
      expect(capture.atLevel(50).map((line) => line['contactId'])).toEqual(['c-a']);
    });
  }
});
