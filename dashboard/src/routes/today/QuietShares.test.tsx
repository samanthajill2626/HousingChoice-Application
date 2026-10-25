// QuietShares - Today's Quiet shares, option C (spec
// 2026-10-23-today-checklist-design 6.2, 6.3; plan PR34). Rendered directly;
// Today.test.tsx covers its place on the page. The clock is the `now` prop -
// the server's generatedAt.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { QuietSharePerson, QuietShareProperty } from '../../api/index.js';
import { propertySummary, QuietSharesSection, quietText } from './QuietShares.js';
import type { QuietSharesState } from './useToday.js';

const NOW = '2026-07-01T12:00:00.000Z';
const DAY_MS = 86_400_000;

function daysBefore(n: number, extraMs = 0): string {
  return new Date(Date.parse(NOW) - n * DAY_MS - extraMs).toISOString();
}

function person(contactId: string, over: Partial<QuietSharePerson> = {}): QuietSharePerson {
  return {
    contactId,
    name: `Name ${contactId}`,
    type: 'tenant',
    state: 'no_reply',
    quietSince: daysBefore(6),
    ...over,
  };
}

function property(unitId: string, people: QuietSharePerson[]): QuietShareProperty {
  return { unitId, unitLabel: `${unitId} Main St`, people };
}

function ok(properties: QuietShareProperty[], extra: { truncated?: boolean } = {}): QuietSharesState {
  // PR103: no distinct-people count on the wire.
  return { status: 'ok', properties, truncated: extra.truncated ?? false };
}

function ui(quiet: QuietSharesState): React.JSX.Element {
  return (
    <MemoryRouter>
      <QuietSharesSection quiet={quiet} now={NOW} />
    </MemoryRouter>
  );
}

/** A property line: a button named "<unitLabel>, <summary>". */
function lineFor(unitId: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${unitId} Main St, `) });
}

describe('propertySummary (spec 6.3)', () => {
  it('counts the people, then the replied part and the never-replied part', () => {
    const people = [
      ...['a', 'b'].map((id) => person(id, { state: 'replied' })),
      ...['c', 'd', 'e', 'f', 'g'].map((id) => person(id)),
    ];
    expect(propertySummary(people)).toBe('7 people: 2 replied, then quiet - 5 never replied');
  });

  it('leaves a zero part out', () => {
    expect(propertySummary(['a', 'b', 'c'].map((id) => person(id)))).toBe('3 people: 3 never replied');
    expect(propertySummary(['a', 'b'].map((id) => person(id, { state: 'replied' })))).toBe('2 people: 2 replied, then quiet');
  });

  it('one person reads "1 person"', () => {
    expect(propertySummary([person('a')])).toBe('1 person: 1 never replied');
    expect(propertySummary([person('a', { state: 'replied' })])).toBe('1 person: 1 replied, then quiet');
  });
});

describe('quietText (spec 6.2)', () => {
  it('replied: "Replied, then quiet N days"; no_reply: "No reply in N days"', () => {
    expect(quietText(person('a', { state: 'replied', quietSince: daysBefore(3) }), NOW)).toBe('Replied, then quiet 3 days');
    expect(quietText(person('a', { quietSince: daysBefore(6) }), NOW)).toBe('No reply in 6 days');
  });

  it('N is whole days since quietSince, rounded down', () => {
    expect(quietText(person('a', { quietSince: daysBefore(5, 23 * 3_600_000) }), NOW)).toBe('No reply in 5 days');
  });

  it('one day reads "1 day"', () => {
    expect(quietText(person('a', { quietSince: daysBefore(1) }), NOW)).toBe('No reply in 1 day');
  });
});

describe('QuietSharesSection (option C)', () => {
  it('the heading is the bare label (no count), the help line shows, and the property lines keep the order given', () => {
    // b waits on both properties: a row under each (PR103), and the heading
    // carries no count at all (PR102).
    render(ui(ok([property('u2', [person('a'), person('b')]), property('u1', [person('b')])])));
    expect(screen.getByRole('heading', { level: 2, name: 'Quiet shares' })).toHaveTextContent(/^Quiet shares$/);
    expect(
      screen.getByText(
        'Properties sent in the last 14 days. Replied and then went quiet for 2+ days, or never replied in 5+ days. A message or call from either side restarts the clock; sending another property does not.',
      ),
    ).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Quiet shares' });
    expect(within(list).getAllByRole('button', { name: /Main St, / }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'u2 Main St, 2 people: 2 never replied',
      'u1 Main St, 1 person: 1 never replied',
    ]);
  });

  it('opens the first property on first arrival and folds the rest', () => {
    render(ui(ok([property('u1', [person('a')]), property('u2', [person('b')])])));
    expect(lineFor('u1')).toHaveAttribute('aria-expanded', 'true');
    expect(lineFor('u2')).toHaveAttribute('aria-expanded', 'false');
    const people = screen.getByRole('list', { name: 'People waiting on u1 Main St' });
    expect(lineFor('u1')).toHaveAttribute('aria-controls', people.id);
    expect(screen.queryByRole('list', { name: 'People waiting on u2 Main St' })).not.toBeInTheDocument();
  });

  it('a person row shows the name, the quiet text and the state tag, in the order given, and opens the contact page', () => {
    render(
      ui(
        ok([
          property('u1', [
            person('marcus', { name: 'Marcus Lee', state: 'replied', quietSince: daysBefore(3) }),
            person('dana', { name: 'Dana Ruiz', quietSince: daysBefore(6) }),
          ]),
        ]),
      ),
    );
    const people = screen.getByRole('list', { name: 'People waiting on u1 Main St' });
    expect(within(people).getAllByRole('link').map((a) => a.getAttribute('aria-label'))).toEqual([
      'Marcus Lee, Replied, then quiet 3 days',
      'Dana Ruiz, No reply in 6 days',
    ]);
    const marcus = within(people).getByRole('link', { name: 'Marcus Lee, Replied, then quiet 3 days' });
    expect(marcus).toHaveAttribute('href', '/contacts/marcus');
    expect(within(marcus).getByText('Replied')).toBeInTheDocument();
    expect(within(marcus).getByText('Replied, then quiet 3 days')).toBeInTheDocument();
    const dana = within(people).getByRole('link', { name: 'Dana Ruiz, No reply in 6 days' });
    expect(dana).toHaveAttribute('href', '/contacts/dana');
    expect(within(dana).getByText('No reply yet')).toBeInTheDocument();
    // No Interested / Not interested on Today (spec 6.2).
    expect(screen.queryByRole('button', { name: /interested/i })).not.toBeInTheDocument();
  });

  it('a caseworker carries a role tag; another partner does not', () => {
    render(
      ui(
        ok([
          property('u1', [
            person('cw', { name: 'Ana Case', type: 'partner', role: 'Caseworker' }),
            person('pd', { name: 'Paul Dir', type: 'partner', role: 'Program director' }),
          ]),
        ]),
      ),
    );
    const cw = screen.getByRole('link', { name: 'Ana Case, Caseworker, No reply in 6 days' });
    expect(within(cw).getByText('Caseworker')).toBeInTheDocument();
    const pd = screen.getByRole('link', { name: 'Paul Dir, No reply in 6 days' });
    expect(within(pd).queryByText('Caseworker')).not.toBeInTheDocument();
  });

  it("keeps the viewer's choices by unitId across a live refetch; a property that appears later starts folded", async () => {
    const user = userEvent.setup();
    const { rerender } = render(ui(ok([property('u1', [person('a')]), property('u2', [person('b')])])));
    await user.click(lineFor('u1')); // fold the seeded one
    await user.click(lineFor('u2')); // open the second
    // A refetch: a new property arrives FIRST and the order shifts. Nothing is
    // re-seeded - the first line now is u3, and it starts folded.
    rerender(ui(ok([property('u3', [person('c')]), property('u2', [person('b')]), property('u1', [person('a')])])));
    expect(lineFor('u3')).toHaveAttribute('aria-expanded', 'false');
    expect(lineFor('u2')).toHaveAttribute('aria-expanded', 'true');
    expect(lineFor('u1')).toHaveAttribute('aria-expanded', 'false');
  });

  it('seeds on the first load that HAS properties (an empty first load seeds nothing)', () => {
    const { rerender } = render(ui(ok([])));
    expect(screen.queryByRole('heading', { name: /Quiet shares/ })).not.toBeInTheDocument();
    rerender(ui(ok([property('u1', [person('a')]), property('u2', [person('b')])])));
    expect(lineFor('u1')).toHaveAttribute('aria-expanded', 'true');
    expect(lineFor('u2')).toHaveAttribute('aria-expanded', 'false');
  });

  it('an open property shows ALL its people (the limit counts property lines)', () => {
    render(ui(ok([property('u1', Array.from({ length: 7 }, (_, i) => person(`p${i}`)))])));
    expect(within(screen.getByRole('list', { name: 'People waiting on u1 Main St' })).getAllByRole('link')).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /^Show all/ })).not.toBeInTheDocument();
  });

  it('more than 5 properties: "Show all N properties" expands in place', async () => {
    const user = userEvent.setup();
    render(ui(ok(Array.from({ length: 7 }, (_, i) => property(`u${i}`, [person(`p${i}`)])))));
    const list = screen.getByRole('list', { name: 'Quiet shares' });
    expect(within(list).getAllByRole('button', { name: /Main St, / })).toHaveLength(5);
    const toggle = screen.getByRole('button', { name: 'Show all 7 properties' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(list).getAllByRole('button', { name: /Main St, / })).toHaveLength(7);
    expect(toggle).toHaveAccessibleName('Show fewer');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  // The note says what was READ, in the Follow up tab's wording (planner
  // review ADV-1): "Showing the first 100 properties" read as if up to 100
  // property lines were on screen.
  it('a truncated read says "Only the first 100 available properties were checked."', () => {
    const { unmount } = render(ui(ok([property('u1', [person('a')])], { truncated: true })));
    expect(screen.getByText('Only the first 100 available properties were checked.')).toBeInTheDocument();
    unmount();
    render(ui(ok([property('u1', [person('a')])])));
    expect(screen.queryByText('Only the first 100 available properties were checked.')).not.toBeInTheDocument();
  });

  // Planner review ADV-1: with no quiet person in the first 100 available
  // properties and the rest never read, the section used to return null
  // before its note, so nothing said the read was incomplete. A complete
  // empty read still hides the section ("an empty section is not rendered").
  it('a truncated read with NO property lines still shows the heading, the help line and the note', () => {
    render(ui(ok([], { truncated: true })));
    expect(screen.getByRole('heading', { level: 2, name: 'Quiet shares' })).toHaveTextContent(/^Quiet shares$/);
    expect(
      screen.getByText(
        'Properties sent in the last 14 days. Replied and then went quiet for 2+ days, or never replied in 5+ days. A message or call from either side restarts the clock; sending another property does not.',
      ),
    ).toBeInTheDocument();
    // The Follow up tab's note markup: a polite status line.
    expect(screen.getByRole('status')).toHaveTextContent(/^Only the first 100 available properties were checked\.$/);
    // No property lines: no list, no line buttons, no Show all.
    expect(screen.queryByRole('list', { name: 'Quiet shares' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('unavailable: the bare heading and "We couldn\'t load quiet shares." in its place', () => {
    render(ui({ status: 'unavailable' }));
    expect(screen.getByRole('heading', { level: 2, name: 'Quiet shares' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("We couldn't load quiet shares.");
  });

  it('an empty section is not rendered', () => {
    const { container } = render(ui(ok([])));
    expect(container.querySelector('section')).toBeNull();
  });
});
