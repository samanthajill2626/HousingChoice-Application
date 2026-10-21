// PropertyRequirementsCard - the property page's Requirements card (property
// requirements spec 2026-10-20, D6 layout A and D10): the eight requirement
// items in their groups, each with the PROPERTY's own value (copy only, D5 -
// nothing here fills a value from the landlord). When the landlord of record
// is loaded, an item that differs from the landlord's CURRENT value carries
// ONE tag for the whole item - purple "Set on this property" or orange
// "Landlord updated" - and ONE landlord line (requirementDisplay). No landlord,
// or a landlord that did not load: no tags and no lines.
import type { Contact, UnitItem } from '../../api/index.js';
import { BLANK, Card, CardAction } from '../contact/Card.js';
import { landlordDisplayName } from '../contact/format.js';
import {
  formatItemValue,
  isItemBlank,
  landlordHasNoRequirements,
  requirementDisplay,
  requirementItemsByGroup,
  unitItemValue,
} from './requirements.js';
import styles from './PropertyRequirementsCard.module.css';

export interface PropertyRequirementsCardProps {
  unit: UnitItem;
  /** The landlord OF RECORD's contact; undefined when the property has no
   *  landlord or the contact did not load. */
  landlord: Contact | undefined;
  /** Opens the property edit form; absent on a deleted property. */
  onEdit?: () => void;
}

const TAG_TEXT = { set_here: 'Set on this property', landlord_updated: 'Landlord updated' } as const;

export function PropertyRequirementsCard({ unit, landlord, onEdit }: PropertyRequirementsCardProps): React.JSX.Element {
  return (
    <Card
      title="Requirements"
      aside={
        onEdit !== undefined ? (
          <CardAction onClick={onEdit} label="Edit property requirements">
            Edit
          </CardAction>
        ) : undefined
      }
    >
      {landlord !== undefined && landlordHasNoRequirements(landlord) ? (
        // <L> by the one landlord name rule (code review RD-9): the company or
        // the primary of phones[] before "Unknown contact".
        <p className={styles.note}>{`${landlordDisplayName(landlord)} has no requirements recorded yet.`}</p>
      ) : null}
      {requirementItemsByGroup().map(({ group, items }) => (
        <div key={group} className={styles.group}>
          <h4 className={styles.groupHeading}>{group}</h4>
          {items.map((item) => {
            const value = unitItemValue(unit, item.id);
            const display = requirementDisplay(unit, landlord, item.id);
            return (
              // One named group per item: a single-item group's heading
              // already names it, so the item label shows only in groups of
              // several (Screening, Move-in costs).
              <div key={item.id} role="group" aria-label={item.label} className={styles.item}>
                {items.length > 1 ? <span className={styles.itemLabel}>{item.label}</span> : null}
                <span className={styles.itemBody}>
                  <span className={styles.value}>{isItemBlank(value) ? BLANK : formatItemValue(item.id, value)}</span>
                  {display.tag !== null ? (
                    <span className={display.tag === 'set_here' ? styles.tagSetHere : styles.tagLandlordUpdated}>
                      {TAG_TEXT[display.tag]}
                    </span>
                  ) : null}
                  {display.landlordLine !== null ? (
                    <span className={styles.landlordLine}>{display.landlordLine}</span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}
