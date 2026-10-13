// The per-IP limiter's CLIENT KEY (docs/issues/public-rate-limit-key-spoofable-xff.md).
// The key used to be the FIRST X-Forwarded-For entry, which the client chooses
// (CloudFront APPENDS the viewer to whatever the client sent), so one caller got
// a fresh bucket - and a fresh welcome text - per request. It is now the
// CloudFront-Viewer-Address header, which CloudFront sets and overwrites, with
// IPv6 grouped by /64 and the socket address as the off-CloudFront fallback.
//
//   1. viewerAddressIp / addressKey / clientIpOf UNIT cases (pure functions over
//      a minimal req fake).
//   2. ROUTE-LEVEL through the real app (the webhook harness): one viewer
//      rotating a forged X-Forwarded-For can no longer rotate buckets, and the
//      controls - a plain single client is still limited, two real viewers stay
//      independent, an IPv6 viewer cannot escape by rotating inside its /64.
import type { Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addressKey, clientIpOf, viewerAddressIp } from '../src/middleware/rateLimit.js';
import { makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

function fakeReq(headers: Record<string, string>, remoteAddress?: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

describe('viewerAddressIp - the IP inside one CloudFront-Viewer-Address value', () => {
  it('reads IPv4 and unbracketed / bracketed IPv6, dropping the port', () => {
    // The shape CloudFront actually sent on 2026-10-12 (throwaway distribution;
    // the real viewer address swapped for a documentation one).
    expect(viewerAddressIp('192.0.2.44:63938')).toBe('192.0.2.44');
    // CloudFront writes IPv6 WITHOUT brackets: the port follows the LAST colon.
    expect(viewerAddressIp('2001:db8::1:46532')).toBe('2001:db8::1');
    expect(viewerAddressIp('2001:db8:1:2:3:4:5:6:46532')).toBe('2001:db8:1:2:3:4:5:6');
    expect(viewerAddressIp('[2001:db8::1]:46532')).toBe('2001:db8::1');
    expect(viewerAddressIp('  203.0.113.7:1  ')).toBe('203.0.113.7');
  });

  it('answers undefined for a joined (comma) value or anything it cannot read', () => {
    expect(viewerAddressIp('1.2.3.4:1, 192.0.2.44:63938')).toBeUndefined();
    for (const bad of ['', 'garbage', ':80', '1.2.3.4', '1.2.3.4:', '1.2.3.4:abc', '999.1.1.1:80', '[1.2.3.4]:80']) {
      expect(viewerAddressIp(bad), bad).toBeUndefined();
    }
  });
});

describe('addressKey - IPv4 as-is, IPv4-mapped as IPv4, IPv6 by /64', () => {
  it('keeps IPv4 and collapses IPv4-mapped IPv6 (both spellings) to it', () => {
    expect(addressKey('203.0.113.7')).toBe('203.0.113.7');
    expect(addressKey('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(addressKey('::ffff:7f00:1')).toBe('127.0.0.1');
  });

  it('keys every address inside one /64 the same, whatever the spelling or case', () => {
    const key = '2001:db8:1:2::/64';
    expect(addressKey('2001:db8:1:2::a')).toBe(key);
    expect(addressKey('2001:DB8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
    expect(addressKey('2001:0db8:0001:0002:0000:0000:0000:0001')).toBe(key);
    expect(addressKey('2001:db8:1:3::a')).toBe('2001:db8:1:3::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
  });

  it('drops a zone suffix and refuses a non-address', () => {
    expect(addressKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressKey('not-an-ip')).toBeUndefined();
    expect(addressKey('')).toBeUndefined();
  });
});

describe('clientIpOf - CloudFront-Viewer-Address, else the socket, never X-Forwarded-For', () => {
  it('keys on CloudFront-Viewer-Address and ignores a forged X-Forwarded-For', () => {
    const req = fakeReq(
      {
        'cloudfront-viewer-address': '192.0.2.44:63938',
        'x-forwarded-for': '9.9.9.9, 192.0.2.44',
      },
      '130.176.1.1',
    );
    expect(clientIpOf(req)).toBe('192.0.2.44');
  });

  it('keys an IPv6 viewer by its /64', () => {
    expect(clientIpOf(fakeReq({ 'cloudfront-viewer-address': '2001:db8:1:2::a:46532' }))).toBe('2001:db8:1:2::/64');
  });

  it('with no header falls back to the socket - the X-Forwarded-For first entry is never read', () => {
    const req = fakeReq({ 'x-forwarded-for': '9.9.9.9' }, '::ffff:127.0.0.1');
    expect(clientIpOf(req)).toBe('127.0.0.1');
  });

  it('falls back to the socket when the header is unreadable or joined from two lines', () => {
    expect(clientIpOf(fakeReq({ 'cloudfront-viewer-address': 'garbage' }, '130.176.1.1'))).toBe('130.176.1.1');
    expect(
      clientIpOf(fakeReq({ 'cloudfront-viewer-address': '1.2.3.4:1, 192.0.2.44:63938' }, '130.176.1.1')),
    ).toBe('130.176.1.1');
  });

  it('collapses to one constant key when nothing resolves', () => {
    expect(clientIpOf(fakeReq({}))).toBe('unknown');
  });
});

describe('POST /public/housing-fair - one viewer can no longer rotate buckets', () => {
  const FAIR = '/public/housing-fair';
  // Distinct, valid phones so every ADMITTED request captures a new contact and
  // sends one welcome text - world.sent then counts exactly the admitted sign-ups.
  const signup = (n: number) => ({
    firstName: 'Rate',
    lastName: `Probe${n}`,
    phone: `(555) 010-30${String(n).padStart(2, '0')}`,
    smsConsent: true,
  });
  const harness = () =>
    makeWebhookHarness({ env: { PUBLIC_RATE_LIMIT_MAX: '2', PUBLIC_RATE_LIMIT_WINDOW_MS: '60000' } });

  it('a viewer forging a fresh X-Forwarded-For first entry per request is refused at the cap; no welcome past it', async () => {
    const { app, world } = harness();
    const statuses: number[] = [];
    for (let n = 1; n <= 4; n += 1) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', ORIGIN_SECRET)
        // What the origin sees behind CloudFront: the client's forged entry,
        // then the viewer CloudFront appended; the viewer address is CloudFront's.
        .set('x-forwarded-for', `198.51.100.${n}, 203.0.113.7`)
        .set('cloudfront-viewer-address', `203.0.113.7:${40000 + n}`)
        .send(signup(n));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429, 429]);
    // Only the two admitted sign-ups were captured and texted.
    expect(world.sent).toHaveLength(2);
    expect(world.contacts.some((c) => c.phone === '+15550103003')).toBe(false);
  });

  it('control: a plain single client (no forged header) is still limited', async () => {
    const { app, world } = harness();
    const statuses: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cloudfront-viewer-address', '203.0.113.9:51000')
        .send(signup(n));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(world.sent).toHaveLength(2);
  });

  it('off CloudFront (no viewer header) the socket is the key: rotating X-Forwarded-For still buys nothing', async () => {
    const { app, world } = harness();
    const statuses: number[] = [];
    for (let n = 1; n <= 3; n += 1) {
      const res = await request(app)
        .post(FAIR)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('x-forwarded-for', `198.51.100.${n}`)
        .send(signup(n));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    expect(world.sent).toHaveLength(2);
  });

  it('two real viewers keep separate buckets', async () => {
    const { app, world } = harness();
    const post = (viewer: string, n: number) =>
      request(app)
        .post(FAIR)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cloudfront-viewer-address', viewer)
        .send(signup(n));
    expect((await post('203.0.113.7:40001', 1)).status).toBe(200);
    expect((await post('203.0.113.7:40002', 2)).status).toBe(200);
    expect((await post('203.0.113.7:40003', 3)).status).toBe(429); // viewer A capped...
    expect((await post('198.51.100.20:40004', 4)).status).toBe(200); // ...viewer B untouched
    expect(world.sent).toHaveLength(3);
  });

  it('an IPv6 viewer rotating source addresses inside its /64 shares one bucket; another /64 does not', async () => {
    const { app } = harness();
    const post = (viewer: string, n: number) =>
      request(app)
        .post(FAIR)
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cloudfront-viewer-address', viewer)
        .send(signup(n));
    expect((await post('2001:db8:1:2::a:50001', 1)).status).toBe(200);
    expect((await post('2001:db8:1:2:ffff::b:50002', 2)).status).toBe(200);
    expect((await post('2001:db8:1:2:1234:5678:9abc:def0:50003', 3)).status).toBe(429);
    expect((await post('2001:db8:1:3::a:50004', 4)).status).toBe(200);
  });
});
