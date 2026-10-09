// scripts/lib/npmCli.mjs - how scripts/e2e-session.mjs finds npm-cli.js to
// build the fake-phones UI. It used to assume the Windows layout, which does
// not exist on Linux. The filesystem is stubbed so both layouts are pinned
// on whichever platform runs the suite.
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Plain .mjs module outside the app workspace (typed by npmCli.d.mts).
import { resolveNpmCli } from '../../scripts/lib/npmCli.mjs';

const PREFIX = path.resolve('/opt', 'node24');
const WINDOWS_NODE = path.join(PREFIX, 'node.exe');
const WINDOWS_NPM = path.join(PREFIX, 'node_modules', 'npm', 'bin', 'npm-cli.js');
const POSIX_NODE = path.join(PREFIX, 'bin', 'node');
const POSIX_NPM = path.join(PREFIX, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const ENV_NPM = path.resolve('/elsewhere', 'npm', 'bin', 'npm-cli.js');

const only = (...present: string[]) => (candidate: string) => present.includes(candidate);

describe('resolveNpmCli', () => {
  it('prefers npm_execpath - the npm actually running this script', () => {
    expect(
      resolveNpmCli({ env: { npm_execpath: ENV_NPM }, execPath: POSIX_NODE, exists: only(ENV_NPM, POSIX_NPM) }),
    ).toBe(ENV_NPM);
  });

  it('ignores an npm_execpath that is npx-cli.js (npx run build is not npm run build)', () => {
    const npx = path.resolve('/elsewhere', 'npm', 'bin', 'npx-cli.js');
    expect(resolveNpmCli({ env: { npm_execpath: npx }, execPath: POSIX_NODE, exists: only(npx, POSIX_NPM) })).toBe(
      POSIX_NPM,
    );
  });

  it('finds the Windows layout: npm beside node.exe', () => {
    expect(resolveNpmCli({ env: {}, execPath: WINDOWS_NODE, exists: only(WINDOWS_NPM) })).toBe(WINDOWS_NPM);
  });

  it('finds the POSIX layout: <prefix>/lib/node_modules beside <prefix>/bin/node', () => {
    expect(resolveNpmCli({ env: {}, execPath: POSIX_NODE, exists: only(POSIX_NPM) })).toBe(POSIX_NPM);
  });

  it('falls back to the layouts when npm_execpath names a missing file', () => {
    expect(resolveNpmCli({ env: { npm_execpath: ENV_NPM }, execPath: POSIX_NODE, exists: only(POSIX_NPM) })).toBe(
      POSIX_NPM,
    );
  });

  it('throws, naming every place it looked, when there is no npm', () => {
    expect(() => resolveNpmCli({ env: {}, execPath: POSIX_NODE, exists: () => false })).toThrow(POSIX_NPM);
  });

  it('resolves the real npm on this machine', () => {
    expect(path.basename(resolveNpmCli())).toBe('npm-cli.js');
  });
});
