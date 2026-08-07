import { describe, expect, it } from 'vitest';
import { createOurNumberKind } from '../src/services/ourNumberKind.js';

const BUSINESS = '+15550009999';
const POOL = '+15550109001';

function make(poolNumbers: string[] = []) {
  return createOurNumberKind({
    config: { businessPhoneNumber: BUSINESS },
    conversations: {
      getByPoolNumber: async (n: string) =>
        poolNumbers.includes(n) ? ({ conversationId: 'conv-1' } as never) : undefined,
    },
  });
}

describe('ourNumberKind', () => {
  it("returns 'business' for the configured business number", async () => {
    await expect(make()(BUSINESS)).resolves.toBe('business');
  });

  it("returns 'pool' for a number fronting a relay group", async () => {
    await expect(make([POOL])(POOL)).resolves.toBe('pool');
  });

  it('returns undefined for a stranger', async () => {
    await expect(make([POOL])('+15550100001')).resolves.toBeUndefined();
  });

  it('checks the business number FIRST and never queries the repo for it', async () => {
    let queried = 0;
    const kind = createOurNumberKind({
      config: { businessPhoneNumber: BUSINESS },
      conversations: {
        getByPoolNumber: async () => {
          queried += 1;
          return undefined;
        },
      },
    });
    await expect(kind(BUSINESS)).resolves.toBe('business');
    expect(queried).toBe(0);
  });

  it('still resolves pool numbers when no business number is configured', async () => {
    const kind = createOurNumberKind({
      config: { businessPhoneNumber: undefined },
      conversations: {
        getByPoolNumber: async (n: string) =>
          n === POOL ? ({ conversationId: 'conv-1' } as never) : undefined,
      },
    });
    await expect(kind(POOL)).resolves.toBe('pool');
    await expect(kind(BUSINESS)).resolves.toBeUndefined();
  });
});
