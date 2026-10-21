// TaggedField / TaggedCheckbox / TaggedGroupLabel (spec 2026-10-20 D10): the
// tag sits OUTSIDE the <label> element and describes the control, so the
// control's accessible name stays its label.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PUBLIC_FLYER_NOTE, TaggedCheckbox, TaggedField, TaggedGroupLabel } from './TaggedField.js';

describe('TaggedField', () => {
  it('the label names the control; the tag describes it and sits outside the <label>', () => {
    render(
      <TaggedField label="Subzone" visibility="staff_only" audience="property">
        {(control) => <input {...control} />}
      </TaggedField>,
    );
    const input = screen.getByLabelText('Subzone');
    expect(input).toHaveAccessibleName('Subzone');
    expect(input).toHaveAccessibleDescription('Staff only');
    expect(screen.getByText('Staff only').closest('label')).toBeNull();
  });

  it('a public free-text box also says tenants see it, in its description too', () => {
    render(
      <TaggedField label="Lease terms" visibility="on_flyer" audience="property" publicNote>
        {(control) => <input {...control} />}
      </TaggedField>,
    );
    expect(PUBLIC_FLYER_NOTE).toBe('Tenants see this on the public flyer.');
    expect(screen.getByText('Tenants see this on the public flyer.')).toBeInTheDocument();
    expect(screen.getByLabelText('Lease terms')).toHaveAccessibleDescription(
      'On flyer Tenants see this on the public flyer.',
    );
  });

  it('on the landlord form the public tag reads On property flyers', () => {
    render(
      <TaggedField label="Pet fee" visibility="on_flyer" audience="landlord">
        {(control) => <input {...control} />}
      </TaggedField>,
    );
    expect(screen.getByLabelText('Pet fee')).toHaveAccessibleDescription('On property flyers');
  });
});

describe('TaggedCheckbox', () => {
  it('the box is named by its label, described by its tag (outside the label), and reports its new state', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TaggedCheckbox label="Same-day RTA" visibility="on_flyer" audience="property" checked={false} onChange={onChange} />,
    );
    const box = screen.getByRole('checkbox', { name: 'Same-day RTA' });
    expect(box).toHaveAccessibleDescription('On flyer');
    expect(screen.getByText('On flyer').closest('label')).toBeNull();
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('disabled disables the box', () => {
    render(
      <TaggedCheckbox label="No pets" visibility="on_flyer" audience="property" checked onChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole('checkbox', { name: 'No pets' })).toBeDisabled();
  });
});

describe('TaggedGroupLabel', () => {
  it("renders a group's visible label with its tag under the given id", () => {
    render(<TaggedGroupLabel label="Address" visibility="on_flyer" audience="property" tagId="addr-tag" />);
    expect(screen.getByText('Address')).toBeInTheDocument();
    expect(screen.getByText('On flyer')).toHaveAttribute('id', 'addr-tag');
  });
});
