// RestoreLandlordDialog (caseworker-integrity spec 2026-10-12 section 4
// "Restore"): the sentence, the landlords-only picker, and the three actions.
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/index.js';
import type { Contact, UnitItem } from '../../api/index.js';

const restoreUnit = vi.fn();
const getAllContacts = vi.fn();
vi.mock('../../api/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../api/index.js')>('../../api/index.js');
  return {
    ...actual,
    restoreUnit: (...a: unknown[]) => restoreUnit(...a),
    getAllContacts: (...a: unknown[]) => getAllContacts(...a),
  };
});

import { RestoreLandlordDialog } from './RestoreLandlordDialog.js';

const LANDLORDS: Contact[] = [{ contactId: 'c-nora', type: 'landlord', firstName: 'Nora', lastName: 'Lane' }];
const RESTORED: UnitItem = { unitId: 'u1', landlordId: 'c-nora', status: 'available' };

function setup(props: { landlordName?: string } = {}) {
  const onRestored = vi.fn();
  const onConflict = vi.fn();
  const onClose = vi.fn();
  render(
    <RestoreLandlordDialog
      unitId="u1"
      {...props}
      onRestored={onRestored}
      onConflict={onConflict}
      onClose={onClose}
    />,
  );
  return { onRestored, onConflict, onClose };
}

async function pickNora(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await waitFor(() => expect(getAllContacts).toHaveBeenCalled());
  await user.type(screen.getByRole('combobox', { name: 'Landlord' }), 'Nora');
  await user.click(await screen.findByRole('option', { name: /Nora Lane/ }));
}

beforeEach(() => {
  restoreUnit.mockReset();
  getAllContacts.mockReset().mockResolvedValue(LANDLORDS);
});

describe('RestoreLandlordDialog', () => {
  it('names the stored landlord in the sentence', () => {
    setup({ landlordName: 'Lee Lord' });
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Lee Lord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to This property's landlord when the server named no one", () => {
    setup();
    expect(
      screen.getByText(
        "This property's landlord is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:",
      ),
    ).toBeInTheDocument();
  });

  it('reads its candidates from the landlords-only source (the New property picker source)', async () => {
    setup();
    await waitFor(() =>
      expect(getAllContacts).toHaveBeenCalledWith({ type: 'landlord' }, expect.any(AbortSignal)),
    );
  });

  it('Restore with this landlord is disabled until one is picked, then restores with that landlord', async () => {
    const user = userEvent.setup();
    restoreUnit.mockResolvedValue(RESTORED);
    const { onRestored } = setup();
    const withLandlord = screen.getByRole('button', { name: 'Restore with this landlord' });
    expect(withLandlord).toBeDisabled();
    await pickNora(user);
    expect(withLandlord).toBeEnabled();
    await user.click(withLandlord);
    expect(restoreUnit).toHaveBeenCalledWith('u1', { landlordId: 'c-nora' });
    await waitFor(() => expect(onRestored).toHaveBeenCalledWith(RESTORED));
  });

  it('Restore without a landlord restores with landlordId null', async () => {
    const user = userEvent.setup();
    restoreUnit.mockResolvedValue({ ...RESTORED, landlordId: undefined });
    const { onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(restoreUnit).toHaveBeenCalledWith('u1', { landlordId: null });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  it('Cancel closes without restoring', async () => {
    const user = userEvent.setup();
    const { onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(restoreUnit).not.toHaveBeenCalled();
  });

  it('shows the landlord refusal sentence and stays open', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(
      new ApiError(409, 'landlord_not_landlord', 'landlord_not_landlord', { error: 'landlord_not_landlord' }),
    );
    const { onRestored } = setup();
    await pickNora(user);
    await user.click(screen.getByRole('button', { name: 'Restore with this landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Only a landlord can be a property's landlord of record.",
    );
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Restore property' })).toBeInTheDocument();
  });

  it('a concurrent change asks for a retry and lets the caller re-read', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(
      new ApiError(409, 'unit_roster_conflict', 'unit_roster_conflict', { error: 'unit_roster_conflict' }),
    );
    const { onConflict, onRestored } = setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The property contacts changed - try that change again.',
    );
    expect(onConflict).toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });

  // R1 code review, dashboard finding 5: a failed landlords read is said, not
  // swallowed - the picker cannot offer anyone, so staff learn why and keep
  // the two actions that still work.
  it("says Couldn't load the landlords. when the landlord list fails to load; Restore without a landlord and Cancel stay live", async () => {
    const user = userEvent.setup();
    getAllContacts.mockReset().mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    restoreUnit.mockResolvedValue({ ...RESTORED, landlordId: undefined });
    const { onRestored } = setup();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe("Couldn't load the landlords.");
    expect(screen.getByRole('button', { name: 'Restore with this landlord' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    const without = screen.getByRole('button', { name: 'Restore without a landlord' });
    expect(without).toBeEnabled();
    await user.click(without);
    expect(restoreUnit).toHaveBeenCalledWith('u1', { landlordId: null });
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });

  // R2 code review, dashboard finding A3 (fix wave 2 FW2-6): the app runs
  // under <StrictMode> (dashboard/src/main.tsx), so every dev and e2e mount
  // runs the landlord-list effect twice and the FIRST read is aborted by the
  // simulated unmount (the API client rethrows the AbortError). An aborted read
  // is the effect's own cleanup, not a failed load: no "Couldn't load the
  // landlords." beside a list that loaded.
  it('under StrictMode the aborted first read is not a failure - no load alert, and the landlords are offered', async () => {
    const user = userEvent.setup();
    getAllContacts.mockReset().mockImplementation(
      (_query: unknown, signal: AbortSignal) =>
        new Promise<Contact[]>((resolve, reject) => {
          const abort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
          // Answer on a later task, so the simulated unmount aborts the first
          // read before it could land.
          setTimeout(() => resolve(LANDLORDS), 0);
        }),
    );
    render(
      <StrictMode>
        <RestoreLandlordDialog unitId="u1" onRestored={vi.fn()} onConflict={vi.fn()} onClose={vi.fn()} />
      </StrictMode>,
    );

    // The premise: two reads, the first one aborted.
    await waitFor(() => expect(getAllContacts).toHaveBeenCalledTimes(2));
    const signals = getAllContacts.mock.calls.map((call) => call[1] as AbortSignal);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);

    await user.type(screen.getByRole('combobox', { name: 'Landlord' }), 'Nora');
    expect(await screen.findByRole('option', { name: /Nora Lane/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('any other failure says the restore did not happen', async () => {
    const user = userEvent.setup();
    restoreUnit.mockRejectedValue(new ApiError(500, 'http_500', 'Request failed (500)'));
    setup();
    await user.click(screen.getByRole('button', { name: 'Restore without a landlord' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't restore - please try again.");
  });
});
