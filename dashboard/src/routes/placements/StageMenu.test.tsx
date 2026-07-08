import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StageMenu } from './StageMenu.js';

describe('StageMenu', () => {
  it('opens the full ladder; current stage disabled; picking a stage fires onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();

    // Full ladder: 17 stage items (18 minus lost, which is the danger item) + Mark lost.
    expect(screen.getAllByRole('menuitem')).toHaveLength(18);
    expect(screen.getByRole('menuitem', { name: /Collect RTA \(current\)/ })).toBeDisabled();

    await user.click(screen.getByRole('menuitem', { name: 'Schedule inspection' }));
    expect(onSelect).toHaveBeenCalledWith('schedule_inspection');
    // The menu closes after selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('Mark lost... fires onSelect("lost"); Escape closes the menu', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={onSelect} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    await user.click(screen.getByRole('menuitem', { name: 'Mark lost...' }));
    expect(onSelect).toHaveBeenCalledWith('lost');

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
