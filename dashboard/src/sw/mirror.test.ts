// Mirror smoke test for public/sw.js.
//
// The classic worker (public/sw.js) cannot import the tested ES modules -
// it carries VERBATIM mirrors of src/sw/display.ts and src/sw/route.ts. The
// modules are what is tested; the mirror is what actually RUNS in the browser,
// so a forgotten mirror ships tested-but-dead logic. Nothing else verifies the
// copy, and sw.js has been lost wholesale before (its own header says so).
//
// This pins the NEW code lines of the inbound-message-push feature into the
// shipped artifact as EXACT code fragments a comment cannot satisfy. It is NOT
// a full source-equality check (out of scope by spec 3.5); the mirror
// deliberately differs from the TS source in small ways (no `export`, no
// types, `data || {}` instead of `data ?? {}`).
//
// Read from disk relative to THIS FILE, not to process.cwd(): the sanctioned
// gate is `npm run test -w dashboard` (whose child cwd is the workspace), but
// anyone driving vitest straight from the repo root would otherwise hard-fail
// this file at collection time on a missing path. `fileURLToPath` +
// `import.meta.url` is a plain Node path computation, so - unlike
// `import ... ?raw` or `new URL(..., import.meta.url)` - Vite's asset pipeline
// does not rewrite it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/sw/ -> ../../public/sw.js
const swPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'sw.js');
const swSource = readFileSync(swPath, 'utf8');

describe('public/sw.js mirror carries the inbound-message-push changes', () => {
  it('uses runtime identity for the main icon and preserves the monochrome badge', () => {
    expect(swSource).toContain("icon: '/app-identity/icon-192.png'");
    expect(swSource).toContain("badge: '/icons/badge-72.png'");
    expect(swSource).not.toContain("icon: '/icons/icon-192.png'");
  });

  it('has the queue-level unmatched_email tag branch', () => {
    expect(swSource).toContain("if (d.kind === 'unmatched_email') return 'unmatched_email';");
  });

  it('has the alerting renotify set', () => {
    expect(swSource).toContain(
      "const alerting = timeSensitive || d.kind === 'message' || d.kind === 'unmatched_email';",
    );
    expect(swSource).toContain('renotify: alerting && Boolean(tag),');
  });

  it('keeps requireInteraction on the time-sensitive set only', () => {
    expect(swSource).toContain('requireInteraction: timeSensitive,');
  });

  it('routes unmatched_email to /email', () => {
    expect(swSource).toContain("if (d.kind === 'unmatched_email') {");
    expect(swSource).toContain("return '/email';");
  });

  it('allowlists exact /email', () => {
    expect(swSource).toContain("url.pathname === '/email'");
  });
});

describe('public/sw.js mirror carries the missed-call quick-reply routing', () => {
  // The one-tap sheet is USELESS if only the TS module learned about it: the
  // mirror is what the phone runs, so a forgotten copy here means every
  // missed-call tap keeps landing on the conversation and the Android action
  // buttons keep doing nothing - silently, and exactly like the regression this
  // feature exists to undo.
  it('has the missed_call branch, gated on the callId', () => {
    expect(swSource).toContain("if (d.kind === 'missed_call' && isPlausibleId(d.callId)) {");
  });

  it('builds the quick-reply target from the callId ALONE', () => {
    expect(swSource).toContain('const path = `/quick-reply/${encodeURIComponent(d.callId)}`;');
    // The target must never name a recipient - see the note in src/sw/route.ts.
    expect(swSource).not.toContain('conversationId=$');
  });

  it('keeps isPlausibleId byte-identical in effect to the module (incl. DEL)', () => {
    // A pre-existing one-character drift: the module rejected \x7f and the
    // mirror did not, which is exactly the silent divergence this file exists
    // to prevent.
    expect(swSource).toContain('\\x00-\\x1f\\x7f]');
  });

  it('carries a PLAUSIBLE action id as the #action hash, and drops any other', () => {
    expect(swSource).toContain(
      'return isPlausibleId(action) ? `${path}#action=${encodeURIComponent(action)}` : path;',
    );
    // The retired `void action;` line meant the worker ignored action buttons.
    expect(swSource).not.toContain('void action;');
  });

  it('allowlists the single-segment quick-reply path', () => {
    expect(swSource).toContain('/^\\/quick-reply\\/[^/]+$/.test(url.pathname)');
  });
});
