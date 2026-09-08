import { useEffect, useRef } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessageEditorProps } from './MessageEditor.js';

const api = vi.hoisted(() => ({
  getUnit: vi.fn(),
  getContact: vi.fn(),
  getAllContacts: vi.fn(),
  createBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
}));
vi.mock('../../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/index.js')>()),
  ...api,
}));

const edit = 'The operator wrote this message.';

// Keep the real editor. Inject its edit callback at the
// property commit boundary, before the parent's passive prefill effect runs.
// This deterministically exercises the stale-effect window from the E2E trace
// without sleeps or depending on the machine winning a scheduling race.
vi.mock('./MessageEditor.js', async (importOriginal) => {
  const { MessageEditor } = await importOriginal<typeof import('./MessageEditor.js')>();
  return {
    MessageEditor: function EditAtPropertyCommit(props: MessageEditorProps) {
      const { propertyLabel, onChange } = props;
      const editedProperty = useRef<string | null>(null);
      useEffect(() => {
        if (propertyLabel === undefined || editedProperty.current === propertyLabel) return;
        editedProperty.current = propertyLabel;
        onChange(edit);
      }, [propertyLabel, onChange]);
      return <MessageEditor {...props} />;
    },
  };
});

import { BroadcastComposer } from './BroadcastComposer.js';

beforeEach(() => {
  api.getUnit.mockResolvedValue({
    unitId: 'unit-0001',
    landlordId: 'landlord-0001',
    status: 'available',
    beds: 2,
    address: { line1: '123 Test Way', city: 'Atlanta', state: 'GA', zip: '30314' },
  });
  api.getContact.mockResolvedValue({ contactId: 'tenant-0001', firstName: 'Test' });
  api.getAllContacts.mockResolvedValue([]);
  api.createBroadcast.mockResolvedValue({
    broadcastId: 'draft-1', status: 'draft', estimatedCount: 1, truncated: false,
    flyerUrl: 'https://example.test/p/unit-0001?cta=text',
  });
  api.deleteBroadcast.mockResolvedValue({ deleted: true });
});
afterEach(() => vi.resetAllMocks());

it.each(['', '&contactId=tenant-0001'])(
  'preserves a hand edit when the property prefill effect is pending (%s)',
  async (recipient) => {
    render(
      <MemoryRouter initialEntries={['/broadcasts/new?unitId=unit-0001' + recipient]}>
        <BroadcastComposer />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue(edit));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview recipients' })).toBeEnabled());
    expect(api.createBroadcast).toHaveBeenCalledTimes(1);
    expect(api.createBroadcast).toHaveBeenLastCalledWith(expect.objectContaining({ body_template: edit }));
    expect(screen.getByLabelText('Message')).toHaveValue(edit);
  },
);
