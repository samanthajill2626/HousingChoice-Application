// OrgKindChoice tests - which list a new organization goes on (spec D6, D17;
// R2-F3): two radios in a group named "Kind", NEITHER checked at first.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrgKindChoice } from './OrgKindChoice.js';

describe('OrgKindChoice', () => {
  it('has no default and reports the kind picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<OrgKindChoice value={null} onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Kind' });
    expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['housing_authority', 'agency']);
    expect(within(group).getByRole('radio', { name: 'Housing authority' })).not.toBeChecked();
    expect(within(group).getByRole('radio', { name: 'Agency' })).not.toBeChecked();
    await user.click(within(group).getByRole('radio', { name: 'Agency' }));
    expect(onChange).toHaveBeenCalledWith('agency');
  });

  it('shows the kind it is given, and is inert while disabled', () => {
    render(<OrgKindChoice value="housing_authority" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('radio', { name: 'Housing authority' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Agency' })).toBeDisabled();
  });
});
