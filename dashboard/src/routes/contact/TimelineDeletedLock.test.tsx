import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline.js';

const base = {
  status: 'ready' as const,
  items: [],
  source: 'server' as const,
  canSend: false,
};

describe('Timeline - deleted-contact composer lock', () => {
  it('deleted: composer is replaced by the restore note; Reply textbox absent; Restore fires onRestore', () => {
    const onRestore = vi.fn();
    render(
      <MemoryRouter>
        <Timeline {...base} deleted onRestore={onRestore} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore contact' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('deleted: the email channel toggle and Send affordances are gone too', () => {
    render(
      <MemoryRouter>
        <Timeline
          {...base}
          deleted
          onRestore={vi.fn()}
          emailChannel={{
            emails: [{ email: 'dana@example.com', primary: true }],
            onSendEmail: vi.fn(),
            onManageEmails: vi.fn(),
          }}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('group', { name: 'Message channel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });

  it('deleted with no onRestore: the note still renders, but no dead Restore button', () => {
    render(
      <MemoryRouter>
        <Timeline {...base} deleted />
      </MemoryRouter>,
    );
    expect(screen.getByText(/restore them to reply/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore contact' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Reply message' })).toBeNull();
  });

  it('not deleted: the Reply textbox renders as usual', () => {
    render(
      <MemoryRouter>
        <Timeline {...base} canSend />
      </MemoryRouter>,
    );
    expect(screen.getByRole('textbox', { name: 'Reply message' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore contact' })).toBeNull();
  });
});
