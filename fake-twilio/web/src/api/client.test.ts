import { describe, expect, it, vi, afterEach } from 'vitest';
import { getGroups, getPersonas, sendAsParty, addAdHoc } from './client.js';

afterEach(() => vi.restoreAllMocks());

describe('control client', () => {
  it('getPersonas GETs /control/personas and returns the array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              personas: [
                { id: 'a', label: 'A', role: 'tenant', number: '+15550100001', adHoc: false },
              ],
            }),
            { status: 200 },
          ),
      ),
    );
    const personas = await getPersonas();
    expect(personas[0]?.number).toBe('+15550100001');
  });
  it('sendAsParty POSTs the body and returns sid', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ sid: 'SMx' }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const sid = await sendAsParty({ from: '+15550100001', body: 'hi' });
    expect(sid).toBe('SMx');
    expect(f).toHaveBeenCalledWith('/control/send-as-party', expect.objectContaining({ method: 'POST' }));
  });
  it('getGroups GETs /control/groups and returns the array', async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            groups: [
              {
                poolNumber: '+15550160001',
                members: [{ number: '+15550170001', label: 'Diana Osei' }],
                entries: [],
                lastActivityAt: '2026-06-15T00:00:00.000Z',
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', f);
    const groups = await getGroups();
    expect(groups[0]?.poolNumber).toBe('+15550160001');
    expect(f).toHaveBeenCalledWith('/control/groups');
  });
  it('addAdHoc throws with the server error message on 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'bad number' }), { status: 400 })),
    );
    await expect(addAdHoc({ label: 'x', role: 'tenant', number: 'nope' })).rejects.toThrow(/bad number/);
  });
});
