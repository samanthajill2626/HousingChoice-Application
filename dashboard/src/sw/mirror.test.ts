// public/sw.js mirror check - compares BEHAVIOUR, not source fragments.
//
// WHY THIS FILE CHANGED (2026-08-21)
// ---------------------------------
// public/sw.js is a CLASSIC service worker: served statically, never bundled,
// and unable to `import` the ES modules it duplicates. So it carries
// hand-maintained copies of src/sw/route.ts and src/sw/display.ts. The modules
// are what the suite exercises; the mirror is what actually runs on the phone.
// A forgotten mirror edit ships tested-but-dead logic, silently.
//
// This file existed to prevent exactly that, and could not. Every assertion was
// `expect(swSource).toContain('<exact source fragment>')`, which:
//
//   - only caught the specific copies someone thought to pin. Any FUTURE change
//     to route.ts - tightening a regex, adding a branch - passed green with the
//     mirror untouched. The identical failure mode the file was written to stop.
//   - was brittle in the other direction: reflowing a correctly-mirrored line
//     failed it.
//
// Not hypothetical. A one-character divergence sat in `isPlausibleId` from
// 26a01b9f until 2026-08-20 - the module rejected \x7f (DEL), the mirror did
// not - through the ENTIRE life of this test file. It was found by reading.
//
// WHY BEHAVIOUR RATHER THAN NORMALISED SOURCE
// -------------------------------------------
// The issue that prompted this suggested comparing function bodies after
// normalising the deliberate differences, and warned that a hand-rolled TS
// stripper which is itself buggy would make this test worse than the pins.
// Both concerns dissolve if the two copies are simply RUN against the same
// inputs: no type stripping, no normalisation, and reflowing or re-commenting a
// correct mirror cannot fail it. It also turned out that source comparison
// could not have worked here anyway - the module builds its character class
// from `UNSAFE_ID_CHARS` while the mirror inlines a regex literal. Those are
// different source, identical behaviour, which is precisely the distinction
// that matters.
//
// See docs/issues/sw-mirror-test-pins-literals-not-behaviour.md.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as display from './display.js';
import * as route from './route.js';

const here = dirname(fileURLToPath(import.meta.url));
// src/sw/ -> ../../public/sw.js. Read relative to THIS FILE, not process.cwd(),
// so driving vitest from the repo root does not hard-fail at collection time.
const swSource = readFileSync(join(here, '..', '..', 'public', 'sw.js'), 'utf8');

const MIRRORED = [
  'isPlausibleId',
  'resolveSafePath',
  'assertSameOriginPath',
  'notificationTag',
  'buildNotificationOptions',
  'staleTagsFor',
] as const;

/**
 * Extract one top-level `function NAME(...) {...}` by BRACE MATCHING.
 *
 * Brace matching rather than a regex because these bodies contain both braces
 * and regex literals; a lazy `{[\s\S]*?}` would stop at the first inner brace
 * and silently sandbox a truncated function - which is how a comparison test
 * quietly becomes another vacuous one.
 */
function extractFunction(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:^|\\n)function\\s+${name}\\s*\\(`));
  if (start === -1) throw new Error(`function ${name} not found in public/sw.js`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

/**
 * The mirror's own implementations, lifted out of the classic worker and made
 * callable. They reference only their arguments and each other, so they run
 * standalone - no `self`, no `clients`, no DOM.
 */
const mirror = (() => {
  const bodies = MIRRORED.map((name) => extractFunction(swSource, name)).join('\n');
  const factory = new Function(`${bodies}\nreturn { ${MIRRORED.join(', ')} };`);
  return factory() as Record<(typeof MIRRORED)[number], (...args: never[]) => unknown>;
})();

/** Run both copies over the same inputs and require identical output. */
function agreeOn(name: (typeof MIRRORED)[number], impl: (...a: never[]) => unknown, cases: unknown[][]): void {
  for (const args of cases) {
    const fromModule = impl(...(args as never[]));
    const fromMirror = mirror[name](...(args as never[]));
    expect(fromMirror, `public/sw.js ${name}(${JSON.stringify(args)}) drifted`).toEqual(fromModule);
  }
}

describe('public/sw.js behaves identically to the modules it cannot import', () => {
  it('exposes every function this test claims to cover', () => {
    for (const name of MIRRORED) expect(typeof mirror[name]).toBe('function');
  });

  it('isPlausibleId agrees on the whole rejection class', () => {
    agreeOn('isPlausibleId', route.isPlausibleId, [
      ['call-123'],
      ['CA' + 'f'.repeat(30)],
      [''],
      ['a'.repeat(256)],
      ['a'.repeat(257)],
      ['has/slash'],
      ['has\\backslash'],
      ['javascript:alert(1)'],
      ['has space'],
      ['tab\there'],
      ['nl\nhere'],
      ['\u0000null'],
      ['\u001Funit-sep'],
      // THE HISTORICAL DRIFT. The module rejected DEL, the mirror accepted it,
      // and the old pins could not see it because they only checked that a
      // particular substring appeared somewhere in the file.
      ['\u007FDEL'],
      ['ok\u007F'],
      [undefined],
      [null],
      [42],
      [{}],
      [['a']],
    ]);
  });

  it('resolveSafePath agrees across kinds, ids and action buttons', () => {
    const payloads = [
      undefined,
      null,
      {},
      { kind: 'missed_call', callId: 'call-1' },
      { kind: 'missed_call', callId: 'bad/id' },
      { kind: 'missed_call' },
      { kind: 'missed_call', callId: '\u007F' },
      { kind: 'missed_call', callId: 'call-1', conversationId: 'conv-1' },
      { kind: 'message', conversationId: 'conv-1' },
      { kind: 'voicemail', conversationId: 'conv-2' },
      { kind: 'unmatched_email' },
      { kind: 'unmatched_email', conversationId: 'conv-3' },
      { conversationId: 'needs/encoding' },
      { kind: 'nonsense' },
    ];
    const actions = [undefined, null, 'reply-1', 'bad/action', '', '\u007F'];
    agreeOn(
      'resolveSafePath',
      route.resolveSafePath as never,
      payloads.flatMap((p) => actions.map((a) => [p, a])),
    );
  });

  it('assertSameOriginPath agrees on the allow-list and the escapes', () => {
    const origin = 'https://app.example';
    agreeOn(
      'assertSameOriginPath',
      route.assertSameOriginPath as never,
      [
        '/',
        '/email',
        '/email/quarantine',
        '/quick-reply/call-1',
        '/quick-reply/call-1#action=reply-1',
        '/quick-reply/a/b',
        '/conversations/conv-1',
        '/conversations/a/b',
        '/nope',
        'https://evil.example/phish',
        '//evil.example',
        'javascript:alert(1)',
        '',
        '/conversations/conv-1?x=1#h',
      ].map((p) => [p, origin]),
    );
  });

  const displayPayloads = [
    undefined,
    null,
    {},
    { kind: 'message', conversationId: 'conv-1' },
    { kind: 'message', conversationId: 'conv-1', title: 'T', body: 'B' },
    { kind: 'missed_call', callId: 'call-1' },
    { kind: 'pre_ring', callId: 'call-2' },
    { kind: 'unmatched_email' },
    { kind: 'unmatched_email', conversationId: 'conv-9' },
    { kind: 'voicemail', callId: 'call-3', conversationId: 'conv-3' },
    { kind: 'nonsense', conversationId: 'conv-4' },
    { callId: 'call-5' },
    { conversationId: 'conv-6' },
  ];

  it('notificationTag agrees', () => {
    agreeOn('notificationTag', display.notificationTag as never, displayPayloads.map((p) => [p]));
  });

  it('buildNotificationOptions agrees, field for field', () => {
    agreeOn(
      'buildNotificationOptions',
      display.buildNotificationOptions as never,
      displayPayloads.map((p) => [p]),
    );
  });

  it('staleTagsFor agrees', () => {
    agreeOn('staleTagsFor', display.staleTagsFor as never, displayPayloads.map((p) => [p]));
  });
});

describe('behavioural pins kept alongside the comparison', () => {
  // Two IDENTICALLY BROKEN copies compare equal. These pins are the backstop
  // for the highest-value invariants, per the issue's own advice.
  it('the quick-reply target never names a recipient', () => {
    expect(swSource).not.toContain('conversationId=$');
    expect(route.resolveSafePath({ kind: 'missed_call', callId: 'call-1' }, 'reply-1')).not.toContain(
      'conversationId',
    );
  });

  it('action buttons are not ignored', () => {
    // `void action;` was the retired line that made the worker drop every
    // Android action-button tap.
    expect(swSource).not.toContain('void action;');
  });

  it('an off-origin payload can never escape the allow-list', () => {
    expect(route.assertSameOriginPath('https://evil.example/phish', 'https://app.example')).toBe('/');
  });

  // Carried over from main's runtime-identity work when the behavioural rewrite
  // and `feat(pwa): ship runtime HC identity artwork` met (2026-08-23). That
  // change edited BOTH copies - dashboard/src/sw/display.ts and
  // public/sw.js - so `buildNotificationOptions agrees` already compares them.
  // This is the backstop for the case that agreement cannot catch: both copies
  // reverted to the old static icon together. The badge stays monochrome and
  // is deliberately NOT identity-swapped.
  it('notifications use the runtime identity icon, and the badge stays monochrome', () => {
    expect(swSource).toContain("icon: '/app-identity/icon-192.png'");
    expect(swSource).toContain("badge: '/icons/badge-72.png'");
    expect(swSource).not.toContain("icon: '/icons/icon-192.png'");
  });
});
