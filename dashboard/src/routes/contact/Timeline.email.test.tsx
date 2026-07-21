import { fireEvent, render, screen } from '@testing-library/react';
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

// A sid-bearing tsMsgId ("<ts>#<sid>") is what lets the gallery derive a servable
// media URL and render per-file links (no "#" -> a count chip instead).
const EMAIL_IN: TimelineItem = {
  kind: 'message',
  id: 'e1',
  at: '2026-06-08T09:14:00',
  conversationId: 'c1',
  tsMsgId: '2026-06-08T09:14:00#EM123',
  direction: 'inbound',
  author: 'tenant',
  type: 'email',
  delivery_status: 'delivered',
  subject: 'Re: 1450 Joseph Blvd',
  body: 'Yes, Tuesday at 3pm works for the tour.',
  email_from: 'renter@example.com',
  email_to: ['team@housing.example'],
};

describe('EmailCard (inbound)', () => {
  it('renders the EMAIL tag, subject, snippet, and the sender line', () => {
    renderTimeline({ items: [EMAIL_IN] });
    expect(screen.getByText('EMAIL')).toBeInTheDocument();
    expect(screen.getByText('Re: 1450 Joseph Blvd')).toBeInTheDocument();
    expect(screen.getByText('Yes, Tuesday at 3pm works for the tour.')).toBeInTheDocument();
    // Inbound shows the sender; no delivery chip (delivery is outbound-only).
    expect(screen.getByText(/from renter@example.com/)).toBeInTheDocument();
  });

  it('shows a "New address" chip only when email_new_address is set', () => {
    const { unmount } = renderTimeline({ items: [EMAIL_IN] });
    expect(screen.queryByText('New address')).not.toBeInTheDocument();
    unmount();
    renderTimeline({ items: [{ ...EMAIL_IN, email_new_address: true }] });
    expect(screen.getByText('New address')).toBeInTheDocument();
  });

  it('does NOT offer "View original formatting" (or an iframe) when no sanitized HTML is present', () => {
    renderTimeline({ items: [EMAIL_IN] });
    expect(screen.queryByText('View original formatting')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Email message')).not.toBeInTheDocument();
  });

  it('LAZILY mounts the sandboxed HTML frame: absent until "View original formatting" opens', async () => {
    renderTimeline({
      items: [{ ...EMAIL_IN, email_html_sanitized: '<p>Yes, <b>Tuesday</b> works.</p>' }],
    });
    // Collapsed: the disclosure exists but the iframe is NOT in the DOM (lazy).
    expect(screen.getByText('View original formatting')).toBeInTheDocument();
    expect(screen.queryByTitle('Email message')).not.toBeInTheDocument();
    // Opening the disclosure mounts the fully-sandboxed frame.
    fireEvent.click(screen.getByText('View original formatting'));
    const frame = await screen.findByTitle('Email message');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame.getAttribute('srcdoc') ?? '').toContain("default-src 'none'");
  });
});

describe('AttachmentGallery filename labels (fix-wave R1)', () => {
  it('uses the persisted filename when present, else falls back to "Attachment N"', () => {
    renderTimeline({
      items: [
        {
          ...EMAIL_IN,
          media_attachments: [
            { s3Key: 'k0', contentType: 'application/pdf', filename: 'lease agreement.pdf' },
            { s3Key: 'k1', contentType: 'application/octet-stream' },
          ],
        },
      ],
    });
    // The named attachment shows its filename; the unnamed one keeps the fallback.
    expect(screen.getByText(/lease agreement\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/Attachment 2/)).toBeInTheDocument();
  });

  it('keeps MMS behavior unchanged when a filename is absent', () => {
    const mms: TimelineItem = {
      kind: 'message',
      id: 'mms1',
      at: '2026-06-08T09:20:00',
      conversationId: 'c1',
      tsMsgId: '2026-06-08T09:20:00#MM99',
      direction: 'inbound',
      author: 'tenant',
      type: 'mms',
      delivery_status: 'delivered',
      body: 'pic',
      fromPhone: '+14040100007',
      media_attachments: [{ s3Key: 'k0', contentType: 'application/octet-stream' }],
    };
    renderTimeline({ items: [mms] });
    expect(screen.getByText(/Attachment 1/)).toBeInTheDocument();
  });
});
