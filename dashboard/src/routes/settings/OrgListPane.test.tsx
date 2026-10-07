// OrgListPane tests - the "Not on the list" list's own states (design review
// 2026-10-07 Option B): loading, a failed read with Retry, nothing to settle,
// and nothing matching the search. The entry lists are covered through
// OrgListSection.test.tsx.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { NotOnListList, type NotOnListListProps } from './OrgListPane.js';

function renderList(over: Partial<NotOnListListProps>): NotOnListListProps {
  const props: NotOnListListProps = {
    rows: [],
    total: 0,
    error: false,
    query: '',
    selectedKey: null,
    headingRef: { current: null },
    rowRef: () => () => {},
    onRetry: vi.fn(),
    ...over,
  };
  render(
    <MemoryRouter>
      <NotOnListList {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe('NotOnListList', () => {
  it('waits while the values load', () => {
    renderList({ rows: null });
    expect(within(screen.getByRole('region', { name: 'Not on the list' })).getByRole('status')).toBeInTheDocument();
  });

  it('offers Retry when the values failed to load', async () => {
    const user = userEvent.setup();
    const props = renderList({ rows: null, error: true });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the values that are not on the list.");
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('says so when every value is on the list, and when none matches the search', () => {
    const { unmount } = render(
      <MemoryRouter>
        <NotOnListList
          rows={[]}
          total={0}
          error={false}
          query=""
          selectedKey={null}
          headingRef={{ current: null }}
          rowRef={() => () => {}}
          onRetry={vi.fn()}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Every stored value is on the lists.')).toBeInTheDocument();
    unmount();
    renderList({ rows: [], total: 3, query: ' zz ' });
    expect(screen.getByText('No values match "zz".')).toBeInTheDocument();
  });
});
