// RelayThreadHeader — the top bar for a relay_group thread (M1.7). Mirrors the
// ThreadHeader shell (back button, identity block, actions) but the identity is
// the GROUP: a "Relay group" label, the live member count, and the masked pool
// number (or a "closed" note when the number is released). The action is a
// close/reopen toggle (PATCH /close via setRelayClosed); the result updates the
// header live (the parent refetches the conversation on conversation.updated).
//
// No assignment / contact / "Call instead" controls here — those are 1:1 hub
// affordances; a relay group is operator-run and multi-party.
import { Badge, Button, ChevronLeftIcon, IconButton, UsersIcon } from '../../ui';
import { formatPhone } from './identity';
import type { Conversation } from '../../api';
import styles from './ThreadHeader.module.css';

export interface RelayThreadHeaderProps {
  conversation: Conversation | undefined;
  /** Live member count (from the roster hook). */
  memberCount: number;
  /** True while the close/reopen PATCH is in flight. */
  toggling: boolean;
  /** Toggle closed ↔ open (passes the NEXT closed value). */
  onToggleClosed: (closed: boolean) => void;
  /** Open the members side panel (Sheet on mobile). */
  onOpenMembers: () => void;
  /** Navigate back to the inbox. */
  onBack: () => void;
}

export function RelayThreadHeader({
  conversation,
  memberCount,
  toggling,
  onToggleClosed,
  onOpenMembers,
  onBack,
}: RelayThreadHeaderProps): React.JSX.Element {
  const closed = conversation?.status === 'closed';
  const poolNumber = conversation?.pool_number;
  const memberLabel = `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`;

  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <IconButton label="Back to inbox" size="sm" onClick={onBack}>
          <ChevronLeftIcon />
        </IconButton>
        <Avatar />
        <div className={styles.identity}>
          <div className={styles.name}>
            <span className={styles.nameText}>Relay group</span>
            {closed ? (
              <Badge tone="warning" dot title="The pool number is released">
                Closed
              </Badge>
            ) : (
              <Badge tone="info">{memberLabel}</Badge>
            )}
          </div>
          <span className={styles.phone}>
            {closed
              ? 'No active number'
              : poolNumber
                ? `Pool ${formatPhone(poolNumber)} · ${memberLabel}`
                : memberLabel}
          </span>
        </div>
      </div>

      <div className={styles.actions}>
        {closed ? (
          <Button
            variant="secondary"
            size="sm"
            loading={toggling}
            onClick={() => onToggleClosed(false)}
          >
            Reopen
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={toggling}
            onClick={() => onToggleClosed(true)}
          >
            Close group
          </Button>
        )}

        {/* Below 1200px the members panel is a Sheet (the inline side column is
         * hidden), so this trigger opens it. */}
        <span className={styles.contactTrigger}>
          <IconButton label="Group members" size="sm" onClick={onOpenMembers}>
            <UsersIcon />
          </IconButton>
        </span>
      </div>
    </header>
  );
}

/** A neutral group glyph avatar (no name → no fabricated identity). */
function Avatar(): React.JSX.Element {
  return (
    <span className={styles.groupAvatar} aria-hidden="true">
      <UsersIcon size={18} />
    </span>
  );
}
