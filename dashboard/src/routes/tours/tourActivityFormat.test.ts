// tourActivityFormat tests - the Activity-row descriptor: labels for the known
// tour lifecycle kinds, deep links for converted / group-opened, and a humanized
// fallback for an unknown type.
import { describe, expect, it } from 'vitest';
import { describeTourActivity } from './tourActivityFormat.js';
import type { TourActivityEvent } from '../../api/index.js';

function ev(over: Partial<TourActivityEvent>): TourActivityEvent {
  return { id: '2026-07-01T00:00:00Z#0', at: '2026-07-01T00:00:00Z', type: 'tour_scheduled', ...over };
}

describe('describeTourActivity', () => {
  it('labels the known lifecycle kinds', () => {
    expect(describeTourActivity(ev({ type: 'tour_scheduled' })).label).toBe('Tour scheduled');
    expect(describeTourActivity(ev({ type: 'tour_rescheduled' })).label).toBe('Tour rescheduled');
    expect(describeTourActivity(ev({ type: 'tour_took_place' })).label).toBe('Tour took place');
    expect(describeTourActivity(ev({ type: 'tour_no_show' })).label).toBe('Marked no-show');
    expect(describeTourActivity(ev({ type: 'tour_canceled' })).label).toBe('Tour canceled');
    expect(describeTourActivity(ev({ type: 'tour_outcome' })).label).toBe('Outcome recorded');
  });

  it('links a converted row to the placement', () => {
    const d = describeTourActivity(ev({ type: 'tour_converted', placementId: 'plc-9' }));
    expect(d.label).toBe('Converted to placement');
    expect(d.to).toBe('/placements/plc-9');
  });

  it('links a group-opened row to the conversation', () => {
    const d = describeTourActivity(ev({ type: 'tour_group_opened', conversationId: 'g-9' }));
    expect(d.label).toBe('Group text opened');
    expect(d.to).toBe('/conversations/g-9');
  });

  it('a converted row without a placementId has no link', () => {
    expect(describeTourActivity(ev({ type: 'tour_converted' })).to).toBeUndefined();
  });

  it('humanizes an unknown type', () => {
    expect(describeTourActivity(ev({ type: 'some_future_event' })).label).toBe('Some future event');
  });
});
