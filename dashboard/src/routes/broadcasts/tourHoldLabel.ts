// tourHoldLabel - matching-blast-rules D7: the recipient review's label for a
// tenant's tour hold (D4). The date is the dashboard's browser-local short
// date (shortDate, "Oct 20" - the same as every other tour date); a hold with
// no date drops the date and the space before it ("Tour, not marked").
import type { TourHold } from '../../api/index.js';
import { shortDate } from '../placements/placementsFormat.js';

export function tourHoldLabel(hold: TourHold): string {
  const day = hold.at !== undefined ? shortDate(hold.at) : '';
  const at = day === '' ? '' : ` ${day}`;
  switch (hold.kind) {
    case 'upcoming':
      return `Tour${at}`;
    case 'not_marked':
      return `Tour${at}, not marked`;
    case 'needs_outcome':
      return `Toured${at}, needs outcome`;
    case 'needs_placement':
      return `Toured${at}, needs placement`;
    case 'no_show':
      return `No show${at}`;
    case 'requested':
      return `Tour requested${at}, no date yet`;
    default:
      // A kind this dashboard does not know yet (a newer server): still a tour.
      return `Tour${at}`;
  }
}
