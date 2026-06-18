// RelationshipsCard — renders the linked/text relationships on a contact for
// ALL contact kinds (shown below the type-specific file pane). Hidden when
// empty and there is no onEdit; shows a quiet empty state + Edit when onEdit
// is provided.
import { Link } from 'react-router-dom';
import type { Relationship } from '../../api/index.js';
import { Card, CardAction, EmptyRow } from './Card.js';
import styles from './Card.module.css';

export interface RelationshipsCardProps {
  relationships: Relationship[] | undefined;
  onEdit?: () => void;
}

export function RelationshipsCard({
  relationships,
  onEdit,
}: RelationshipsCardProps): React.JSX.Element | null {
  const items = relationships ?? [];

  // Hidden when there's nothing to show and no way to add.
  if (items.length === 0 && onEdit === undefined) {
    return null;
  }

  const aside =
    onEdit !== undefined ? (
      <CardAction onClick={onEdit} label="Edit relationships">
        Edit
      </CardAction>
    ) : undefined;

  return (
    <Card title="Relationships" aside={aside}>
      {items.length === 0 ? (
        <EmptyRow>No relationships yet</EmptyRow>
      ) : (
        items.map((rel, i) =>
          rel.contactId !== undefined ? (
            <Link key={i} className={styles.li} to={`/contacts/${rel.contactId}`}>
              <span className={styles.liLabel}>{rel.role}</span>
              <span className={styles.liRight}>{rel.name}</span>
            </Link>
          ) : (
            <div key={i} className={styles.li}>
              <span className={styles.liLabel}>{rel.role}</span>
              <span className={styles.liRight}>{rel.name}</span>
            </div>
          ),
        )
      )}
    </Card>
  );
}
