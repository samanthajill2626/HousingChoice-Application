import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeOwnedSessionState } from '../../scripts/lib/sessionState.mjs';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persistent e2e session state', () => {
  it('removes only the matching launcher pid and retains lane.json for e2e:stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-e2e-session-state-'));
    roots.push(root);
    const pidFile = join(root, 'session.pid');
    const laneFile = join(root, 'lane.json');
    await writeFile(pidFile, '4321', 'utf8');
    await writeFile(laneFile, JSON.stringify({ launcherPid: 4321, lane: 3 }), 'utf8');

    removeOwnedSessionState({ pidFile, laneFile, launcherPid: 4321 });

    await expect(readFile(pidFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(laneFile, 'utf8'))).toEqual({ launcherPid: 4321, lane: 3 });
  });
});
