// tourActivityFormat - pure presentation for the tour's OWN audit trail
// (GET /api/tours/:id/activity). Two consumers share these mappings:
//   - the Activity card (describeTourActivity: a row line + optional deep link);
//   - the conversation transcripts (tourActivityToMilestone: the same events as
//     shared-Timeline milestone pins, so the tour's lifecycle interleaves with
//     the group/tenant/landlord messages instead of the panes being comms-only).
// Tested in isolation so both consumers stay declarative.
import type { TimelineMilestone, TimelineMilestoneType, TourActivityEvent } from '../../api/index.js';
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

/** Tour audit kind → the closest shared TimelineMilestoneType. The type drives
 *  ONLY the pin color (the label above is what renders); kinds the shared union
 *  doesn't know map to a same-color neighbor rather than widening the server
 *  timeline contract mirror. Unknown kinds fall to 'stage_changed' (neutral). */
const MILESTONE_TYPE: Record<string, TimelineMilestoneType> = {
  tour_scheduled: 'tour_scheduled',
  tour_rescheduled: 'tour_scheduled',
  tour_took_place: 'tour_took_place',
  tour_no_show: 'tour_no_show',
  tour_canceled: 'tour_canceled',
  tour_outcome: 'tour_outcome',
  tour_group_opened: 'added_to_group_text',
  tour_converted: 'placement_opened',
};

/**
 * The same audit event as a shared-Timeline milestone pin, for the tour page's
 * conversation transcripts. No 'tour' ref (we are already ON the tour page);
 * converted/group-opened keep their deep links via refType/refId.
 */
export function tourActivityToMilestone(e: TourActivityEvent): TimelineMilestone {
  const { label } = describeTourActivity(e);
  const ref: Pick<TimelineMilestone, 'refType' | 'refId'> =
    e.type === 'tour_converted' && e.placementId
      ? { refType: 'placement', refId: e.placementId }
      : e.type === 'tour_group_opened' && e.conversationId
        ? { refType: 'conversation', refId: e.conversationId }
        : {};
  return {
    kind: 'milestone',
    id: `tour-activity:${e.id}`,
    at: e.at,
    type: MILESTONE_TYPE[e.type] ?? 'stage_changed',
    label,
    ...ref,
  };
}
