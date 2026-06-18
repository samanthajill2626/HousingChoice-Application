import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type CustomField } from '../../api/index.js';
import { CustomFieldsEditor } from './CustomFieldsEditor.js';

const ROW: CustomField = { label: 'Agency', value: 'AH' };

function setup(rows: CustomField[] = [ROW], onChange = vi.fn()) {
  render(<CustomFieldsEditor rows={rows} onChange={onChange} />);
  return { onChange };
}

describe('CustomFieldsEditor', () => {
  it('typing into the label input fires onChange with the new label', () => {
    const onChange = vi.fn();
    render(<CustomFieldsEditor rows={[ROW]} onChange={onChange} />);

    const labelInput = screen.getByLabelText('Field label 1');
    fireEvent.change(labelInput, { target: { value: 'Caseworker' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Caseworker', value: 'AH' }]);
  });

  it('clicking "+ Add custom field" fires onChange with an extra empty row', () => {
    const { onChange } = setup();

    const addBtn = screen.getByRole('button', { name: /\+ Add custom field/i });
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledWith([ROW, { label: '', value: '' }]);
  });

  it('clicking Remove fires onChange with the row gone (empty array)', () => {
    const { onChange } = setup();

    const removeBtn = screen.getByRole('button', { name: 'Remove custom field 1' });
    fireEvent.click(removeBtn);

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('passing labelSuggestions renders a datalist with those options', () => {
    render(
      <CustomFieldsEditor
        rows={[ROW]}
        onChange={vi.fn()}
        labelSuggestions={['Agency', 'Caseworker']}
      />,
    );

    // The datalist element should be present
    const datalist = document.querySelector('datalist');
    expect(datalist).not.toBeNull();

    // Both options should appear in it
    const options = datalist?.querySelectorAll('option');
    const values = Array.from(options ?? []).map((o) => o.value);
    expect(values).toContain('Agency');
    expect(values).toContain('Caseworker');
  });

  it('typing into the value input fires onChange with the new value', () => {
    const onChange = vi.fn();
    render(<CustomFieldsEditor rows={[ROW]} onChange={onChange} />);

    const valueInput = screen.getByLabelText('Field value 1');
    fireEvent.change(valueInput, { target: { value: 'NewValue' } });

    expect(onChange).toHaveBeenCalledWith([{ label: 'Agency', value: 'NewValue' }]);
  });

  it('renders one row per entry with correct accessible labels', () => {
    render(
      <CustomFieldsEditor
        rows={[
          { label: 'A', value: '1' },
          { label: 'B', value: '2' },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Field label 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Field value 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove custom field 1' })).toBeInTheDocument();
    expect(screen.getByLabelText('Field label 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Field value 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove custom field 2' })).toBeInTheDocument();
  });
});
