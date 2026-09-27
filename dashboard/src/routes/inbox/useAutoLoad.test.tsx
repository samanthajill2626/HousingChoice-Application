import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoLoad, type AutoLoadObserverFactory } from './useAutoLoad.js';

// A hand-driven observer. It reports the CURRENT geometry on observe() and
// reobserve(), and on every crossing the test simulates through `cross`. It
// reports synchronously; the hook's rule does not depend on timing because a
// report is consumed at arrival.
let current = false;
let report: (intersecting: boolean) => void = () => {};
let created = 0;
let disconnected = 0;
let reobserved = 0;
const factory: AutoLoadObserverFactory = (onReport) => {
  created += 1;
  report = onReport;
  return {
    observe: () => onReport(current),
    reobserve: () => {
      reobserved += 1;
      onReport(current);
    },
    disconnect: () => {
      disconnected += 1;
    },
  };
};
function cross(intersecting: boolean): void {
  current = intersecting;
  report(intersecting);
}

const onLoad = vi.fn();

function Harness({ enabled, epoch, withSentinel = true }: { enabled: boolean; epoch: number; withSentinel?: boolean }): React.JSX.Element {
  const [sentinel, setSentinel] = useState<Element | null>(null);
  useAutoLoad({ sentinel, root: null, enabled, epoch, onLoad, observerFactory: factory });
  return withSentinel ? <div ref={setSentinel} data-testid="sentinel" /> : <div />;
}

beforeEach(() => {
  onLoad.mockReset();
  current = false;
  created = 0;
  disconnected = 0;
  reobserved = 0;
});
afterEach(() => vi.restoreAllMocks());

describe('useAutoLoad', () => {
  it('creates one observer per sentinel mount and fires once when a report says intersecting while enabled', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    expect(created).toBe(1);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled epoch={1} />);
    expect(created).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('fires once from the initial report when the sentinel mounts already in view', () => {
    current = true;
    render(<Harness enabled epoch={1} />);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('discards a report that arrives while disabled: enabling alone never fires (the failed-page shape)', () => {
    const { rerender } = render(<Harness enabled={false} epoch={1} />);
    act(() => cross(true));
    expect(onLoad).not.toHaveBeenCalled();
    rerender(<Harness enabled epoch={1} />);
    expect(reobserved).toBe(0);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('an epoch change while enabled re-observes and fires only from the fresh report', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    // The DOM grew and pushed the sentinel out: the fresh report says not
    // intersecting, so nothing fires.
    current = false;
    rerender(<Harness enabled epoch={2} />);
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
    // A short page left it in view: the fresh report says intersecting.
    current = true;
    rerender(<Harness enabled epoch={3} />);
    expect(reobserved).toBe(2);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('a commit that lands while disabled re-observes when the hook is enabled again, and fires exactly once (the restore and discarded-page shapes)', () => {
    // Restore: mounted unarmed, sentinel already in view (held report is discarded).
    current = true;
    const { rerender } = render(<Harness enabled={false} epoch={0} />);
    expect(onLoad).not.toHaveBeenCalled();
    // The head read commits: armed and epoch 1 in ONE render.
    rerender(<Harness enabled epoch={1} />);
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
    // The page it loaded pushed the sentinel out; its commit re-observes and
    // finds nothing to do.
    current = false;
    rerender(<Harness enabled={false} epoch={1} />); // loadingMore
    rerender(<Harness enabled epoch={2} />); // the page committed
    expect(reobserved).toBe(2);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  // SC-1: the failed-page shape AFTER an epoch move. At the mount epoch the
  // handled epoch already equals the current one, so only a later epoch proves
  // that a re-enable at an already-handled epoch neither re-observes nor fires.
  it('after an epoch move, re-enabling at the SAME epoch (a failed page) neither re-observes nor fires', () => {
    current = true;
    const { rerender } = render(<Harness enabled epoch={1} />);
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled={false} epoch={1} />); // the page is in flight
    rerender(<Harness enabled epoch={2} />); // it committed, a short page: still in view
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(2);
    rerender(<Harness enabled={false} epoch={2} />); // the next page is in flight...
    rerender(<Harness enabled epoch={2} />); // ...and FAILED: enabled again, no epoch move
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  // SC-2: the discarded-page shape with the epoch moving WHILE disabled (a head
  // read commits while loadingMore is still true): nothing re-observes until
  // the hook is enabled again, and then the fresh report fires once.
  it('an epoch that moves while DISABLED re-observes only once enabled, then fires once if still in view', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled={false} epoch={1} />); // loadingMore: the page is in flight
    rerender(<Harness enabled={false} epoch={2} />); // a head read committed and discarded it
    expect(reobserved).toBe(0);
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled epoch={2} />); // loadingMore cleared; the sentinel is still in view
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('a crossing during a load is discarded; the commit re-observes and fires once if still in view', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled={false} epoch={1} />); // loading
    act(() => cross(false));
    act(() => cross(true)); // the operator scrolled across the margin mid-load
    expect(onLoad).toHaveBeenCalledTimes(1);
    rerender(<Harness enabled epoch={2} />); // the page committed, still in view
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('a leave-and-re-enter fires again at the same epoch', () => {
    render(<Harness enabled epoch={1} />);
    act(() => cross(true));
    act(() => cross(false));
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('a crossing batched into the SAME render as the enabling commit fires once, from the fresh report', () => {
    const { rerender } = render(<Harness enabled={false} epoch={1} />);
    // The crossing and the commit land in one act: one render sees both.
    act(() => {
      cross(true);
      rerender(<Harness enabled epoch={2} />);
    });
    expect(reobserved).toBe(1);
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  // Review Focus 5: the sentinel unmounting resets intersection.
  it('resets intersection when the sentinel unmounts, so a returning sentinel waits for its own report', () => {
    const { rerender } = render(<Harness enabled epoch={1} />);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(1);
    current = false;
    rerender(<Harness enabled={false} epoch={1} withSentinel={false} />);
    expect(disconnected).toBe(1);
    rerender(<Harness enabled epoch={2} withSentinel />);
    // A new observer reported NOT intersecting on observe(): nothing fires.
    expect(created).toBe(2);
    expect(onLoad).toHaveBeenCalledTimes(1);
    act(() => cross(true));
    expect(onLoad).toHaveBeenCalledTimes(2);
  });

  it('installs nothing when the factory yields no observer (jsdom without IntersectionObserver)', () => {
    const none: AutoLoadObserverFactory = () => undefined;
    function Bare(): React.JSX.Element {
      const [s, setS] = useState<Element | null>(null);
      useAutoLoad({ sentinel: s, root: null, enabled: true, epoch: 1, onLoad, observerFactory: none });
      return <div ref={setS} />;
    }
    render(<Bare />);
    expect(onLoad).not.toHaveBeenCalled();
  });
});
