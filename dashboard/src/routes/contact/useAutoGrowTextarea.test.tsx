import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoGrowTextarea } from './useAutoGrowTextarea.js';

// jsdom does no layout, so we fake the two measurements the hook reads:
//   - scrollHeight (content height) via a controllable module var. `hidden`
//     models a display:none ancestor (the ≤860px mobile pane), where the real
//     DOM reports scrollHeight/offsetHeight 0 for a box that has no layout.
//   - offsetHeight reflects whatever inline height we've set (so autoHeightRef
//     tracks our own writes, and a manual height shows up as "different"), but
//     never below MIN_BOX: a real textarea always renders at least its own
//     padding + borders, so a 0-height write still lays out taller than nothing.
//     That floor is what makes a hidden->shown reveal a visible size CHANGE.
// and a ResizeObserver stub that hands us its callback to fire on demand.
const MIN_BOX = 18;
function Harness({ value }: { value: string }): React.JSX.Element {
  const ref = useAutoGrowTextarea(value);
  return <textarea ref={ref} aria-label="ta" style={{ maxHeight: '100px' }} />;
}

let scrollH = 0;
let hidden = false;
let fireResize: (() => void) | undefined;

beforeEach(() => {
  scrollH = 0;
  hidden = false;
  fireResize = undefined;
  Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
    configurable: true,
    get(): number {
      if (hidden) return 0;
      return Math.max(parseFloat((this as HTMLTextAreaElement).style.height) || 0, MIN_BOX);
    },
  });
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(): number {
      return hidden ? 0 : scrollH;
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

  // Regression: the composer mounts inside the mobile detail pane that's hidden
  // behind the Details/Conversation toggle (twoPaneShell `.paneHidden` =>
  // display:none at <=860px). A hidden box measures scrollHeight 0, so fitting on
  // it collapsed the textarea to just its borders ("2px") — and because the value
  // never changes while hidden, nothing ever re-fit it. Typing a long reply then
  // stayed clipped in that sliver, which is the squished reply box on mobile.
  it('skips the fit while hidden (display:none pane) and fits when it is shown', () => {
    hidden = true;
    scrollH = 24;
    const { getByLabelText } = render(<Harness value="" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;
    // No usable measurement => leave the rows=1 height alone rather than write a
    // borders-only sliver.
    expect(ta.style.height).toBe('');

    // Tapping "Conversation" reveals the pane: the observer fires with a real box.
    hidden = false;
    fireResize?.();
    expect(ta.style.height).toBe('24px');
  });

  it('keeps auto-growing after a hidden mount — a reveal is not a manual drag', () => {
    hidden = true;
    scrollH = 24;
    const { getByLabelText, rerender } = render(<Harness value="" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;

    hidden = false;
    fireResize?.();

    // The 0 -> real-height jump on reveal must NOT be mistaken for the user
    // dragging the resize handle, or auto-grow stays dead for this whole message.
    scrollH = 72;
    rerender(<Harness value="a long reply that needs several lines" />);
    expect(ta.style.height).toBe('72px');
  });

  it('ignores the observer while hidden, so hide/show keeps auto-grow armed', () => {
    scrollH = 24;
    const { getByLabelText, rerender } = render(<Harness value="" />);
    const ta = getByLabelText('ta') as HTMLTextAreaElement;
    expect(ta.style.height).toBe('24px');

    // Switch to the Details tab (pane hidden) and back — the box losing and
    // regaining its layout is not a resize the user asked for.
    hidden = true;
    fireResize?.();
    hidden = false;
    fireResize?.();

    scrollH = 72;
    rerender(<Harness value="a long reply that needs several lines" />);
    expect(ta.style.height).toBe('72px');
  });
});
