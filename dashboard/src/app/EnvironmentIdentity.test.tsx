import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppIdentityRaw } from '../api/index.js';
import {
  EnvironmentIdentityProvider,
  createEnvironmentIdentityLoader,
  parseEnvironmentIdentity,
  useEnvironmentIdentity,
} from './EnvironmentIdentity.js';

vi.mock('../api/index.js', () => ({ getAppIdentityRaw: vi.fn() }));

function Probe(): React.JSX.Element {
  const identity = useEnvironmentIdentity();
  return <span>{identity.variant}:{identity.themeColor}</span>;
}

function themeMeta(): HTMLMetaElement {
  const metas = document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  expect(metas).toHaveLength(1);
  return metas[0]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = '#1f6feb';
  document.head.append(meta);
  expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
});

afterEach(() => {
  document.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
  vi.restoreAllMocks();
});

describe('environment identity', () => {
  it('uses the real default loader once under StrictMode', async () => {
    vi.mocked(getAppIdentityRaw).mockResolvedValue({
      variant: 'non-production',
      themeColor: '#f4c542',
    });

    render(
      <StrictMode>
        <EnvironmentIdentityProvider>
          <Probe />
        </EnvironmentIdentityProvider>
      </StrictMode>,
    );

    await screen.findByText('non-production:#f4c542');
    expect(getAppIdentityRaw).toHaveBeenCalledTimes(1);
    expect(themeMeta()).toHaveAttribute('content', '#f4c542');
  });

  it('accepts only the two exact variant and theme pairs', () => {
    expect(parseEnvironmentIdentity({ variant: 'production', themeColor: '#1f6feb' })).toEqual({
      variant: 'production',
      themeColor: '#1f6feb',
    });
    expect(
      parseEnvironmentIdentity({ variant: 'non-production', themeColor: '#f4c542' }),
    ).toEqual({ variant: 'non-production', themeColor: '#f4c542' });

    for (const malformed of [
      null,
      {},
      { variant: 'non-production', themeColor: '#1f6feb' },
      { variant: 'production', themeColor: '#f4c542' },
      { variant: 'dev', themeColor: '#f4c542' },
    ]) {
      expect(parseEnvironmentIdentity(malformed)).toEqual({
        variant: 'production',
        themeColor: '#1f6feb',
      });
    }
  });

  it('shares one injected read under StrictMode and updates only the existing meta', async () => {
    const read = vi.fn(async () => ({
      variant: 'non-production',
      themeColor: '#f4c542',
    }));
    const loader = createEnvironmentIdentityLoader(read);

    render(
      <StrictMode>
        <EnvironmentIdentityProvider loadIdentity={loader}>
          <Probe />
        </EnvironmentIdentityProvider>
      </StrictMode>,
    );

    await screen.findByText('non-production:#f4c542');
    expect(read).toHaveBeenCalledTimes(1);
    expect(themeMeta()).toHaveAttribute('content', '#f4c542');
  });

  it('renders immediately and memoizes the production fallback after a failed read', async () => {
    const read = vi.fn(async () => Promise.reject(new Error('offline')));
    const loader = createEnvironmentIdentityLoader(read);

    render(
      <EnvironmentIdentityProvider loadIdentity={loader}>
        <Probe />
      </EnvironmentIdentityProvider>,
    );

    expect(screen.getByText('production:#1f6feb')).toBeInTheDocument();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(themeMeta()).toHaveAttribute('content', '#1f6feb');
    await loader();
    expect(read).toHaveBeenCalledTimes(1);
  });
});
