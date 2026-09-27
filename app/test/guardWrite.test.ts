// app/test/guardWrite.test.ts
// Spec D7a: a write made from a failure arm never throws out of the recipient
// unit. guardWrite resolves true when the write resolved and false when it
// threw - it says nothing about whether a conditional write's FENCE won (a
// caller that needs that captures the boolean inside the closure).
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import { guardWrite } from '../src/lib/guardWrite.js';
import { createLogCapture } from './helpers/logCapture.js';

describe('guardWrite (spec D7a)', () => {
  it('returns true when the write resolves and logs nothing', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    expect(await guardWrite(log, { owner: 'x' }, 'finishAttempt', async () => undefined)).toBe(true);
    expect(capture.atLevel(50)).toHaveLength(0);
    expect(capture.lines).toHaveLength(0);
  });

  it('returns true when the write resolves false - a lost fence is not a failed write', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    expect(await guardWrite(log, { owner: 'x' }, 'handToReconcile', async () => false)).toBe(true);
    expect(capture.lines).toHaveLength(0);
  });

  it('returns false when the write throws, logs ERROR with the label and context, never throws', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    expect(
      await guardWrite(log, { broadcastId: 'b-1', recipientKey: 'phone#redacted' }, 'handToReconcile', async () => {
        throw new Error('dynamo blip');
      }),
    ).toBe(false);
    const errors = capture.atLevel(50);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ label: 'handToReconcile', broadcastId: 'b-1', recipientKey: 'phone#redacted' });
    expect(String(errors[0]!['msg'])).toContain('failure-arm write failed');
    // The error travels under the wired `err` key (the safe serializer), never spread.
    expect(errors[0]!['err']).toMatchObject({ message: 'dynamo blip' });
  });

  it('the label always wins over a context key of the same name', async () => {
    const capture = createLogCapture();
    const log = createLogger({ level: 'info', destination: capture.stream });
    expect(
      await guardWrite(log, { label: 'from-ctx' }, 'closeRedriven', async () => {
        throw new Error('x');
      }),
    ).toBe(false);
    expect(capture.atLevel(50)[0]).toMatchObject({ label: 'closeRedriven' });
  });
});
