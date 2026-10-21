// LandlordRequirementsCard - the landlord page's "Requirements /
// Qualifications" card (property requirements spec 2026-10-20, D9), right
// after Landlord onboarding: the landlord's eight requirement items in their
// groups, a blank item as the dashboard's blank marker. These are copy-only
// DEFAULTS (D5): a property gets them when it is created from this landlord, or
// when staff press Apply to properties - nothing on a property changes because
// this card changed. The last Apply's result shows here until the next Apply.
import { useId } from 'react';
import type { Contact } from '../../api/index.js';
import { BLANK, Card, CardAction } from './Card.js';
import {
  formatItemValue,
  isItemBlank,
  landlordItemValue,
  requirementItemsByGroup,
} from '../listing/requirements.js';
import { APPLY_NO_PROPERTIES_REASON, doneHeadline, type ApplyDoneSummary } from './applyRequirementsModel.js';
import styles from './LandlordRequirementsCard.module.css';

export interface LandlordRequirementsCardProps {
  contact: Contact;
  /** The landlord has at least one property of record (D8 disables Apply otherwise). */
  hasProperties: boolean;
  /** Opens "Apply to properties"; absent = no Apply action. */
  onApply?: () => void;
  /** Opens the landlord edit form. */
  onEdit?: () => void;
  /** The last Apply's result (D8 done message), or null. */
  notice?: ApplyDoneSummary | null;
}

export function LandlordRequirementsCard({
  contact,
  hasProperties,
  onApply,
  onEdit,
  notice,
}: LandlordRequirementsCardProps): React.JSX.Element {
  const reasonId = useId();
  const applyBlocked = onApply !== undefined && !hasProperties;
  const actions =
    onApply !== undefined || onEdit !== undefined ? (
      <>
        {onApply !== undefined ? (
          <CardAction onClick={onApply} disabled={!hasProperties} {...(applyBlocked && { describedBy: reasonId })}>
            Apply to properties
          </CardAction>
        ) : null}
        {onEdit !== undefined ? (
          <CardAction onClick={onEdit} label="Edit requirements">
            Edit
          </CardAction>
        ) : null}
      </>
    ) : undefined;

  return (
    <Card title="Requirements / Qualifications" aside={actions}>
      {applyBlocked ? (
        <p id={reasonId} className={styles.reason}>
          {APPLY_NO_PROPERTIES_REASON}
        </p>
      ) : null}
      {notice !== undefined && notice !== null ? (
        <div role="status" className={styles.notice}>
          <p className={styles.noticeLine}>{doneHeadline(notice.updated)}</p>
          {notice.skipped.length > 0 ? (
            <>
              <p className={styles.noticeLine}>{`${notice.skipped.length} skipped`}</p>
              <ul className={styles.skipped}>
                {notice.skipped.map((s) => (
                  <li key={s.unitId}>{`${s.address} - ${s.reason}`}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {requirementItemsByGroup().map(({ group, items }) => (
        <div key={group} className={styles.group}>
          <h4 className={styles.groupHeading}>{group}</h4>
          {items.map((item) => {
            const value = landlordItemValue(contact, item.id);
            return (
              <div key={item.id} role="group" aria-label={item.label} className={styles.item}>
                {items.length > 1 ? <span className={styles.itemLabel}>{item.label}</span> : null}
                <span className={styles.value}>{isItemBlank(value) ? BLANK : formatItemValue(item.id, value)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}
