import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { BLANK } from './Card.js';
import styles from './Card.module.css';
import { EligibilityIntakeCard } from './EligibilityIntakeCard.js';
import { TENANT_MATCHING_INPUTS } from './tenantMatchingInputs.js';

describe('EligibilityIntakeCard', () => {
  it('renders recorded intake fields as label→value rows', () => {
    render(
      <EligibilityIntakeCard
        contact={{ pets: '1 cat', evictions: 'none', tenure: '3 years', lifEligible: true }}
      />,
    );
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('1 cat')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(screen.getByText('Time at current address')).toBeInTheDocument();
    expect(screen.getByText('3 years')).toBeInTheDocument();
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('renders a "Voucher expires" row with a friendly date when set', () => {
    render(<EligibilityIntakeCard contact={{ voucher_expiration_date: '2026-08-15T00:00:00.000Z' }} />);
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    expect(screen.getByText('Aug 15, 2026')).toBeInTheDocument();
  });

  it('renders the "Voucher expires" row as a blank when unparseable', () => {
    render(<EligibilityIntakeCard contact={{ voucher_expiration_date: 'not-a-date' }} />);
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    // All nine rows are blank: an unparseable date is no more "recorded" than an
    // absent one, but it must not silently drop the row (WP1 B1: the four
    // tenant matching rows render too).
    expect(screen.getAllByText(BLANK)).toHaveLength(9);
  });

  it('renders "No" when lifEligible is false (a recorded value, not empty)', () => {
    render(<EligibilityIntakeCard contact={{ lifEligible: false }} />);
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('No')).toBeInTheDocument();
  });

  it('renders empty/undefined fields as blanks instead of omitting them', () => {
    render(<EligibilityIntakeCard contact={{ pets: '2 dogs' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('2 dogs')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getByText('Time at current address')).toBeInTheDocument();
    expect(screen.getByText('LIF eligible')).toBeInTheDocument();
    expect(screen.getByText('Voucher expires')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(8);
  });

  it('renders every intake row as a blank when nothing is recorded', () => {
    render(<EligibilityIntakeCard contact={{}} />);
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(9);
  });

  it('treats an empty-string field as not recorded, rendering it as a blank', () => {
    render(<EligibilityIntakeCard contact={{ pets: '', evictions: '' }} />);
    expect(screen.getByText('Pets')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(9);
  });

  it('shows a pending suggestion chip on a contact with NO intake recorded (regression: intake-card-hides-pending-suggestions)', () => {
    // MemoryRouter: the chip's "View conversation" action is a router Link.
    render(
      <MemoryRouter>
        <EligibilityIntakeCard
          contact={{}}
          suggestions={[
            {
              itemId: 'sug-1',
              ownerContactId: 'contact-tenant-0001',
              target: 'evictions',
              suggestedValue: 'one, 2019',
              conversationId: 'conv-1',
              createdAt: '2026-08-03T12:00:00.000Z',
            },
          ]}
        />
      </MemoryRouter>,
    );
    // The card used to vanish entirely here, swallowing the chip with it: the
    // suggestion existed in the store and counted on Today, but staff could not
    // see or act on it from the contact page.
    expect(screen.getByText('Eligibility intake')).toBeInTheDocument();
    expect(screen.getByText('Evictions')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'AI suggestion for evictions' }),
    ).toBeInTheDocument();
  });
});

describe('EligibilityIntakeCard - the tenant matching inputs (WP1 B1 spec D2)', () => {
  it('renders the four rows in list order after Voucher expires, BLANK when unset', () => {
    render(<EligibilityIntakeCard contact={{}} />);
    const keys = ['Voucher expires', ...TENANT_MATCHING_INPUTS.map((i) => i.label)].map((l) => screen.getByText(l));
    for (let i = 1; i < keys.length; i += 1) {
      const before = keys[i - 1];
      const after = keys[i];
      if (before === undefined || after === undefined) throw new Error('a row is missing');
      expect(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    for (const input of TENANT_MATCHING_INPUTS) {
      expect(screen.getByText(input.label).parentElement, input.label).toHaveTextContent(BLANK);
    }
  });

  it('shows recorded values - the portion as $1,200 / month', () => {
    render(
      <EligibilityIntakeCard
        contact={{
          area_preference: 'Decatur or Tucker',
          max_tenant_portion: 1200,
          accessibility_need: 'No stairs',
          preferences_constraints: 'Needs a yard',
        }}
      />,
    );
    expect(screen.getByText('Decatur or Tucker')).toBeInTheDocument();
    expect(screen.getByText('$1,200 / month')).toBeInTheDocument();
    expect(screen.getByText('No stairs')).toBeInTheDocument();
    expect(screen.getByText('Needs a yard')).toBeInTheDocument();
    expect(screen.getAllByText(BLANK)).toHaveLength(5);
  });

  it('an AI-written input carries the AutoBadge on its own row; a manual one does not', () => {
    render(
      <EligibilityIntakeCard
        contact={{
          area_preference: 'Decatur',
          area_preference_source: { source: 'ai', at: '2026-10-20T12:00:00.000Z' },
          accessibility_need: 'No stairs',
          accessibility_need_source: { source: 'manual' },
        }}
      />,
    );
    const area = screen.getByText('Area preference').parentElement as HTMLElement;
    expect(within(area).getByRole('img', { name: 'Auto' })).toBeInTheDocument();
    const need = screen.getByText('Accessibility need').parentElement as HTMLElement;
    expect(within(need).queryByRole('img', { name: 'Auto' })).toBeNull();
    expect(screen.getAllByRole('img', { name: 'Auto' })).toHaveLength(1);
  });

  it('a pending suggestion shows its chip under the row - a portion as $1,200 / month', () => {
    render(
      <MemoryRouter>
        <EligibilityIntakeCard
          contact={{ max_tenant_portion: 1000 }}
          suggestions={[
            {
              itemId: 'sug-portion',
              ownerContactId: 'contact-tenant-0001',
              target: 'max_tenant_portion',
              suggestedValue: '1200',
              conversationId: 'conv-1',
              createdAt: '2026-10-20T12:00:00.000Z',
            },
            {
              itemId: 'sug-area',
              ownerContactId: 'contact-tenant-0001',
              target: 'area_preference',
              suggestedValue: 'Decatur, not Marietta',
              conversationId: 'conv-1',
              createdAt: '2026-10-20T12:00:00.000Z',
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('$1,000 / month')).toBeInTheDocument();
    const portion = screen.getByRole('group', { name: 'AI suggestion for maximum tenant portion' });
    expect(within(portion).getByText('AI heard "$1,200 / month"')).toBeInTheDocument();
    const area = screen.getByRole('group', { name: 'AI suggestion for area preference' });
    expect(within(area).getByText('AI heard "Decatur, not Marietta"')).toBeInTheDocument();
  });

  // E2-readers-2 (WL-1): Preferences and constraints is a textarea, so a
  // free-text row keeps the author's line breaks and wraps a long unbroken
  // value (.vProse); the other intake rows render as before.
  it('a free-text row renders as prose (.vProse); a non-text row does not', () => {
    render(
      <EligibilityIntakeCard
        contact={{
          lifEligible: true,
          area_preference: 'Decatur',
          preferences_constraints: 'No apartments\nNeeds a yard',
        }}
      />,
    );
    expect(screen.getByText(/No apartments/)).toHaveClass(styles.vProse!);
    expect(screen.getByText('Decatur')).toHaveClass(styles.vProse!);
    expect(screen.getByText('Yes')).not.toHaveClass(styles.vProse!);
  });
});

// The unit tests run with `css: false` (vite.config.ts), so no test can
// measure layout; this source pin keeps the .vProse rule in place (the
// Timeline.styles.test.ts mechanism).
describe('Card.module.css .vProse (WP1 B1 spec D2)', () => {
  it("keeps the author's line breaks and breaks a long unbroken value", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Card.module.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const match = css.match(/(?:^|\n)\.vProse\s*\{([^}]*)\}/);
    expect(match, 'missing CSS rule for .vProse').not.toBeNull();
    const body = match?.[1] ?? '';
    expect(body).toMatch(/white-space:\s*pre-wrap/);
    expect(body).toMatch(/overflow-wrap:\s*anywhere/);
  });
});
