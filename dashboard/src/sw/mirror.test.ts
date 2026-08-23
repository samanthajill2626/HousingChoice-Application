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
// See docs/issues/sw-mirror-test-pins-literals-not-behaviour.md, and
// docs/issues/sw-mirror-function-list-hand-maintained.md for why the list of
// functions to compare is derived rather than written down.
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

/**
 * WHAT MUST BE MIRRORED - derived from the modules, never remembered.
 *
 * This was a hand-written array of six names, which left a SEVENTH mirrored
 * function unguarded and the suite green: a weaker version of the exact failure
 * mode the behavioural rewrite removed, since coverage was again limited to what
 * somebody thought to enumerate.
 *
 * Comparing every function present in BOTH files does not work either - sw.js
 * legitimately carries worker-only code with no module counterpart
 * (closeStaleNotifications, focusOrOpen, the push / notificationclick
 * listeners), so that check would fail permanently on correct code.
 *
 * So the direction is inverted: the MODULES are the source of truth for what
 * must be mirrored, which is what they already claim to be, and the check runs
 * module -> mirror. Worker-only functions in sw.js are then correctly ignored,
 * and a new export lands in here for free. Interfaces cost nothing to exclude -
 * they do not exist at runtime.
 *
 * If a module ever exports a function that deliberately must NOT be mirrored,
 * that has to become an explicit, commented exception here rather than a name
 * quietly missing from a list.
 */
const MODULE_EXPORTS: Record<string, unknown> = { ...route, ...display };

// A name exported by BOTH modules would silently lose one of the two above, and
// the survivor would be compared twice under one name.
{
  const overlap = Object.keys(route).filter((name) => name in display);
  if (overlap.length > 0) {
    throw new Error(`route.ts and display.ts both export: ${overlap.join(', ')}`);
  }
}

const MIRRORED = Object.keys(MODULE_EXPORTS)
  .filter((name) => typeof MODULE_EXPORTS[name] === 'function')
  .sort();

/**
 * The floor that stops this from passing VACUOUSLY. If the enumeration above
 * ever yields nothing - a renamed module, a changed import, a bundler that
 * hands back an empty namespace - every comparison below would silently cover
 * zero functions and the suite would still be green. Same reasoning as the
 * import-count floor in scripts/smoke-dist.mjs.
 *
 * This is NOT the coverage list: adding a seventh mirrored function does not
 * require touching it.
 */
const MIRRORED_FLOOR = [
  'assertSameOriginPath',
  'buildNotificationOptions',
  'isPlausibleId',
  'notificationTag',
  'resolveSafePath',
  'staleTagsFor',
];

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
  // extractFunction THROWS when a name is missing, so a module export with no
  // counterpart in sw.js fails this file at collection with that name in the
  // message. That throw IS the guard against a forgotten mirror.
  const bodies = MIRRORED.map((name) => extractFunction(swSource, name)).join('\n');
  const factory = new Function(`${bodies}\nreturn { ${MIRRORED.join(', ')} };`);
  return factory() as Record<string, (...args: never[]) => unknown>;
})();

/** Run both copies over the same inputs and require identical output. */
function agreeOn(name: string, impl: (...a: never[]) => unknown, cases: unknown[][]): void {
  // `name` was a union of the six literals while the list was hand-written, so
  // a typo could not compile. Deriving the list costs that check, and this
  // restores it: a name that is not mirrored fails loudly instead of reading
  // `undefined(...)`.
  const fromMirror = mirror[name];
  if (typeof fromMirror !== 'function') {
    throw new Error(`agreeOn("${name}"): not a mirrored function - have ${MIRRORED.join(', ')}`);
  }
  for (const args of cases) {
    expect(
      fromMirror(...(args as never[])),
      `public/sw.js ${name}(${JSON.stringify(args)}) drifted`,
    ).toEqual(impl(...(args as never[])));
  }
}

describe('public/sw.js behaves identically to the modules it cannot import', () => {
  it('derives what must be mirrored from the module exports, not from a list here', () => {
    // The floor, not the coverage list - see MIRRORED_FLOOR. A seventh export
    // arrives in MIRRORED automatically and does not belong here.
    expect(MIRRORED).toEqual(expect.arrayContaining(MIRRORED_FLOOR));
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
    // AN ALERTING KIND WITH NO ID. Added 2026-08-23 after an adversarial review
    // proved the list below it was blind to two branches:
    //
    //   renotify: alerting && Boolean(tag)  ->  renotify: alerting
    //   actions: Array.isArray(...) ? ... : undefined  ->  actions: d.actions
    //
    // both survived the whole comparison. Every payload above either has an id
    // (so `tag` is truthy and the `&& Boolean(tag)` guard cannot be observed) or
    // carries no `actions` at all.
    //
    // The renotify guard is the one public/sw.js calls load-bearing: renotify
    // REQUIRES a tag, and setting it tagless throws. A tagless alerting payload
    // is the only input that can tell the two spellings apart.
    { kind: 'message' },
    // ACTIONS, well-formed and malformed, to exercise the Array.isArray + slice.
    { kind: 'message', conversationId: 'c', actions: [{ action: 'a' }, { action: 'b' }, { action: 'c' }] },
    { kind: 'message', conversationId: 'c', actions: 'not-an-array' },
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
