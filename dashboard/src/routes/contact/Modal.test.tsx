import { StrictMode, useEffect, useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import { Modal } from './Modal.js';

function EffectFocusedInput(): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return <input ref={inputRef} aria-label="First field" />;
}

describe('Modal focus lifecycle', () => {
  it('focuses the dialog on mount when no child already owns focus', () => {
    render(
      <Modal title="Example" onClose={() => undefined}>
        <p>Body</p>
      </Modal>,
    );

    expect(screen.getByRole('dialog', { name: 'Example' })).toHaveFocus();
  });

  it('preserves focus established by a child mount effect', () => {
    render(
      <Modal title="Example" onClose={() => undefined}>
        <EffectFocusedInput />
      </Modal>,
    );

    expect(screen.getByRole('textbox', { name: 'First field' })).toHaveFocus();
  });

  it('keeps child focus when a re-render supplies a new close callback', () => {
    function Host(): React.JSX.Element {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            Update page
          </button>
          <output>{tick}</output>
          <Modal title="Example" onClose={() => undefined}>
            <input aria-label="Name" />
          </Modal>
        </>
      );
    }

    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    const input = screen.getByRole('textbox', { name: 'Name' });
    input.focus();
    fireEvent.change(input, { target: { value: 'Tasha' } });

    // fireEvent does not move browser focus to the button, matching an
    // out-of-band page update such as an SSE-driven parent re-render.
    fireEvent.click(screen.getByRole('button', { name: 'Update page' }));

    expect(input).toHaveFocus();
    expect(input).toHaveValue('Tasha');
  });

  it('uses the latest close callback without restarting the focus lifecycle', () => {
    const onClose = vi.fn();

    function Host(): React.JSX.Element {
      const [version, setVersion] = useState(1);
      return (
        <>
          <button type="button" onClick={() => setVersion(2)}>
            Update callback
          </button>
          <Modal title="Example" onClose={() => onClose(version)}>
            <input aria-label="Name" />
          </Modal>
        </>
      );
    }

    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Update callback' }));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledWith(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('allows a descendant to consume Escape before the dialog closes', () => {
    const onClose = vi.fn();
    render(
      <Modal title="Example" onClose={onClose}>
        <input
          aria-label="Search"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault();
          }}
        />
      </Modal>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search' }), { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes only the topmost dialog when more than one is mounted', () => {
    const underlyingClose = vi.fn();

    function Host(): React.JSX.Element {
      const [topOpen, setTopOpen] = useState(false);
      return (
        <>
          <Modal title="Underlying" onClose={underlyingClose}>
            <button type="button" onClick={() => setTopOpen(true)}>
              Open top dialog
            </button>
          </Modal>
          {topOpen ? (
            <Modal title="Top" onClose={() => setTopOpen(false)}>
              <p>Top dialog body</p>
            </Modal>
          ) : null}
        </>
      );
    }

    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    const openTop = screen.getByRole('button', { name: 'Open top dialog' });
    openTop.focus();
    fireEvent.click(openTop);
    expect(screen.getByRole('dialog', { name: 'Top' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Top' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Underlying' })).toBeInTheDocument();
    expect(underlyingClose).not.toHaveBeenCalled();
    expect(openTop).toHaveFocus();
  });

  it('does not restore underlying focus while a later dialog remains mounted', () => {
    function Host(): React.JSX.Element {
      const [underlyingOpen, setUnderlyingOpen] = useState(true);
      const [topOpen, setTopOpen] = useState(false);
      return (
        <>
          {underlyingOpen ? (
            <Modal title="Underlying" onClose={() => undefined}>
              <button type="button" onClick={() => setTopOpen(true)}>
                Open top dialog
              </button>
            </Modal>
          ) : null}
          {topOpen ? (
            <Modal title="Top" onClose={() => undefined}>
              <button type="button" onClick={() => setUnderlyingOpen(false)}>
                Remove underlying dialog
              </button>
            </Modal>
          ) : null}
        </>
      );
    }

    render(<Host />);
    const openTop = screen.getByRole('button', { name: 'Open top dialog' });
    openTop.focus();
    fireEvent.click(openTop);
    const removeUnderlying = screen.getByRole('button', { name: 'Remove underlying dialog' });
    removeUnderlying.focus();
    fireEvent.click(removeUnderlying);

    expect(screen.queryByRole('dialog', { name: 'Underlying' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Top' })).toBeInTheDocument();
    expect(removeUnderlying).toHaveFocus();
  });

  it("focuses the remaining dialog when the top dialog's prior target is outside it", () => {
    const pageTrigger = document.createElement('button');
    document.body.append(pageTrigger);
    pageTrigger.focus();

    function Host(): React.JSX.Element {
      const [topOpen, setTopOpen] = useState(true);
      return (
        <>
          <Modal title="Underlying" onClose={() => undefined}>
            <p>Underlying body</p>
          </Modal>
          {topOpen ? (
            <Modal title="Top" onClose={() => setTopOpen(false)}>
              <p>Top body</p>
            </Modal>
          ) : null}
        </>
      );
    }

    render(
      <StrictMode>
        <Host />
      </StrictMode>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Top' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Underlying' })).toHaveFocus();
    pageTrigger.remove();
  });

  it('restores the element focused before mount when the dialog unmounts', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(
      <Modal title="Example" onClose={() => undefined}>
        <p>Body</p>
      </Modal>,
    );
    unmount();

    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('restores the original trigger after a child claims focus during mount', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const { unmount } = render(
      <Modal title="Example" onClose={() => undefined}>
        <EffectFocusedInput />
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: 'First field' })).toHaveFocus();

    unmount();

    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
