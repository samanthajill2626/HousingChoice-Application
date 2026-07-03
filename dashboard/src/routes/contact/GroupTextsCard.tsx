// GroupTextsCard — the "Group texts" card shared by TenantFile and
// LandlordFile: the relay-group threads this contact is a member of
// (GET /api/contacts/:id/relay-groups via the useContactFile slice).
//
// Each row links to the group's OWNER detail page (tour / placement) — that is
// where the thread is operated (e.g. TourDetail's group-thread panel); the new
// dashboard has no per-conversation inbox view, and a standalone group has no
// sensible target, so it renders unlinked. Label preference: the other members'
// names ("With Lars Landlord") > the operator tag > the (formatted) pool
// number > a plain "Group text". A closed group shows "Closed" instead of the
// member count.
import type { RelayGroupRow } from '../../api/index.js';
import { Card, EmptyRow, PendingPanel, Row, responseClass } from './Card.js';
import { formatPhone } from './format.js';

export interface GroupTextsCardProps {
  /** True while the slice is loading or the backend route isn't live yet. */
  pending: boolean;
  groups: RelayGroupRow[];
}

/** The owner detail route for a group, or undefined (standalone → no link). */
export function groupLink(owner: RelayGroupRow['owner']): string | undefined {
  if (owner.type === 'tour' && owner.id !== undefined) return `/tours/${owner.id}`;
  if (owner.type === 'placement' && owner.id !== undefined) return `/placements/${owner.id}`;
  return undefined;
}

/** A row's label: other members' names > tag > pool number > "Group text". */
export function groupLabel(g: RelayGroupRow): string {
  if (g.otherMemberNames.length > 0) return `With ${g.otherMemberNames.join(' & ')}`;
  if (g.tag !== undefined && g.tag.length > 0) return g.tag;
  if (g.poolNumber !== undefined) return formatPhone(g.poolNumber);
  return 'Group text';
}

export function GroupTextsCard({ pending, groups }: GroupTextsCardProps): React.JSX.Element {
  return (
    <Card title="Group texts" aside={groups.length > 0 ? String(groups.length) : undefined}>
      {pending ? (
        <PendingPanel />
      ) : groups.length === 0 ? (
        <EmptyRow>No group texts yet.</EmptyRow>
      ) : (
        groups.map((g) => {
          const to = groupLink(g.owner);
          return (
            <Row
              key={g.conversationId}
              {...(to !== undefined && { to })}
              label={groupLabel(g)}
              right={
                <span className={responseClass.muted}>
                  {g.status === 'closed'
                    ? 'Closed'
                    : `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`}
                </span>
              }
            />
          );
        })
      )}
    </Card>
  );
}
