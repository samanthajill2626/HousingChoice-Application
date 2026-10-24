// TodaySection / LimitedList - the frame every Today section shares (spec
// 2026-10-23-today-checklist-design 2.1; plan PR33, PR102): the heading is the
// bare label (no count - the 2026-08-03 no-bare-counts ruling stands), the
// list is named by the heading text, and the list shows 5 rows with
// "Show all N" / "Show fewer".
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LimitedList, TODAY_SECTION_LIMIT, TodaySection } from './TodaySection.js';

const LABEL = 'Tours to book';

function rows(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Row ${i + 1}`);
}

function Section(props: {
  n: number;
  noun?: string;
  footer?: React.ReactNode;
  help?: string;
  level?: 2 | 3;
}): React.JSX.Element {
  return (
    <TodaySection label={LABEL} help={props.help} level={props.level}>
      <LimitedList
        label={LABEL}
        items={rows(props.n)}
        itemKey={(r) => r}
        renderItem={(r) => <li>{r}</li>}
        noun={props.noun}
        footer={props.footer}
      />
    </TodaySection>
  );
}

describe('TodaySection', () => {
  it('the heading is the bare label - no count (PR102); the list is named by the heading text', () => {
    render(<Section n={3} />);
    const heading = screen.getByRole('heading', { level: 2, name: LABEL });
    expect(heading).toHaveTextContent(/^Tours to book$/);
    expect(screen.getByRole('list', { name: LABEL })).toBeInTheDocument();
  });

  it('a section that failed to load has the same bare heading', () => {
    render(
      <TodaySection label={LABEL}>
        <p>We couldn&apos;t load tours to book.</p>
      </TodaySection>,
    );
    expect(screen.getByRole('heading', { level: 2, name: LABEL })).toBeInTheDocument();
  });

  it('renders the help line under the heading only when given', () => {
    const { unmount } = render(<Section n={1} help="Oldest first." />);
    expect(screen.getByText('Oldest first.')).toBeInTheDocument();
    unmount();
    render(<Section n={1} />);
    expect(document.querySelector('p')).toBeNull();
  });

  it('is an h3 for a part of At a glance', () => {
    render(<Section n={2} level={3} />);
    expect(screen.getByRole('heading', { level: 3, name: LABEL })).toBeInTheDocument();
  });
});

describe('LimitedList', () => {
  it('the limit is five rows (spec 2.1)', () => {
    expect(TODAY_SECTION_LIMIT).toBe(5);
  });

  it('shows the first 5 rows and "Show all N"; it expands in place, then "Show fewer" folds it back', async () => {
    const user = userEvent.setup();
    render(<Section n={7} />);
    const list = screen.getByRole('list', { name: LABEL });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(rows(5));
    const toggle = screen.getByRole('button', { name: 'Show all 7' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', list.id);
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(toggle).toHaveAccessibleName('Show fewer');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(toggle).toHaveAccessibleName('Show all 7');
  });

  it('no button at exactly five rows', () => {
    render(<Section n={5} />);
    expect(within(screen.getByRole('list', { name: LABEL })).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names what it counts when given a noun', () => {
    render(<Section n={6} noun="properties" />);
    expect(screen.getByRole('button', { name: 'Show all 6 properties' })).toBeInTheDocument();
  });

  it('renders the footer beside the button, and on its own when nothing overflows', () => {
    const { unmount } = render(<Section n={6} footer={<a href="/tours/past">Open the Past tab</a>} />);
    const button = screen.getByRole('button', { name: 'Show all 6' });
    const link = screen.getByRole('link', { name: 'Open the Past tab' });
    expect(button.parentElement).toBe(link.parentElement);
    unmount();
    render(<Section n={2} footer={<a href="/tours/past">Open the Past tab</a>} />);
    expect(screen.getByRole('link', { name: 'Open the Past tab' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
