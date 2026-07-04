// GroupTextsCard — the "Group texts" card shared by TenantFile and
// LandlordFile: the relay-group threads this contact is a member of
// (GET /api/contacts/:id/relay-groups via the useContactFile slice).
//
// Each row links to the group's own CONVERSATION view
// (/conversations/:conversationId) — where the thread is read + operated. Label
// preference: the other members' names ("With Lars Landlord") > the operator tag
// > the (formatted) pool number > a plain "Group text". A closed group shows
// "Closed" instead of the member count.
import type { RelayGroupRow } from '../../api/index.js';
import { Card, EmptyRow, PendingPanel, Row, responseClass } from './Card.js';
import { formatPhone } from './format.js';

export interface GroupTextsCardProps {
  /** True while the slice is loading or the backend route isn't live yet. */
  pending: boolean;
  groups: RelayGroupRow[];
}

/** The conversation-view route for a group — its OWN conversationId (the relay
 *  view dispatches on the conversation, not the owner). Always resolvable, so
 *  every row links. */
export function groupLink(g: RelayGroupRow): string {
  return `/conversations/${g.conversationId}`;
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
          return (
            <Row
              key={g.conversationId}
              to={groupLink(g)}
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
