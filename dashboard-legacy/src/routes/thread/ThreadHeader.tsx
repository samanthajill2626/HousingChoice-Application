// ThreadHeader — the top bar of the conversation view:
//   - back to the inbox (ChevronLeft)
//   - the identity: Avatar + display name (a real name ONLY when triaged;
//     otherwise the formatted phone) and an honest "Needs review" badge when the
//     conversation is unknown_1to1 / the contact needs review (never a fake name)
//   - the assignment control: assign-to-self / unassign (PATCH via the client;
//     assignee is a userId string) — M1.4 scope
//   - a "Call instead" affordance that is RENDERED but DISABLED with a tooltip
//     ("Calling arrives in M1.9") — the calling action itself is M1.9
//   - a button to open the contact side panel (used on mobile, where the panel
//     is a Sheet)
import { Avatar, Badge, Button, ChevronLeftIcon, IconButton, PhoneIcon, UsersIcon } from '../../ui';
import { conversationTypeLabel, type IdentityDisplay } from './identity';
import type { Conversation } from '../../api';
import styles from './ThreadHeader.module.css';

export interface ThreadHeaderProps {
  conversation: Conversation | undefined;
  identity: IdentityDisplay;
  /** The current user's id — drives the assign-to-self / unassign control. */
  meUserId: string;
  /** Assign to a userId, or null to unassign. */
  onSetAssignment: (assigneeUserId: string | null) => void;
  /** True while an assignment PATCH is in flight. */
  assigning: boolean;
  /** Open the contact side panel (Sheet on mobile). */
  onOpenContact: () => void;
  /** Navigate back to the inbox. */
  onBack: () => void;
}

export function ThreadHeader({
  conversation,
  identity,
  meUserId,
  onSetAssignment,
  assigning,
  onOpenContact,
  onBack,
}: ThreadHeaderProps): React.JSX.Element {
  const assignment = conversation?.assignment;
  const assignedToMe = assignment === meUserId;
  const typeLabel = conversationTypeLabel(conversation?.type);

  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <IconButton label="Back to inbox" size="sm" onClick={onBack}>
          <ChevronLeftIcon />
        </IconButton>
        <Avatar name={identity.name} review={identity.needsReview} size="sm" />
        <div className={styles.identity}>
          <div className={styles.name}>
            <span className={styles.nameText}>{identity.label}</span>
            {identity.needsReview ? (
              <Badge tone="review" dot title="Identity not yet confirmed">
                Needs review
              </Badge>
            ) : (
              <Badge tone="info">{typeLabel}</Badge>
            )}
          </div>
          {/* Show the phone as a subtitle when we're displaying a real name. */}
          {!identity.needsReview && identity.label !== identity.phone && (
            <span className={styles.phone}>{identity.phone}</span>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {assignedToMe ? (
          <Button
            variant="secondary"
            size="sm"
            loading={assigning}
            onClick={() => onSetAssignment(null)}
          >
            Unassign
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={assigning}
            onClick={() => onSetAssignment(meUserId)}
          >
            {assignment ? 'Reassign to me' : 'Assign to me'}
          </Button>
        )}

        {/* Call instead — the affordance is present but the action is M1.9. */}
        <Button
          variant="ghost"
          size="sm"
          disabled
          title="Calling arrives in M1.9"
          aria-label="Call instead (arrives in M1.9)"
        >
          <PhoneIcon size={16} />
          Call instead
        </Button>

        {/* Only below 1200px: at ≥1200px the inline `.side` contact column is
         * visible, so this trigger would open a redundant Sheet on top of it. */}
        <span className={styles.contactTrigger}>
          <IconButton label="Contact details" size="sm" onClick={onOpenContact}>
            <UsersIcon />
          </IconButton>
        </span>
      </div>
    </header>
  );
}
