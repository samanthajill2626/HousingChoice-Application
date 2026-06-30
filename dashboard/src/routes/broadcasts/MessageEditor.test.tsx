// MessageEditor tests (§8) — the template editor: a labeled textarea with a live
// ≤1600 count, merge-field chips that insert tokens at the caret, and the
// property/flyer note shown only when a propertyLabel is supplied.
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { MessageEditor } from './MessageEditor.js';

/** A controlled harness so onChange edits flow back into the textarea (the real
 *  composer owns the value; the component is fully controlled). */
function Harness({ propertyLabel }: { propertyLabel?: string }): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <MessageEditor
      value={value}
      onChange={setValue}
      {...(propertyLabel !== undefined && { propertyLabel })}
    />
  );
}

describe('MessageEditor — template + count', () => {
  it('renders a labeled textarea with a live char count under the 1600 cap', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const ta = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(ta).toHaveAttribute('maxLength', '1600');
    expect(screen.getByText('0/1600')).toBeInTheDocument();

    await u.type(ta, 'Hello');
    expect(screen.getByText('5/1600')).toBeInTheDocument();
  });
});

describe('MessageEditor — merge-field chips', () => {
  it('exposes a chip for every merge field and inserts its token at the caret', async () => {
    const u = userEvent.setup();
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Insert a merge field' });
    for (const token of ['[TenantName]', '[Beds]', '[Address]', '[Rent]', '[FlyerLink]']) {
      expect(screen.getByRole('button', { name: token })).toBeInTheDocument();
    }
    void group;

    await u.click(screen.getByRole('button', { name: '[TenantName]' }));
    const ta = screen.getByLabelText('Message') as HTMLTextAreaElement;
    expect(ta.value).toBe('[TenantName]');

    // A second chip appends after the caret (which is placed after the first token).
    await u.click(screen.getByRole('button', { name: '[Beds]' }));
    expect(ta.value).toBe('[TenantName][Beds]');
  });

  it('inserts a token at the cursor inside existing text (not just append)', async () => {
    const onChange = vi.fn();
    render(<MessageEditor value="Hi  there" onChange={onChange} />);
    const ta = screen.getByLabelText('Message') as HTMLTextAreaElement;
    ta.setSelectionRange(3, 3); // between the two spaces in "Hi  there"
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: '[TenantName]' }));
    expect(onChange).toHaveBeenCalledWith('Hi [TenantName] there');
  });
});

describe('MessageEditor — property / flyer note', () => {
  it('shows the property + flyer-attached note ONLY when propertyLabel is set', () => {
    const { rerender } = render(<MessageEditor value="" onChange={() => {}} />);
    expect(screen.queryByText(/flyer link is attached/i)).not.toBeInTheDocument();

    rerender(<MessageEditor value="" onChange={() => {}} propertyLabel="123 Peachtree St" />);
    expect(screen.getByText('123 Peachtree St')).toBeInTheDocument();
    expect(screen.getByText(/flyer link is attached/i)).toBeInTheDocument();
  });
});
