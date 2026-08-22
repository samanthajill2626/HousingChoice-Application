import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getAppIdentityRaw } from '../api/index.js';

export type EnvironmentIdentity =
  | { variant: 'production'; themeColor: '#1f6feb' }
  | { variant: 'non-production'; themeColor: '#f4c542' };

export type EnvironmentIdentityLoader = () => Promise<EnvironmentIdentity>;

export const PRODUCTION_IDENTITY: EnvironmentIdentity = Object.freeze({
  variant: 'production',
  themeColor: '#1f6feb',
});

export function parseEnvironmentIdentity(value: unknown): EnvironmentIdentity {
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (row['variant'] === 'production' && row['themeColor'] === '#1f6feb') {
      return { variant: 'production', themeColor: '#1f6feb' };
    }
    if (row['variant'] === 'non-production' && row['themeColor'] === '#f4c542') {
      return { variant: 'non-production', themeColor: '#f4c542' };
    }
  }
  return PRODUCTION_IDENTITY;
}

export function createEnvironmentIdentityLoader(
  read: () => Promise<unknown>,
): EnvironmentIdentityLoader {
  let pending: Promise<EnvironmentIdentity> | undefined;
  return () => {
    pending ??= read().then(parseEnvironmentIdentity).catch(() => PRODUCTION_IDENTITY);
    return pending;
  };
}

const loadEnvironmentIdentity = createEnvironmentIdentityLoader(getAppIdentityRaw);
const EnvironmentIdentityContext = createContext<EnvironmentIdentity>(PRODUCTION_IDENTITY);

export function EnvironmentIdentityProvider({
  children,
  loadIdentity = loadEnvironmentIdentity,
}: {
  children: ReactNode;
  loadIdentity?: EnvironmentIdentityLoader;
}): React.JSX.Element {
  const [identity, setIdentity] = useState<EnvironmentIdentity>(PRODUCTION_IDENTITY);

  useEffect(() => {
    let active = true;
    void loadIdentity().then((next) => {
      if (!active) return;
      setIdentity(next);
      document
        .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
        ?.setAttribute('content', next.themeColor);
    });
    return () => {
      active = false;
    };
  }, [loadIdentity]);

  return (
    <EnvironmentIdentityContext.Provider value={identity}>
      {children}
    </EnvironmentIdentityContext.Provider>
  );
}

export function useEnvironmentIdentity(): EnvironmentIdentity {
  return useContext(EnvironmentIdentityContext);
}
