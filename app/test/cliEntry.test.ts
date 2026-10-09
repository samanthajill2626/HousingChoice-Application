// The "run as a CLI?" guard shared by e2e/support/lane.mjs,
// app/scripts/db-create.ts and app/scripts/db-update-gsis.ts
// (scripts/lib/cliEntry.mjs). Its predecessor built `file:///${argv1}`, which
// only worked on Windows: on POSIX it produced `file:////home/...`, so all
// three silently did nothing and `npm run e2e` died before any test ran.
// Both path flavours are pinned here on whichever platform runs the suite.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

// Plain .mjs module outside the app workspace (typed by cliEntry.d.mts).
import { isMainModule } from '../../scripts/lib/cliEntry.mjs';

const CLI_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'lib', 'cliEntry.mjs');

describe('isMainModule', () => {
  it('matches a Windows-style absolute argv[1] (backslashes, drive letter, a space)', () => {
    expect(
      isMainModule(
        'file:///C:/Users/Jane%20Doe/HC/e2e/support/lane.mjs',
        'C:\\Users\\Jane Doe\\HC\\e2e\\support\\lane.mjs',
        { windows: true },
      ),
    ).toBe(true);
  });

  it('matches a POSIX absolute argv[1] - the case the old form got wrong (four slashes)', () => {
    expect(
      isMainModule('file:///home/user/HC/e2e/support/lane.mjs', '/home/user/HC/e2e/support/lane.mjs', {
        windows: false,
      }),
    ).toBe(true);
  });

  it('does not match when argv[1] names another module (the importer case)', () => {
    expect(
      isMainModule('file:///C:/HC/app/scripts/db-create.ts', 'C:\\HC\\node_modules\\vitest\\vitest.mjs', {
        windows: true,
      }),
    ).toBe(false);
    expect(
      isMainModule('file:///home/user/HC/app/scripts/db-create.ts', '/home/user/HC/node_modules/vitest/vitest.mjs', {
        windows: false,
      }),
    ).toBe(false);
  });

  it('is false with no argv[1] (node -e, a REPL)', () => {
    expect(isMainModule('file:///home/user/HC/e2e/support/lane.mjs', undefined)).toBe(false);
    expect(isMainModule('file:///home/user/HC/e2e/support/lane.mjs', '')).toBe(false);
  });

  it('agrees with real Node on this platform: true when run, false when imported', () => {
    // Realpath the temp dir: Node realpaths the main module (macOS tmpdir is
    // a symlink), and that is not what this case is about.
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hc-cli-entry-')));
    try {
      const script = path.join(dir, 'probe.mjs');
      writeFileSync(
        script,
        `import { isMainModule } from ${JSON.stringify(pathToFileURL(CLI_ENTRY).href)};\n` +
          `process.stdout.write(String(isMainModule(import.meta.url)));\n`,
      );
      const importer = path.join(dir, 'importer.mjs');
      writeFileSync(importer, `import './probe.mjs';\n`);
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
      expect(run.stderr).toBe('');
      expect(run.stdout).toBe('true');
      const imported = spawnSync(process.execPath, [importer], { encoding: 'utf8' });
      expect(imported.stderr).toBe('');
      expect(imported.stdout).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
