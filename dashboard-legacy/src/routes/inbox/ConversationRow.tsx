// One inbox row: an avatar, the (honest) display name, last-message preview, a
// relative timestamp, and the status cues — unread count, assignment, opt-out,
// and the honest-identity "needs review" triage chip. The whole row is a Link to
// the thread. Rendered inside a <ul> (list semantics) by the Inbox screen.
import { NavLink } from 'react-router-dom';
import { Avatar, Badge } from '../../ui/index.js';
import type { ConversationSummary } from '../../api/index.js';
import {
  displayName,
  formatRelativeTime,
  isRelayGroup,
  needsReview,
  relayMemberCount,
} from './formatters.js';
import styles from './ConversationRow.module.css';

export interface ConversationRowProps {
  conversation: ConversationSummary;
  /** Injectable clock for deterministic relative-time tests. */
  now?: Date;
}

export function ConversationRow({ conversation, now }: ConversationRowProps): React.JSX.Element {
  const relay = isRelayGroup(conversation);
  // Honest identity: a relay group is a GROUP, not a person — never a fabricated
  // contact name. 1:1 rows keep the exact needs-review + name behavior.
  const review = !relay && needsReview(conversation);
  const name = relay ? 'Relay group' : displayName(conversation);
  const memberCount = relayMemberCount(conversation);
  const unread = conversation.unread_count > 0;
  const relative = formatRelativeTime(conversation.last_activity_at, now);

  return (
    <li className={styles.row}>
      <NavLink
        to={`/conversations/${encodeURIComponent(conversation.conversationId)}`}
        className={({ isActive }) => `${styles.link} ${isActive ? styles.linkActive : ''}`}
        aria-label={`${relay ? 'Relay group' : `Conversation with ${name}`}${unread ? `, ${conversation.unread_count} unread` : ''}${review ? ', needs review' : ''}`}
      >
        <Avatar name={review || relay ? undefined : name} review={review} />

        <div className={styles.body}>
          <div className={styles.topline}>
            <span className={styles.name}>{name}</span>
            {relative && (
              <time className={styles.time} dateTime={conversation.last_activity_at}>
                {relative}
              </time>
            )}
          </div>

          <div className={styles.subline}>
            <span className={`${styles.preview} ${unread ? styles.previewUnread : ''}`}>
              {conversation.preview ?? 'No messages yet'}
            </span>
            {unread && (
              <Badge tone="info" title={`${conversation.unread_count} unread`}>
                <span aria-label={`${conversation.unread_count} unread`}>
                  {conversation.unread_count}
                </span>
              </Badge>
            )}
          </div>

          {(review || relay || conversation.assignment !== null || conversation.sms_opt_out) && (
            <div className={styles.cues}>
              {relay && (
                <Badge tone="info" title={`Relay group · ${memberCount} members`}>
                  Relay · {memberCount}
                </Badge>
              )}
              {review && (
                <Badge tone="review" dot title="Identity not yet triaged">
                  Needs review
                </Badge>
              )}
              {conversation.assignment !== null && (
                <Badge tone="neutral" title="Assigned to a teammate">
                  Assigned
                </Badge>
              )}
              {conversation.sms_opt_out && (
                <Badge tone="warning" title="This contact has opted out of SMS">
                  Opted out
                </Badge>
              )}
            </div>
          )}
        </div>
      </NavLink>
    </li>
  );
}
