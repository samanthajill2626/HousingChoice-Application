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
  it('property forms: two lines explaining both tags', () => {
    render(<FlyerLegend audience="property" />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'On flyer - tenants see it on the public flyer.',
      'Staff only - never leaves the dashboard.',
    ]);
  });

  it("the landlord form: the property-flyers line", () => {
    render(<FlyerLegend audience="landlord" />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      "On property flyers - copied to this landlord's properties, where tenants see it on the public flyer.",
      'Staff only - never leaves the dashboard.',
    ]);
  });
});
