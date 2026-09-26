// AD-8: the dashboard's MAX_PAGE_LIMIT mirrors the server's MAX_INBOX_LIMIT.
// headComplete (inboxListMerge.ts) judges a head read against the REQUESTED
// limit, so if the server ever served fewer rows than the dashboard may ask
// for, every full head read would classify as incomplete: no row would ever be
// removed and the first cursor would be kept for the life of the mount. The
// two constants live in different workspaces, so this reads both sources.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));

function constantIn(file: string, name: string): number {
  const match = readFileSync(file, 'utf8').match(new RegExp(`export const ${name} = (\\d+);`));
  expect(match, `missing "export const ${name} = <n>;" in ${file}`).not.toBeNull();
  return Number(match![1]);
}

describe('inbox page-size limits', () => {
  it('MAX_PAGE_LIMIT (dashboard) equals MAX_INBOX_LIMIT (server)', () => {
    const dashboard = constantIn(join(testDir, 'useInbox.ts'), 'MAX_PAGE_LIMIT');
    const server = constantIn(join(testDir, '../../../../app/src/routes/inbox.ts'), 'MAX_INBOX_LIMIT');
    expect(dashboard).toBe(server);
  });
});
