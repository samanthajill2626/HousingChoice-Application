import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationParticipant } from '../../api';

// Mock the api barrel: stub the network functions, keep ApiError real.
const api = vi.hoisted(() => ({
  getRelayMembers: vi.fn(),
  addRelayMember: vi.fn(),
  removeRelayMember: vi.fn(),
}));

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof import('../../api')>('../../api');
  return {
    ...actual,
    getRelayMembers: api.getRelayMembers,
    addRelayMember: api.addRelayMember,
    removeRelayMember: api.removeRelayMember,
  };
});

const { useRelayMembers } = await import('./useRelayMembers');

const ALICE: ConversationParticipant = { contactId: 'c-alice', phone: '+13135550001', name: 'Alice' };
const BOB: ConversationParticipant = { contactId: '', phone: '+13135550002' };

beforeEach(() => {
  api.getRelayMembers.mockReset();
  api.addRelayMember.mockReset();
  api.removeRelayMember.mockReset();
});

describe('useRelayMembers', () => {
  it('loads the roster on mount when enabled', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE, BOB]);
    const { result } = renderHook(() => useRelayMembers('conv-1', true));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.members).toEqual([ALICE, BOB]);
    expect(api.getRelayMembers).toHaveBeenCalledWith('conv-1', expect.anything());
  });

  it('does NOT fetch when disabled (1:1 thread)', async () => {
    const { result } = renderHook(() => useRelayMembers('conv-1', false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.getRelayMembers).not.toHaveBeenCalled();
    expect(result.current.members).toEqual([]);
  });

  it('add() posts and adopts the returned roster', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE]);
    api.addRelayMember.mockResolvedValue([ALICE, BOB]);
    const { result } = renderHook(() => useRelayMembers('conv-1', true));
    await waitFor(() => expect(result.current.members).toEqual([ALICE]));

    await act(async () => {
      await result.current.add({ phone: '+13135550002' });
    });

    expect(api.addRelayMember).toHaveBeenCalledWith('conv-1', { phone: '+13135550002' });
    expect(result.current.members).toEqual([ALICE, BOB]);
  });

  it('remove() deletes and adopts the returned roster', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE, BOB]);
    api.removeRelayMember.mockResolvedValue([ALICE]);
    const { result } = renderHook(() => useRelayMembers('conv-1', true));
    await waitFor(() => expect(result.current.members).toEqual([ALICE, BOB]));

    await act(async () => {
      await result.current.remove('+13135550002');
    });

    expect(api.removeRelayMember).toHaveBeenCalledWith('conv-1', '+13135550002');
    expect(result.current.members).toEqual([ALICE]);
  });

  it('ingestRoster() updates the roster live (SSE) without a refetch', async () => {
    api.getRelayMembers.mockResolvedValue([ALICE]);
    const { result } = renderHook(() => useRelayMembers('conv-1', true));
    await waitFor(() => expect(result.current.members).toEqual([ALICE]));

    // Simulate a conversation.updated event carrying the fresh roster.
    act(() => {
      result.current.ingestRoster([ALICE, BOB]);
    });

    expect(result.current.members).toEqual([ALICE, BOB]);
    // No second GET — the event roster was preferred.
    expect(api.getRelayMembers).toHaveBeenCalledTimes(1);
  });

  it('surfaces a load error', async () => {
    const { ApiError } = await vi.importActual<typeof import('../../api')>('../../api');
    api.getRelayMembers.mockRejectedValue(new ApiError(404, 'relay_group_not_found', 'nope'));
    const { result } = renderHook(() => useRelayMembers('conv-1', true));

    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.code).toBe('relay_group_not_found');
  });
});
