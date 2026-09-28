// DeliveryBadge - the 30003 retry promise on a property-send recipient row
// (share-sent-outcome D3). The row carries its newest attempt's promise facts
// (retryDueAt / retryOutcome, read by the results route from that attempt's own
// message row - the one source) and the badge judges liveness on the SERVER
// clock the page hands it: "will retry" while live, "retry not confirmed" when
// the chain ended unresolved, the plain failure once the promise lapsed. The
// other badge cases live in StatChips.test.tsx.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DeliveryBadge } from './DeliveryBadge.js';

/** The page's server-clock snapshot for every case below. */
const NOW = Date.parse('2026-07-01T12:00:00.000Z');

describe('DeliveryBadge - the 30003 retry promise (share-sent-outcome D3)', () => {
  // retry-send-window D8, kept: a row with NO promise facts (an old failure the
  // route did not read, or no clock handed down) promises nothing - under-
  // promising, never false. (Moved here from StatChips.test.tsx.)
  it('reads a property-send recipient 30003 as the plain failure when the row carries no promise facts', () => {
    const { container } = render(<DeliveryBadge status="failed" errorCode="30003" />);
    expect(container.textContent ?? '').toContain('Phone unreachable (error 30003)');
    expect(container.textContent ?? '').not.toContain('will retry');
  });

  it('reads "will retry" while the promise is live on the server clock', () => {
    const { container } = render(
      <DeliveryBadge status="failed" errorCode="30003" retryDueAt="2026-07-01T12:03:00.000Z" serverNowMs={NOW} />,
    );
    expect(container.textContent ?? '').toContain('Phone unreachable - will retry (error 30003)');
  });

  it('reads "retry not confirmed" when the chain ended unresolved (the withdrawn stamp beside it)', () => {
    const { container } = render(
      <DeliveryBadge
        status="failed"
        errorCode="30003"
        retryDueAt="1970-01-01T00:00:00.000Z"
        retryOutcome="unconfirmed"
        serverNowMs={NOW}
      />,
    );
    expect(container.textContent ?? '').toContain('Phone unreachable - retry not confirmed (error 30003)');
    expect(container.textContent ?? '').not.toContain('will retry');
  });

  it('reads the plain failure once the promise lapsed (due + grace behind the server clock)', () => {
    const { container } = render(
      <DeliveryBadge status="failed" errorCode="30003" retryDueAt="2026-07-01T11:57:00.000Z" serverNowMs={NOW} />,
    );
    expect(container.textContent ?? '').toContain('Phone unreachable (error 30003)');
    expect(container.textContent ?? '').not.toContain('will retry');
  });

  it('without a server clock a live stamp promises nothing (the facts need a clock to judge)', () => {
    const { container } = render(
      <DeliveryBadge status="failed" errorCode="30003" retryDueAt="2026-07-01T12:03:00.000Z" />,
    );
    expect(container.textContent ?? '').toContain('Phone unreachable (error 30003)');
    expect(container.textContent ?? '').not.toContain('will retry');
  });
});
