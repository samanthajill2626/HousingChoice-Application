import { describe, expect, it } from 'vitest';
import { NumberRegistry } from '../src/engine/numberRegistry.js';

describe('NumberRegistry', () => {
  it('provision returns distinct numbers + PN sids across calls', () => {
    const reg = new NumberRegistry();
    const a = reg.provision();
    const b = reg.provision();
    expect(a.phoneNumber).toMatch(/^\+1555019\d{4}$/);
    expect(b.phoneNumber).toMatch(/^\+1555019\d{4}$/);
    expect(a.phoneNumber).not.toBe(b.phoneNumber);
    expect(a.sid).toMatch(/^PN/);
    expect(b.sid).toMatch(/^PN/);
    expect(a.sid).not.toBe(b.sid);
  });

  it('isPool is false before and true after provisioning a number', () => {
    const reg = new NumberRegistry();
    const candidate = '+15550190000';
    expect(reg.isPool(candidate)).toBe(false);
    const { phoneNumber } = reg.provision();
    expect(reg.isPool(phoneNumber)).toBe(true);
    // an un-provisioned number is still not in the pool
    expect(reg.isPool('+19998887777')).toBe(false);
  });

  it('setWebhooks then get reflects the urls', () => {
    const reg = new NumberRegistry();
    const { phoneNumber } = reg.provision();
    reg.setWebhooks(phoneNumber, { smsUrl: 'https://app/sms', voiceUrl: 'https://app/voice' });
    const rec = reg.get(phoneNumber);
    expect(rec?.phoneNumber).toBe(phoneNumber);
    expect(rec?.smsUrl).toBe('https://app/sms');
    expect(rec?.voiceUrl).toBe('https://app/voice');
    // partial update preserves the other url
    reg.setWebhooks(phoneNumber, { voiceUrl: 'https://app/voice2' });
    expect(reg.get(phoneNumber)?.smsUrl).toBe('https://app/sms');
    expect(reg.get(phoneNumber)?.voiceUrl).toBe('https://app/voice2');
  });

  it('get returns undefined for an unprovisioned number', () => {
    const reg = new NumberRegistry();
    expect(reg.get('+15550199999')).toBeUndefined();
  });

  it('list returns all provisioned records', () => {
    const reg = new NumberRegistry();
    const a = reg.provision();
    const b = reg.provision();
    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.map((r) => r.phoneNumber).sort()).toEqual([a.phoneNumber, b.phoneNumber].sort());
  });

  it('honors an areaCode hint while staying distinct', () => {
    const reg = new NumberRegistry();
    const a = reg.provision({ areaCode: '555' });
    const b = reg.provision({ areaCode: '555' });
    expect(a.phoneNumber).not.toBe(b.phoneNumber);
  });
});
