// useAutoLoad - fires `onLoad` when the list's sentinel scrolls into the
// 400px margin (spec 5.2). ONE observer per sentinel mount. Its callback only
// records a REPORT { intersecting, seq }; the hook consumes each report AT
// ARRIVAL:
//   - while ENABLED, a report that says intersecting fires one load;
//   - while DISABLED, the report is discarded - it is never acted on later, so
//     a page committing after a mid-load crossing, or the list arming after a
//     restore, can never fire from stale geometry.
// When the hook is enabled and the page `epoch` has moved since the last one
// it handled, it RE-OBSERVES the sentinel so the observer reports the
// current geometry after the DOM grew; that fresh report fires the next load
// once if the sentinel is still inside the margin (a short page), and nothing
// otherwise. A change of `enabled` alone (a failed page re-enabling the
// button; hasMore appearing without a commit) neither re-observes nor fires.
// Intersection is reset when the sentinel unmounts. A real
// IntersectionObserver delivers entries asynchronously (a task after the next
// rendering update); consumption-at-arrival makes the rule independent of
// that timing. The default observer drains its queued entries (takeRecords)
// on every re-observe and before disconnect, and reports nothing once
// disconnected. The drain and the re-observe are synchronous calls, so no
// entry can be queued between them: this factory leaves no residual of its
// own. What remains is a browser that delivers an entry for a registration
// it was told to drop, which the IntersectionObserver spec forbids (R2-7).
import { useEffect, useRef, useState } from 'react';

export interface AutoLoadObserver {
  observe(el: Element): void;
  /** Force a fresh report of the element's CURRENT geometry. */
  reobserve(el: Element): void;
  disconnect(): void;
}
export type AutoLoadObserverFactory = (
  onReport: (intersecting: boolean) => void,
  root: Element | null,
) => AutoLoadObserver | undefined;

const ROOT_MARGIN = '400px 0px';

interface Report {
  intersecting: boolean;
  seq: number;
}
const NO_REPORT: Report = { intersecting: false, seq: 0 };

const defaultFactory: AutoLoadObserverFactory = (onReport, root) => {
  if (typeof IntersectionObserver === 'undefined') return undefined;
  // False once disconnected: a callback the browser had already scheduled
  // before the effect's cleanup reports nothing (AD-5).
  let live = true;
  const io = new IntersectionObserver(
    (entries) => {
      if (!live) return;
      const last = entries[entries.length - 1];
      if (last !== undefined) onReport(last.isIntersecting);
    },
    { root, rootMargin: ROOT_MARGIN },
  );
  return {
    observe: (el) => io.observe(el),
    // unobserve + observe queues a fresh initial entry for the element.
    // unobserve() leaves entries already queued in place, so takeRecords()
    // drains them first: an entry computed before this commit can never be
    // delivered after the re-observe as if it were fresh (AD-5).
    reobserve: (el) => {
      io.unobserve(el);
      io.takeRecords();
      io.observe(el);
    },
    disconnect: () => {
      live = false;
      io.takeRecords();
      io.disconnect();
    },
  };
};

export function useAutoLoad(opts: {
  sentinel: Element | null;
  root: Element | null;
  enabled: boolean;
  epoch: number;
  onLoad: () => void;
  observerFactory?: AutoLoadObserverFactory;
}): void {
  const { sentinel, root, enabled, epoch, onLoad, observerFactory } = opts;
  const [report, setReport] = useState<Report>(NO_REPORT);
  const observerRef = useRef<AutoLoadObserver | undefined>(undefined);
  const seqRef = useRef(0);
  // The seq of the last report CONSUMED (fired or discarded).
  const consumedSeqRef = useRef(0);
  // The epoch the hook last handled (re-observed for, or mounted at).
  const handledEpochRef = useRef(epoch);

  // One observer per sentinel mount; its only job is to record reports.
  useEffect(() => {
    if (sentinel === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setReport(NO_REPORT);
      return;
    }
    const observer = (observerFactory ?? defaultFactory)((intersecting) => {
      seqRef.current += 1;
      setReport({ intersecting, seq: seqRef.current });
    }, root);
    observerRef.current = observer;
    if (observer === undefined) return;
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      observerRef.current = undefined;
      setReport(NO_REPORT);
    };
  }, [sentinel, root, observerFactory]);

  // Re-observe when enabled and the epoch moved since it was last handled:
  // the NEXT report then describes the grown DOM. A failed page moves no
  // epoch, so enabling after it re-observes nothing. Any report already
  // recorded but not yet consumed is discarded FIRST (it predates this
  // commit; React may have batched it into this very render), so the consume
  // effect below, which runs after this one, cannot act on stale geometry.
  useEffect(() => {
    if (!enabled || epoch === handledEpochRef.current) return;
    handledEpochRef.current = epoch;
    consumedSeqRef.current = seqRef.current;
    if (sentinel !== null) observerRef.current?.reobserve(sentinel);
  }, [enabled, epoch, sentinel]);

  // Consume each report at arrival: fire while enabled, discard while not.
  useEffect(() => {
    if (report.seq === consumedSeqRef.current) return;
    consumedSeqRef.current = report.seq;
    if (!enabled || !report.intersecting) return;
    onLoad();
  }, [report, enabled, onLoad]);
}
