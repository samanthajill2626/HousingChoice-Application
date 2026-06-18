import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js';

// jsdom does no layout, so we fake the two measurements the hook reads:
//   - scrollHeight (content height) via a controllable module var
//   - offsetHeight reflects whatever inline height we've set (so autoHeightRef
//     tracks our own writes, and a manual height shows up as "different")
// and a ResizeObserver stub that hands us its callback to fire on demand.
function Harness({ value }: { value: string }): React.JSX.Element {
  const ref = useAutoGrowTextarea(value);
  return <textarea ref={ref} aria-label="ta" style={{ maxHeight: '100px' }} />;
}

let scrollH = 0;
let fireResize: (() => void) | undefined;

beforeEach(() => {
  scrollH = 0;
  fireResize = undefined;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
    configurable: true,
    get(): number {
      return parseFloat((this as HTMLTextAreaElement).style.height) || 0;
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(): number {
      return scrollH;
    },
  });
  class MockResizeObserver {
    constructor(cb: () => void) {
      fireResize = cb;
    }
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

afterEach(() => {
  delete (HTMLTextAreaElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown }).scrollHeight;
  vi.unstubAllGlobals();
});

describe('useAutoGrowTextarea', () => {
  it('starts one line, grows to fit content, and caps at max-height', () => {
    scrollH = 24; // an empty textarea is one line tall
    const { getByLabelText, rerender } = render(<Harness value="" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;
    // Empty uses the SAME scrollHeight measurement as typed (not the rows-based
    // 'auto'), so there's no sub-pixel shrink on the first keystroke.
    expect(ta.style.height).toBe('24px');

    // Typing grows it to the content height (below the 100px cap).
    scrollH = 60;
    rerender(<Harness value="hello" />);
    expect(ta.style.height).toBe('60px');

    // A tall draft is capped at the CSS max-height (then it scrolls).
    scrollH = 240;
    rerender(<Harness value={'lots\nof\ntext'} />);
    expect(ta.style.height).toBe('100px');
  });

  it('adds the borders under box-sizing:border-box so the box never lands short (no phantom scrollbar)', () => {
    function BorderHarness({ value }: { value: string }): React.JSX.Element {
      const ref = useAutoGrowTextarea(value);
      return (
        <textarea
          ref={ref}
          aria-label="ta"
          style={{
            maxHeight: '100px',
            boxSizing: 'border-box',
            borderTopWidth: '1px',
            borderBottomWidth: '1px',
            borderStyle: 'solid',
          }}
        />
      );
    }
    const { getByLabelText, rerender } = render(<BorderHarness value="" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;
    scrollH = 60;
    rerender(<BorderHarness value="hello" />);
    // 60 (content) + 1 + 1 (borders) = 62 — NOT 60, which would clip by 2px.
    expect(ta.style.height).toBe('62px');
  });

  it('lets a manual drag-resize override auto-fit until the draft clears', () => {
    scrollH = 40;
    const { getByLabelText, rerender } = render(<Harness value="hi" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;
    expect(ta.style.height).toBe('40px');

    // Simulate the user dragging the resize handle to a height we didn't set.
    ta.style.height = '130px';
    fireResize?.();

    // Auto-fit now yields to the manual height even as the draft grows.
    scrollH = 240;
    rerender(<Harness value="hi there, a much longer message" />);
    expect(ta.style.height).toBe('130px');

    // Clearing the draft (e.g. after send) re-arms auto-grow and returns to one
    // line (measured the same way → an empty textarea's one-line scrollHeight).
    scrollH = 24;
    rerender(<Harness value="" />);
    expect(ta.style.height).toBe('24px');
    scrollH = 50;
    rerender(<Harness value="next message" />);
    expect(ta.style.height).toBe('50px');
  });
});
