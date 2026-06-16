// useQuickReplyTarget tests (M1.9 seam) — resolving a quick-reply target from a
// callId and/or a conversationId. The api endpoint functions are mocked; the
// real useApi/ApiError run.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallResponse, Conversation, Message } from '../../api/index.js';

const { getConversation, getCall } = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getCall: vi.fn(),
}));

vi.mock('../../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/index.js')>();
  return { ...actual, getConversation, getCall };
});

const { useQuickReplyTarget } = await import('./useQuickReplyTarget.js');

const CONV_ID = 'conv-123';
const CALL_ID = 'CA-abc';

const CONVERSATION: Conversation = {
  conversationId: CONV_ID,
  participant_phone: '+15555550123',
  status: 'open',
  last_activity_at: '2026-06-13T00:00:00.000Z',
  type: 'tenant_1to1',
  ai_mode: 'manual',
  created_at: '2026-06-13T00:00:00.000Z',
};

const CALL_MESSAGE: Message = {
  conversationId: CONV_ID,
  tsMsgId: 'tc#CA-abc',
  type: 'call',
  direction: 'inbound',
  author: 'unknown',
  provider_sid: CALL_ID,
  provider_ts: '2026-06-13T00:00:00.000Z',
  delivery_status: 'queued',
  call_outcome: 'missed',
  masked: true,
  call_party_label: 'Tenant',
  created_at: '2026-06-13T00:00:00.000Z',
};

beforeEach(() => {
  getConversation.mockReset().mockResolvedValue(CONVERSATION);
  getCall.mockReset().mockResolvedValue({ call: CALL_MESSAGE, conversation: CONVERSATION } satisfies CallResponse);
});

afterEach(() => vi.clearAllMocks());

describe('useQuickReplyTarget', () => {
  it('resolves a callId to its conversation via getCall (M1.9 seam)', async () => {
    const { result } = renderHook(() => useQuickReplyTarget(CALL_ID, null));

    await waitFor(() => expect(result.current.kind).toBe('conversation'));
    expect(getCall).toHaveBeenCalledWith(CALL_ID, expect.anything());
    // The conversation came from the call response — no separate getConversation.
    expect(getConversation).not.toHaveBeenCalled();
    expect(result.current.conversationId).toBe(CONV_ID);
    expect(result.current.conversation?.participant_phone).toBe('+15555550123');
  });

  it('prefers an explicit conversationId (the M1.4 path) over the callId', async () => {
    const { result } = renderHook(() => useQuickReplyTarget(CALL_ID, CONV_ID));

    await waitFor(() => expect(result.current.kind).toBe('conversation'));
    expect(getConversation).toHaveBeenCalledWith(CONV_ID, expect.anything());
    expect(getCall).not.toHaveBeenCalled();
    expect(result.current.conversationId).toBe(CONV_ID);
  });

  it('reports the honest missing-conversation state when the call has no conversation', async () => {
    getCall.mockResolvedValue({ call: CALL_MESSAGE, conversation: null });
    const { result } = renderHook(() => useQuickReplyTarget(CALL_ID, null));

    await waitFor(() => expect(result.current.kind).toBe('missing_conversation'));
    expect(result.current.conversationId).toBeUndefined();
    expect(result.current.conversation).toBeUndefined();
  });

  it('reports an error when getCall rejects (unknown CallSid)', async () => {
    const { ApiError } = await import('../../api/index.js');
    getCall.mockRejectedValue(new ApiError(404, 'call_not_found', 'call_not_found'));
    const { result } = renderHook(() => useQuickReplyTarget(CALL_ID, null));

    await waitFor(() => expect(result.current.kind).toBe('error'));
    expect(result.current.error?.code).toBe('call_not_found');
  });

  it('reports no_call_api when neither a callId nor a conversationId is given', async () => {
    const { result } = renderHook(() => useQuickReplyTarget(undefined, null));

    await waitFor(() => expect(result.current.kind).toBe('no_call_api'));
    expect(getCall).not.toHaveBeenCalled();
    expect(getConversation).not.toHaveBeenCalled();
  });
});
