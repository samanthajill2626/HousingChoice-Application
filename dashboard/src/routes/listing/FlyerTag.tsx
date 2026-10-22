// FlyerTag / FlyerLegend - whether tenants see a field on the public flyer
// (spec 2026-10-20 D9, D10, D10a; plan 1.1, 2.6). A property form tags each
// field "On flyer" or "Staff only"; the landlord form says "On property flyers"
// because a landlord's values reach flyers only through its properties. The
// tag is plain text in a styled span - its words carry the meaning, the two
// styles differ in lightness and hue. FlyerTag renders the span only; callers
// keep it OUTSIDE any <label> and point the field's aria-describedby at its id
// (TaggedField.tsx).
import type { FlyerVisibility } from './requirements.js';
import styles from './FlyerTag.module.css';

export type FlyerAudience = 'property' | 'landlord';

export interface FlyerTagProps {
  visibility: FlyerVisibility;
  audience: FlyerAudience;
  /** The id the field's aria-describedby names. */
  id: string;
}

export function flyerTagText(visibility: FlyerVisibility, audience: FlyerAudience): string {
  if (visibility === 'staff_only') return 'Staff only';
  return audience === 'landlord' ? 'On property flyers' : 'On flyer';
}

export function FlyerTag({ visibility, audience, id }: FlyerTagProps): React.JSX.Element {
  const tone = visibility === 'on_flyer' ? styles.onFlyer : styles.staffOnly;
  return (
    <span id={id} className={`${styles.tag} ${tone}`}>
      {flyerTagText(visibility, audience)}
    </span>
  );
}

// Cameron 2026-10-22 (flyer-leads FW-P2): the Staff only lines speak of the
// flyer only. Rent is Staff only yet still reaches tenants through the
// Matching [Rent] merge field, so no line says a value stays in the dashboard.
const LEGEND: Readonly<Record<FlyerAudience, readonly [string, string]>> = {
  property: ['On flyer - tenants see it on the public flyer.', 'Staff only - not on the public flyer.'],
  // Planner ruling PR-2 (code review PA-2): copy only - a landlord save never
  // changes an existing property, so the line says how a value gets there.
  landlord: [
    'On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).',
    'Staff only - never on a property flyer.',
  ],
};

/** The two-line legend under a form's title (D10: it replaced the property
 *  form's single hint line). */
export function FlyerLegend({ audience }: { audience: FlyerAudience }): React.JSX.Element {
  const [onFlyerLine, staffOnlyLine] = LEGEND[audience];
  return (
    <ul className={styles.legend}>
      <li>{onFlyerLine}</li>
      <li>{staffOnlyLine}</li>
    </ul>
  );
}
