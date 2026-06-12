// Scaffold smoke test: proves vitest wiring works and the workspace manifests
// are consistent. Uses fs/promises (async) — readFileSync is banned in app/src
// by the streams-only lint guideline, and we keep tests consistent with that.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('scaffold', () => {
  it('app package.json is the @housingchoice/app workspace', async () => {
    const raw = await fs.readFile(path.join(here, '../package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe('@housingchoice/app');
  });

  it('root package.json pins name and Node engine', async () => {
    const raw = await fs.readFile(path.join(here, '../../package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    expect(pkg.name).toBe('housingchoice');
    expect(pkg.engines.node).toBe('>=24');
  });
});
