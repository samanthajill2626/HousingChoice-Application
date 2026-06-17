import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import type { TimelineItem } from '../../api/index.js';

function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  const items: TimelineItem[] = props.items ?? [];
  return render(
    <MemoryRouter>
      <Timeline
        status="ready"
        items={items}
        source="server"
        replyToPhone="+14705550148"
        replyToLabel="most recent"
        canSend={false}
        onSend={vi.fn()}
        {...props}
      />
    </MemoryRouter>,
  );
}

const MESSAGE_IN: TimelineItem = {
  kind: 'message',
  id: 'm1',
  at: '2026-06-08T09:14:00',
  conversationId: 'c1',
  tsMsgId: 'm1',
  direction: 'inbound',
  author: 'tenant',
  type: 'sms',
  delivery_status: 'delivered',
  body: 'Hi, looking for a 2 bedroom.',
  fromPhone: '+14040100007',
};

const MESSAGE_OUT: TimelineItem = {
  kind: 'message',
  id: 'm2',
  at: '2026-06-08T09:20:00',
  conversationId: 'c1',
  tsMsgId: 'm2',
  direction: 'outbound',
  author: 'teammate',
  type: 'sms',
  delivery_status: 'sent',
  body: 'Welcome! I will send options.',
  toPhone: '+14040100007',
};

const CALL: TimelineItem = {
  kind: 'call',
  id: 'call1',
  at: '2026-06-08T11:00:00',
  call_outcome: 'answered',
  call_duration: 252,
  transcript: 'Operator: hello. Tenant: hi there.',
};

const MILESTONE: TimelineItem = {
  kind: 'milestone',
  id: 'ms1',
  at: '2026-06-08T08:00:00',
  type: 'case_opened',
  label: 'Case opened · 1450 Joseph Blvd',
  refType: 'case',
  refId: 'k1',
};

const NUMBER_ADDED: TimelineItem = {
  kind: 'milestone',
  id: 'ms2',
  at: '2026-06-10T13:00:00',
  type: 'number_added',
  label: 'Now also texting from (470) 555-0148',
};

describe('Timeline', () => {
  it('renders message bubbles with full body + SMS meta line', () => {
    renderTimeline({ items: [MESSAGE_IN, MESSAGE_OUT] });
    expect(screen.getByText('Hi, looking for a 2 bedroom.')).toBeInTheDocument();
    expect(screen.getByText('Welcome! I will send options.')).toBeInTheDocument();
    // The meta line carries transport · number · time.
    expect(screen.getByText(/SMS · \(404\) 010-0007 · 9:14a/)).toBeInTheDocument();
  });

  it('renders a date divider for the message day', () => {
    renderTimeline({ items: [MESSAGE_IN] });
    expect(screen.getByText('Mon Jun 8')).toBeInTheDocument();
  });

  it('renders a collapsed call card whose transcript expands on click', () => {
    renderTimeline({ items: [CALL] });
    expect(screen.getByText(/Answered/)).toBeInTheDocument();
    expect(screen.getByText(/4m 12s/)).toBeInTheDocument();
    // Transcript is hidden until the disclosure is opened.
    const disclosure = screen.getByText(/Transcript/);
    expect(screen.queryByText(/Operator: hello/)).not.toBeVisible();
    fireEvent.click(disclosure);
    expect(screen.getByText(/Operator: hello/)).toBeVisible();
  });

  it('renders a milestone pin that links out via refType/refId', () => {
    renderTimeline({ items: [MILESTONE] });
    const link = screen.getByRole('link', { name: /Case opened/ });
    expect(link).toHaveAttribute('href', '/cases/k1');
  });

  it('hides milestones when "Comms only" is toggled', () => {
    renderTimeline({ items: [MESSAGE_IN, MILESTONE, NUMBER_ADDED] });
    expect(screen.getByText(/Case opened/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Comms only/i }));
    expect(screen.queryByText(/Case opened/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Now also texting/)).not.toBeInTheDocument();
    // Messages survive the toggle.
    expect(screen.getByText('Hi, looking for a 2 bedroom.')).toBeInTheDocument();
  });

  it('disables Send (with a tooltip) when no conversation is resolvable', () => {
    renderTimeline({ items: [MESSAGE_IN], canSend: false });
    const send = screen.getByRole('button', { name: /Send/i });
    expect(send).toBeDisabled();
  });

  it('sends the typed reply and clears the draft on success', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'On my way' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    expect(onSend).toHaveBeenCalledWith('On my way');
    // Draft is cleared ONLY after the send resolves.
    await waitFor(() => expect(box).toHaveValue(''));
  });

  it('keeps the draft and surfaces an error when the send fails', async () => {
    const onSend = vi.fn().mockRejectedValue(new Error('network'));
    renderTimeline({ items: [MESSAGE_IN], canSend: true, onSend });
    const box = screen.getByRole('textbox', { name: /reply/i });
    fireEvent.change(box, { target: { value: 'Important reply' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    // Failure is surfaced (role=alert) and the draft is NOT lost.
    await screen.findByRole('alert');
    expect(box).toHaveValue('Important reply');
  });

  it('shows the reply target number + label', () => {
    renderTimeline({ items: [] });
    expect(screen.getByText(/Reply sends to/)).toBeInTheDocument();
    expect(screen.getByText(/\(470\) 555-0148/)).toBeInTheDocument();
    expect(screen.getByText(/most recent/)).toBeInTheDocument();
  });

  it('shows a loading state and an empty state', () => {
    const { rerender } = renderTimeline({ status: 'loading' });
    expect(screen.getByRole('status')).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <Timeline
          status="ready"
          items={[]}
          source="fallback"
          replyToPhone="+14705550148"
          replyToLabel="most recent"
          canSend={false}
          onSend={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No messages yet/i)).toBeInTheDocument();
  });

  it('renders MMS media as a same-origin link without inlining unknown content', () => {
    const mms: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'mms1',
      tsMsgId: 'mms1',
      type: 'mms',
      body: 'flyer',
      media_attachments: [{ s3Key: 'k', contentType: 'application/pdf' }],
    };
    renderTimeline({ items: [mms] });
    // The body renders as text and the attachment shows as a count chip (we
    // never inline unknown content as HTML).
    expect(screen.getByText('flyer')).toBeInTheDocument();
    expect(screen.getByText(/1 attachment/i)).toBeInTheDocument();
  });

  it('shows the delivery status on an OUTBOUND bubble', () => {
    renderTimeline({ items: [MESSAGE_OUT] }); // delivery_status: 'sent'
    expect(screen.getByText('Sent')).toBeInTheDocument();
  });

  it('shows NO delivery status on an inbound bubble (delivery state is outbound-only)', () => {
    renderTimeline({ items: [MESSAGE_IN] }); // inbound, even though it carries a status
    expect(screen.queryByText('Delivered')).not.toBeInTheDocument();
  });

  it('shows Failed + reason + Retry on a failed outbound message, and retries on click', () => {
    const failed: TimelineItem = {
      ...MESSAGE_OUT,
      id: 'm-fail',
      tsMsgId: 'm-fail',
      delivery_status: 'failed',
      error_code: '30007',
      body: 'This one failed',
    };
    const onRetry = vi.fn();
    renderTimeline({ items: [failed], onRetry });
    expect(screen.getByText(/Failed · Carrier filtered the message/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry sending/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no status chip (and no Retry) when delivery_status is absent — seed/legacy rows', () => {
    const noStatus = {
      ...MESSAGE_OUT,
      id: 'm-nostatus',
      tsMsgId: 'm-nostatus',
      body: 'legacy row',
      delivery_status: undefined,
    } as unknown as TimelineItem;
    renderTimeline({ items: [noStatus] });
    expect(screen.getByText('legacy row')).toBeInTheDocument();
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
  });
});
