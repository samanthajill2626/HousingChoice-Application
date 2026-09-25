// AuthGate - the session switch. While the /auth/me probe is in flight it shows
// a centered spinner; anonymous -> the Login screen; authenticated -> children
// (the AppFrame + routes). Lives between AuthProvider and the app so every
// authenticated surface can assume a logged-in principal.
//
// It also owns the inbox list store's lifetime (spec 5.8): when the session
// goes anonymous the store is cleared from a PASSIVE effect, which React runs
// after every deleted child's cleanup - so the Inbox's own unmount save (a
// layout cleanup) has already happened and cannot repopulate the store. A
// cleanup in a deleted parent (AppFrame) would run BEFORE that save.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Spinner } from '../ui/index.js';
import Login from '../routes/Login.js';
import { clearInboxLists } from '../routes/inbox/inboxListStore.js';
import { useAuth } from './AuthContext.js';

export function AuthGate({ children }: { children: ReactNode }): React.JSX.Element {
  const { status } = useAuth();

  useEffect(() => {
    if (status === 'anonymous') clearInboxLists();
  }, [status]);

  if (status === 'loading') {
    return <Spinner center label="Loading your workspace" />;
  }
  if (status === 'anonymous') {
    return <Login />;
  }
  return <>{children}</>;
}
