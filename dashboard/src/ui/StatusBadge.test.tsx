import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusBadge, contactStatusTone } from './StatusBadge.js';

describe('StatusBadge', () => {
  it('renders the tenant-status label from the F1 map', () => {
    render(<StatusBadge kind="tenant" status="placed" />);
    expect(screen.getByText('Placed')).toBeInTheDocument();
  });

  it('renders the listing-status label from the F1 map', () => {
    render(<StatusBadge kind="listing" status="under_application" />);
    expect(screen.getByText('Under application')).toBeInTheDocument();
  });

  it('falls back to a humanized form for an off-list value', () => {
    render(<StatusBadge kind="tenant" status="some_legacy_value" />);
    expect(screen.getByText('Some legacy value')).toBeInTheDocument();
  });

  // --- tour kind (tour-detail-page): the six-status tone map ------------------
  it('renders the tour-status label from the tour map', () => {
    render(<StatusBadge kind="tour" status="scheduled" />);
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  // Labels for every tour status (the tone map itself is tokens-only CSS, not
  // observable in jsdom where CSS modules are stripped - vite.config css:false).
  it.each([
    ['requested', 'Requested'],
    ['scheduled', 'Scheduled'],
    ['toured', 'Toured'],
    ['closed', 'Closed'],
    ['canceled', 'Canceled'],
    ['no_show', 'No show'],
  ])('maps tour status %s -> label %s', (status, label) => {
    render(<StatusBadge kind="tour" status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('falls back to a humanized form for an off-list tour value', () => {
    render(<StatusBadge kind="tour" status="some_future_status" />);
    expect(screen.getByText('Some future status')).toBeInTheDocument();
  });

  it('a label override replaces the status label', () => {
    render(<StatusBadge kind="tour" status="toured" label="Toured - needs outcome" />);
    expect(screen.getByText('Toured - needs outcome')).toBeInTheDocument();
    expect(screen.queryByText('Toured')).not.toBeInTheDocument();
  });
});

describe('contactStatusTone', () => {
  it('gives landlord onboarding the same tone as tenant onboarding (progress)', () => {
    expect(contactStatusTone('landlord', 'onboarding')).toBe('progress');
    expect(contactStatusTone('tenant', 'onboarding')).toBe(
      contactStatusTone('landlord', 'onboarding'),
    );
  });

  // Spec 2026-10-23 D4.4: Inactive reads the same muted color for every type.
  it.each(['tenant', 'partner', 'team_member', 'unknown', undefined] as const)(
    'an Inactive %s is muted',
    (type) => {
      expect(contactStatusTone(type, 'inactive')).toBe('muted');
    },
  );

  it('(PIN) the rest of the non-tenant tones are unchanged: Needs review warns, Active is neutral, Parked is muted', () => {
    expect(contactStatusTone('partner', 'needs_review')).toBe('warn');
    expect(contactStatusTone('unknown', 'needs_review')).toBe('warn');
    expect(contactStatusTone('partner', 'active')).toBe('neutral');
    expect(contactStatusTone('team_member', 'active')).toBe('neutral');
    expect(contactStatusTone('landlord', 'parked')).toBe('muted');
    expect(contactStatusTone('partner', 'some_legacy_value')).toBe('neutral');
  });
});
