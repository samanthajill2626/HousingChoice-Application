// FlyerTag / FlyerLegend (spec 2026-10-20 D9, D10; plan 1.1 copy).
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FlyerLegend, FlyerTag, flyerTagText } from './FlyerTag.js';
import styles from './FlyerTag.module.css';

describe('FlyerTag', () => {
  it.each([
    ['on_flyer', 'property', 'On flyer'],
    ['staff_only', 'property', 'Staff only'],
    ['on_flyer', 'landlord', 'On property flyers'],
    ['staff_only', 'landlord', 'Staff only'],
  ] as const)('%s on a %s form reads "%s", under the id it is given', (visibility, audience, text) => {
    expect(flyerTagText(visibility, audience)).toBe(text);
    render(<FlyerTag id="tag-1" visibility={visibility} audience={audience} />);
    expect(screen.getByText(text)).toHaveAttribute('id', 'tag-1');
  });

  it('the two tags carry different styles as well as different words', () => {
    render(
      <>
        <FlyerTag id="a" visibility="on_flyer" audience="property" />
        <FlyerTag id="b" visibility="staff_only" audience="property" />
      </>,
    );
    expect(screen.getByText('On flyer')).toHaveClass(styles.onFlyer!);
    expect(screen.getByText('Staff only')).toHaveClass(styles.staffOnly!);
    expect(screen.getByText('On flyer')).not.toHaveClass(styles.staffOnly!);
  });
});

describe('FlyerLegend', () => {
  // Cameron 2026-10-22 (flyer-leads FW-P2): the Staff only line speaks of the
  // flyer only - rent still reaches tenants through the Matching [Rent] merge
  // field, so neither line says a value stays in the dashboard.
  it('property forms: two lines explaining both tags', () => {
    render(<FlyerLegend audience="property" />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'On flyer - tenants see it on the public flyer.',
      'Staff only - not on the public flyer.',
    ]);
  });

  // Planner ruling PR-2 (code review PA-2): copy only - saving the landlord
  // never changes an existing property, so the line names the two ways a
  // value reaches a property.
  it("the landlord form: the property-flyers line", () => {
    render(<FlyerLegend audience="landlord" />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'On property flyers - tenants see it once it is copied to a property (a new property, or Apply to properties).',
      'Staff only - never on a property flyer.',
    ]);
  });
});
