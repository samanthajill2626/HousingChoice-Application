import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnmatchedEmailItem, UnmatchedEmailRow } from '../../api/index.js';

const getUnmatchedEmailDetail = vi.fn();

vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    getUnmatchedEmailDetail: (...args: unknown[]) => getUnmatchedEmailDetail(...args),
  };
});

import { UnmatchedRow } from './UnmatchedRow.js';

function makeRow(overrides: Partial<UnmatchedEmailRow> = {}): UnmatchedEmailRow {
  return {
    unmatchedId: 'email-1',
    status: 'unmatched',
    from: { address: 'stranger@example.com' },
    subject: 'Link in an email',
    snippet: 'Preview example.com/preview must stay text.',
    attachments_meta: [{ filename: 'lease.pdf', contentType: 'application/pdf', size: 1024 }],
    received_at: '2026-09-02T12:00:00.000Z',
    read: false,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<UnmatchedEmailItem> = {}): UnmatchedEmailItem {
  return {
    ...makeRow(),
    text: 'Please review example.com/full/path.',
    html_sanitized: '<p>Original formatting</p>',
    ...overrides,
  };
}

function renderRow(row = makeRow()) {
  const callbacks = {
    onMarkRead: vi.fn(),
    onLink: vi.fn(),
    onNewContact: vi.fn(),
    onSpam: vi.fn(),
    onDismiss: vi.fn(),
    onRelease: vi.fn(),
    onDelete: vi.fn(),
  };
  const rendered = render(<UnmatchedRow row={row} filter="unmatched" {...callbacks} />);
  return { ...rendered, callbacks };
}

beforeEach(() => {
  getUnmatchedEmailDetail.mockReset().mockResolvedValue(makeDetail());
});

afterEach(() => vi.restoreAllMocks());

describe('UnmatchedRow', () => {
  it('linkifies only the loaded plain-text detail while retaining the raw header preview and detail affordances', async () => {
    const { container, callbacks } = renderRow();
    const header = container.querySelector('button[class*="main"]');
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).getByText('Preview example.com/preview must stay text.')).toBeInTheDocument();
    expect(within(header as HTMLElement).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();

    fireEvent.click(header as HTMLButtonElement);

    expect(getUnmatchedEmailDetail).toHaveBeenCalledWith('email-1');
    expect(callbacks.onMarkRead).toHaveBeenCalledTimes(1);

    const link = await screen.findByRole('link', { name: 'example.com/full/path' });
    expect(link).toHaveAttribute('href', 'https://example.com/full/path');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link.nextSibling).toMatchObject({ nodeType: Node.TEXT_NODE, nodeValue: '.' });
    expect(within(header as HTMLElement).queryByRole('link')).toBeNull();
    expect(callbacks.onMarkRead).toHaveBeenCalledTimes(1);

    expect(screen.getByText('View original formatting')).toBeInTheDocument();
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByText('lease.pdf')).toBeInTheDocument();
    fireEvent.click(screen.getByText('View original formatting'));
    await waitFor(() => expect(screen.getByTitle('Email message')).toBeInTheDocument());
  });
});
