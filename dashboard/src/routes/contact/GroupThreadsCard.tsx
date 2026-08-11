// GroupThreadsCard - the "Group threads" card shared by TenantFile and
// LandlordFile: the NATIVE group texts this contact is a member of
// (GET /api/contacts/:id/group-threads via the useContactFile slice).
//
// The sibling of GroupTextsCard (relay groups), and deliberately smaller: a
// group text has no pool number, no owner, no tag and no lifecycle status, so a
// row is a label, a member count, and a link into the thread view.
//
// The card SURFACES truncation. Membership is matched over a bounded read of the
// group partition (there is no member->thread index and this feature does not
// add one), so a quietly-clipped list would read as "they are in no others".
import type { GroupThreadRow } from '../../api/index.js';
import { Card, EmptyRow, PendingPanel, Row, responseClass } from './Card.js';

export interface GroupThreadsCardProps {
  /** True while the slice is loading or the backend route isn't live yet. */
  pending: boolean;
  groups: GroupThreadRow[];
  /** The bounded read stopped early - older group threads were not considered. */
  truncated?: boolean;
}

/** The thread-view route for a group text - its own conversationId. */
export function groupThreadLink(g: GroupThreadRow): string {
  return `/conversations/${g.conversationId}`;
}

/** A row's label: the OTHER members' names, else a plain fallback. Names only -
 *  the row never renders a phone (the card's PII posture, matching relay's). */
export function groupThreadCardLabel(g: GroupThreadRow): string {
  if (g.otherMemberNames.length > 0) return `With ${g.otherMemberNames.join(' & ')}`;
  return 'Group text';
}

export function GroupThreadsCard({
  pending,
  groups,
  truncated,
}: GroupThreadsCardProps): React.JSX.Element {
  return (
    <Card title="Group threads">
      {pending ? (
        <PendingPanel />
      ) : groups.length === 0 ? (
        <EmptyRow>No group texts yet.</EmptyRow>
      ) : (
        groups.map((g) => (
          <Row
            key={g.conversationId}
            to={groupThreadLink(g)}
            label={groupThreadCardLabel(g)}
            right={
              <span className={responseClass.muted}>
                {g.memberCount} member{g.memberCount === 1 ? '' : 's'}
              </span>
            }
          />
        ))
      )}
      {!pending && truncated === true ? (
        <EmptyRow>Only recent group texts were checked - older ones may be missing.</EmptyRow>
      ) : null}
    </Card>
  );
}
