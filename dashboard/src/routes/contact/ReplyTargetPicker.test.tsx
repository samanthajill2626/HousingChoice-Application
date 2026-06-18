import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReplyTargetPicker } from './ReplyTargetPicker.js';
import type { ReplyTarget } from './replyTargets.js';

const A = '+14040100001';
const B = '+14040100002';

describe('ReplyTargetPicker', () => {
  it('shows the target number and NO picker for a single target', () => {
    render(
      <ReplyTargetPicker
        replyToPhone={A}
        replyToLabel="primary"
        targets={[{ phone: A, conversationId: 'conv-a' }]}
        selectedConversationId="conv-a"
        onSelectTarget={vi.fn()}
      />,
    );
    expect(screen.getByText(/Reply sends to/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });

  it('opens a picker for multiple targets and selecting one calls onSelectTarget', async () => {
    const user = userEvent.setup();
    const onSelectTarget = vi.fn();
    const targets: ReplyTarget[] = [
      { phone: A, label: 'old', conversationId: 'conv-a' },
      { phone: B, label: 'cell', conversationId: 'conv-b' },
    ];
    render(
      <ReplyTargetPicker
        replyToPhone={B}
        replyToLabel="primary"
        targets={targets}
        selectedConversationId="conv-b"
        onSelectTarget={onSelectTarget}
      />,
    );

    await user.click(screen.getByRole('button', { name: /change/i }));
    const menu = screen.getByRole('menu');
    expect(menu).toBeInTheDocument();
    // Pick the OTHER number's thread (identified by its unique label "old" → conv-a).
    await user.click(screen.getByRole('menuitem', { name: /old/i }));
    expect(onSelectTarget).toHaveBeenCalledWith('conv-a');
  });

  it('does not offer a picker when onSelectTarget is absent', () => {
    render(
      <ReplyTargetPicker
        replyToPhone={A}
        targets={[
          { phone: A, conversationId: 'conv-a' },
          { phone: B, conversationId: 'conv-b' },
        ]}
      />,
    );
    expect(screen.queryByRole('button', { name: /change/i })).toBeNull();
  });
});
