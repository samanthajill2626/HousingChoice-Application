// tourActivityFormat - pure presentation for the tour Activity card. Maps a
// TourActivityEvent (the tour's OWN audit trail: GET /api/tours/:id/activity) to
// a readable row line, an optional deep link (group-opened -> the conversation,
// converted -> the placement), and reuses the shared date + humanize helpers.
// Tested in isolation so the Activity card stays declarative.
import { type TourActivityEvent } from '../../api/index.js';
import { humanize } from '../contact/format.js';

/** Human titles for the tour lifecycle audit kinds (the recordTourEvent set +
 *  the group-opened / converted milestones). An unknown type humanizes -> a
 *  staff member never sees a raw snake_case token. */
const TOUR_EVENT_LABELS: Record<string, string> = {
  tour_scheduled: 'Tour scheduled',
  tour_rescheduled: 'Tour rescheduled',
  tour_took_place: 'Tour took place',
  tour_no_show: 'Marked no-show',
  tour_canceled: 'Tour canceled',
  tour_outcome: 'Outcome recorded',
  tour_group_opened: 'Group text opened',
  tour_converted: 'Converted to placement',
};

/** What one Activity row renders: the event line + an optional deep-link target. */
export interface TourActivityDescription {
  label: string;
  /** A route the row links out to (conversation / placement), when referenced. */
  to?: string;
}

export function describeTourActivity(e: TourActivityEvent): TourActivityDescription {
  const label = TOUR_EVENT_LABELS[e.type] ?? humanize(e.type);
  if (e.type === 'tour_converted' && e.placementId) {
    return { label, to: `/placements/${encodeURIComponent(e.placementId)}` };
  }
  if (e.type === 'tour_group_opened' && e.conversationId) {
    return { label, to: `/conversations/${encodeURIComponent(e.conversationId)}` };
  }
  return { label };
}
