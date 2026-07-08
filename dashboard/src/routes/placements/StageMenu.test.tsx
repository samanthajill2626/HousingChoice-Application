import { fireEvent, render, screen } from '@testing-library/react';
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

  it('focuses the first enabled menuitem on open; restores focus to the kebab on Escape', async () => {
    const user = userEvent.setup();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={vi.fn()} />);

    const kebab = screen.getByRole('button', { name: 'Actions for Tasha Nguyen' });
    await user.click(kebab);

    // The portal renders the menu at the end of <body>; focus must jump to its
    // first ENABLED item so the tab order is not stranded.
    const firstEnabled = screen
      .getAllByRole('menuitem')
      .find((item) => !(item as HTMLButtonElement).disabled);
    expect(firstEnabled).toBeDefined();
    expect(firstEnabled).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Escape returns focus to the kebab so the sequence resumes in place.
    expect(kebab).toHaveFocus();
  });

  it('outside mousedown closes the menu; mousedown inside the portaled menu does not', async () => {
    const user = userEvent.setup();
    render(<StageMenu tenant="Tasha Nguyen" currentStage="collect_rta" onSelect={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Actions for Tasha Nguyen' }));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();

    // A raw mousedown INSIDE the portaled menu must NOT close it (the handler
    // checks the menu ref, not just the kebab wrap the menu was portaled out of).
    fireEvent.mouseDown(menu);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // A mousedown on document.body, outside both the wrap and the portaled menu,
    // closes it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
