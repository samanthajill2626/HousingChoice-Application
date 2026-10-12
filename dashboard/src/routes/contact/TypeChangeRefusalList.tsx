// TypeChangeRefusalList - what blocks a refused contact type change (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): one sentence per blocking record, each with a link to that record.
// Shared by the edit form (beside the kind picker) and the Unknown card
// (under its Mark as actions). The sentences live in lib/holdingRefusals.ts.
import { Link } from 'react-router-dom';
import { typeChangeRefusalCopy, type TypeChangeRefusal } from '../../lib/holdingRefusals.js';
import styles from './TypeChangeRefusalList.module.css';

export interface TypeChangeRefusalListProps {
  refusals: TypeChangeRefusal[];
}

export function TypeChangeRefusalList({ refusals }: TypeChangeRefusalListProps): React.JSX.Element {
  return (
    <div role="alert" className={styles.refusals}>
      <ul className={styles.list}>
        {refusals.map((refusal, index) => {
          const copy = typeChangeRefusalCopy(refusal);
          return (
            <li key={`${refusal.code}-${index}`}>
              {copy.sentence} <Link to={copy.to}>{copy.linkText}</Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
