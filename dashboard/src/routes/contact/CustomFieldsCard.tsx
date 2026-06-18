// CustomFieldsCard — renders operator-defined custom fields on a contact for
// ALL contact kinds (shown below the type-specific file pane). Hidden when
// empty and there is no onEdit; shows a quiet empty state + Edit when onEdit
// is provided.
import type { CustomField } from '../../api/index.js';
import { Card, CardAction, EmptyRow, KV } from './Card.js';

export interface CustomFieldsCardProps {
  customFields: CustomField[] | undefined;
  onEdit?: () => void;
}

export function CustomFieldsCard({
  customFields,
  onEdit,
}: CustomFieldsCardProps): React.JSX.Element | null {
  const items = customFields ?? [];

  // Hidden when there's nothing to show and no way to add.
  if (items.length === 0 && onEdit === undefined) {
    return null;
  }

  const aside =
    onEdit !== undefined ? (
      <CardAction onClick={onEdit} label="Edit custom fields">
        Edit
      </CardAction>
    ) : undefined;

  return (
    <Card title="Custom fields" aside={aside}>
      {items.length === 0 ? (
        <EmptyRow>No custom fields yet</EmptyRow>
      ) : (
        items.map((field, i) => (
          <KV key={i} k={field.label} v={field.value} />
        ))
      )}
    </Card>
  );
}
