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
// Read from disk with process.cwd(): vitest's root is the dashboard workspace
// (vite.config.ts lives there and `npm run test -w dashboard` sets the child
// cwd), and both `import ... ?raw` and `new URL(..., import.meta.url)` would be
// rewritten by Vite's asset pipeline. Same pattern as
// src/routes/shared/PeopleCard.test.tsx.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const swSource = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');

describe('public/sw.js mirror carries the inbound-message-push changes', () => {
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
