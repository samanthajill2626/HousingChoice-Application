// HubLayout — the responsive conversation hub. It frames the inbox + thread as
// a TWO-PANE workspace on desktop and a STACKED full-screen flow on mobile:
//
//   Desktop (≥ --hc-hub-breakpoint, 900px): the conversation LIST sits in a
//   fixed-width card on the left (its own scroll) and the SELECTED THREAD fills
//   the rest on the right (its own card + scroll). Selecting a row updates the
//   right pane via the nested <Outlet/> without unmounting the list. At '/' the
//   right pane shows a friendly "Select a conversation" empty state.
//
//   Mobile (< 900px): only ONE pane shows. At '/' the list is the full screen;
//   navigating to /conversations/:id shows just that thread full-screen (with
//   the thread's own back button). The two panes are never both visible.
//
// Wired into the router under <AppLayout/>: the index route ('/') and
// 'conversations/:id' nest here, so the list pane is shared across both.
import { Outlet, useParams } from 'react-router-dom';
import Inbox from '../routes/Inbox.js';
import { InboxIcon } from '../ui/index.js';
import styles from './HubLayout.module.css';

export function HubLayout(): React.JSX.Element {
  // A thread is selected when the nested route carries a conversation id. On
  // mobile this drives which single pane is visible (CSS does the actual
  // show/hide via the data-attribute below).
  const { id } = useParams<{ id: string }>();
  const threadSelected = id !== undefined && id.length > 0;

  return (
    <div className={styles.hub} data-thread-selected={threadSelected ? 'true' : 'false'}>
      {/* Left: the conversation list (its own scroll + card). */}
      <div className={styles.listPane}>
        <Inbox />
      </div>

      {/* Right: the selected thread, or a friendly empty state at '/'. */}
      <div className={styles.threadPane}>
        {threadSelected ? (
          <Outlet />
        ) : (
          <div className={styles.empty}>
            <InboxIcon size={32} />
            <p className={styles.emptyTitle}>Select a conversation</p>
            <p className={styles.emptyHint}>Pick a thread on the left to read and reply.</p>
          </div>
        )}
      </div>
    </div>
  );
}
