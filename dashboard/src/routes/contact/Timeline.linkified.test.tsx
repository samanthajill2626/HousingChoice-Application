import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Timeline } from './Timeline.js';
import type { TimelineItem } from '../../api/index.js';

function renderTimeline(props: Partial<React.ComponentProps<typeof Timeline>> = {}) {
  const items: TimelineItem[] = props.items ?? [];
  return render(
    <MemoryRouter>
      <Timeline status="ready" items={items} source="server" canSend={false} onSend={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

function message(direction: 'inbound' | 'outbound', type: 'sms' | 'mms' = 'sms'): TimelineItem {
  return {
    kind: 'message',
    id: `${direction}-${type}`,
    at: '2026-09-02T12:00:00.000Z',
    conversationId: 'conv-1',
    tsMsgId: `${direction}-${type}`,
    direction,
    author: direction === 'inbound' ? 'tenant' : 'teammate',
    type,
    delivery_status: 'delivered',
    body: 'Open https://example.com/explicit and example.com/bare/path.',
    ...(direction === 'inbound' ? { fromPhone: '+15550100001' } : { toPhone: '+15550100001' }),
    ...(type === 'mms'
      ? { media_attachments: [{ s3Key: 'attachment', contentType: 'application/pdf' }] }
      : {}),
  };
}

function email(body: string): TimelineItem {
  return {
    kind: 'message',
    id: `email-${body.length}`,
    at: '2026-09-02T12:00:00.000Z',
    conversationId: 'conv-1',
    tsMsgId: `email-${body.length}`,
    direction: 'inbound',
    author: 'tenant',
    type: 'email',
    delivery_status: 'delivered',
    subject: 'Linkified email',
    body,
    email_from: 'tenant@example.com',
    email_to: ['team@housing.example'],
  };
}

describe('Timeline linkified communications', () => {
  it.each([
    ['inbound SMS', 'inbound', 'sms'],
    ['outbound SMS', 'outbound', 'sms'],
    ['inbound MMS', 'inbound', 'mms'],
    ['outbound MMS', 'outbound', 'mms'],
  ] as const)('renders safe links in %s bodies without folding attachments into the text', (_label, direction, type) => {
    renderTimeline({ items: [message(direction, type)] });

    expect(screen.getByRole('link', { name: 'https://example.com/explicit' })).toHaveAttribute(
      'href',
      'https://example.com/explicit',
    );
    const bare = screen.getByRole('link', { name: 'example.com/bare/path' });
    expect(bare).toHaveAttribute('href', 'https://example.com/bare/path');
    expect(bare).toHaveAttribute('target', '_blank');
    expect(bare).toHaveAttribute('rel', 'noopener noreferrer');
    if (type === 'mms') expect(screen.getByText(/1 attachment/)).toBeInTheDocument();
  });

  it('preserves Relay and native-group sender attribution beside linkified bodies', () => {
    const relay = { ...message('outbound'), id: 'relay', relay_sender_key: 'team' };
    const nativeGroup = {
      ...message('inbound'),
      id: 'native-group',
      relay_sender_key: 'phone#+14045550112',
    };

    const { unmount } = renderTimeline({ items: [relay], relayRoster: [] });
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'example.com/bare/path' })).toBeInTheDocument();
    unmount();

    renderTimeline({
      items: [nativeGroup],
      relayRoster: [{ contactId: 'c2', phone: '+14045550112', name: 'Lars Landlord' }],
      rosterKind: 'group_text',
    });
    expect(screen.getByText('Lars Landlord')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'example.com/bare/path' })).toBeInTheDocument();
  });

  it('keeps a link click from revealing bubble metadata while a normal body click reveals it', () => {
    const relay = {
      ...message('outbound'),
      id: 'toggle',
      relay_sender_key: 'team',
      delivery_recipients: { c2: { status: 'delivered' as const } },
    };
    renderTimeline({
      items: [relay],
      relayRoster: [{ contactId: 'c2', phone: '+14045550112', name: 'Lars Landlord' }],
    });

    const link = screen.getByRole('link', { name: 'example.com/bare/path' });
    fireEvent.click(link);
    expect(screen.queryByRole('list', { name: 'Delivery by recipient' })).not.toBeInTheDocument();

    fireEvent.click(link.parentElement as HTMLElement);
    expect(screen.getByRole('list', { name: 'Delivery by recipient' })).toBeInTheDocument();
  });

  it('clips the collapsed email link label while retaining its complete safe destination in both email views', () => {
    // The link must have a real parser boundary before it. A prefix of only word
    // characters would make the parser correctly treat that prefix as part of
    // the bare domain; this keeps the URL's source start at 126.
    const prefix = `${'x'.repeat(125)} `;
    const completeUrl = 'example.com/a/complete/path?unit=2#photos';
    const body = `${prefix}${completeUrl} after`;
    renderTimeline({ items: [email(body)] });

    const collapsed = screen.getByRole('link', { name: body.slice(126, 140) });
    expect(collapsed).toHaveAttribute('href', `https://${completeUrl}`);
    expect(collapsed.parentElement).toHaveTextContent(`${body.slice(0, 140).trimEnd()}...`);

    const details = screen.getByText('View full email').closest('details');
    expect(details).not.toBeNull();
    fireEvent.click(within(details as HTMLElement).getByText('View full email'));
    expect(within(details as HTMLElement).getByRole('link', { name: completeUrl })).toHaveAttribute(
      'href',
      `https://${completeUrl}`,
    );
  });

  it('retains the current email whitespace truncation markers', () => {
    const trailingWhitespace = `${'y'.repeat(138)}  z`;
    const { unmount } = renderTimeline({ items: [email(trailingWhitespace)] });
    expect(screen.getByText(`${'y'.repeat(138)}...`, { exact: true })).toBeInTheDocument();
    unmount();

    renderTimeline({ items: [email(' '.repeat(141))] });
    expect(screen.getByText('...', { exact: true })).toBeInTheDocument();
  });

  it('preserves trailing source whitespace in an untruncated collapsed email snippet', () => {
    const body = 'Please review the property details.  \t ';
    expect(body.length).toBeLessThanOrEqual(140);
    renderTimeline({ items: [email(body)] });

    expect(document.querySelector('[class*="emailSnippet"]')?.textContent).toBe(body);
  });
});
