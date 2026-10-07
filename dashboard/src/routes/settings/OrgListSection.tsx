// OrgListSection - Settings > Housing authorities & agencies (spec 2026-10-06
// D10-D13; plan 3.6). Visible to EVERY signed-in user (the tab is not
// admin-only and its route is unguarded): everyone sees the two lists - the
// name, its spellings, its notes and how many records use it - adds an entry
// (through "Is this really new?") and edits notes. Admin-only actions render
// only for `useAuth().isAdmin` - absent, never merely disabled, for a VA (S14
// S8) - and the server enforces requireRole('admin') on each. The data and the
// polling while a rewrite runs: useOrgAdmin.
import { useId, useState } from 'react';
import { runOrgRewriteAgain, type OrgEntry, type OrgKind, type OrgUsage } from '../../api/index.js';
import { useAuth } from '../../app/AuthContext.js';
import { Button, Spinner } from '../../ui/index.js';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import {
  KIND_NOUN,
  KIND_PLURAL_TITLE,
  canRunAgain,
  orgErrorCopy,
  rewriteStatusText,
  usageText,
} from '../orgs/orgCopy.js';
import { NotesDialog } from './OrgEntryDialogs.js';
import { useOrgAdmin } from './useOrgAdmin.js';
import styles from './OrgListSection.module.css';

/** The entry dialog that is open, if any. */
type EntryDialog = { action: 'notes'; entry: OrgEntry };

const KINDS: readonly OrgKind[] = ['housing_authority', 'agency'];

const LEDE =
  'The names records use for who runs a tenant voucher (housing authorities) and who helps the tenant ' +
  '(agencies). Everyone can add names and edit notes; spellings, renames and settling the values that ' +
  'are not on the list are for admins.';

function byName(a: OrgEntry, b: OrgEntry): number {
  return a.name.localeCompare(b.name);
}

interface EntrySectionProps {
  kind: OrgKind;
  entries: readonly OrgEntry[];
  usage: OrgUsage | null;
  onAdd: () => void;
  onEditNotes: (entry: OrgEntry) => void;
  /** Extra row actions (the admin-only ones), after Edit notes. */
  rowActions?: (entry: OrgEntry) => React.ReactNode;
}

/** One list as a region (S14 S2): a table whose row header is the exact name. */
function EntrySection({ kind, entries, usage, onAdd, onEditNotes, rowActions }: EntrySectionProps): React.JSX.Element {
  const headingId = useId();
  const title = KIND_PLURAL_TITLE[kind];
  const rows = [...entries].sort(byName);
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId} className={styles.heading}>
          {title}
        </h2>
        <Button variant="secondary" size="sm" type="button" onClick={onAdd}>
          {`Add ${KIND_NOUN[kind]}`}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>{`No ${title.toLowerCase()} on the list yet.`}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.th}>
                  Name
                </th>
                <th scope="col" className={styles.th}>
                  Spellings
                </th>
                <th scope="col" className={styles.th}>
                  Notes
                </th>
                <th scope="col" className={styles.th}>
                  Used by
                </th>
                <th scope="col" className={styles.th}>
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.orgId}>
                  <th scope="row" className={`${styles.cell} ${styles.nameCell}`}>
                    {entry.name}
                  </th>
                  <td className={styles.cell}>{entry.spellings.length > 0 ? entry.spellings.join(', ') : '-'}</td>
                  <td className={`${styles.cell} ${styles.notesCell}`}>
                    {entry.notes !== undefined && entry.notes !== '' ? entry.notes : '-'}
                  </td>
                  <td className={styles.cell}>{usageText(usage?.[entry.orgId])}</td>
                  <td className={styles.cell}>
                    <div className={styles.actions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        aria-label={`Edit notes for ${entry.name}`}
                        onClick={() => onEditNotes(entry)}
                      >
                        Edit notes
                      </Button>
                      {rowActions?.(entry)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function OrgListSection(): React.JSX.Element {
  const admin = useOrgAdmin();
  const { isAdmin } = useAuth();
  const [adding, setAdding] = useState<OrgKind | null>(null);
  const [dialog, setDialog] = useState<EntryDialog | null>(null);
  const [runAgainBusy, setRunAgainBusy] = useState(false);
  // A result to tell staff about (a failed Run again, a spelling D12 skipped).
  const [notice, setNotice] = useState<string | null>(null);
  const { list } = admin;

  if (list.loading) {
    return (
      <div className={styles.center}>
        <Spinner />
      </div>
    );
  }
  if (list.error && list.version === null) {
    return (
      <div className={styles.errorBlock} role="alert">
        <p>{"Couldn't load housing authorities and agencies."}</p>
        <Button variant="secondary" size="sm" type="button" onClick={admin.reload}>
          Retry
        </Button>
      </div>
    );
  }

  const lastRewrite = list.lastRewrite;
  const closeDialog = (): void => setDialog(null);
  const closeAndReload = (): void => {
    setDialog(null);
    admin.reload();
  };

  async function runAgain(): Promise<void> {
    if (runAgainBusy) return;
    setRunAgainBusy(true);
    setNotice(null);
    try {
      await runOrgRewriteAgain();
      admin.reload();
    } catch (err) {
      setNotice(orgErrorCopy(err));
    } finally {
      setRunAgainBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <p className={styles.lede}>{LEDE}</p>
      {lastRewrite !== undefined ? (
        <div className={styles.statusRow}>
          <p className={styles.status}>{rewriteStatusText(lastRewrite)}</p>
          {isAdmin && canRunAgain(lastRewrite) ? (
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => void runAgain()}
              disabled={runAgainBusy}
            >
              Run again
            </Button>
          ) : null}
        </div>
      ) : null}
      {notice !== null ? <p className={styles.notice}>{notice}</p> : null}
      {admin.usageError ? (
        <div className={styles.errorBlock} role="alert">
          <p>{"Couldn't load how many records use each name."}</p>
          <Button variant="secondary" size="sm" type="button" onClick={admin.reload}>
            Retry
          </Button>
        </div>
      ) : null}
      {KINDS.map((kind) => (
        <EntrySection
          key={kind}
          kind={kind}
          entries={list.entries.filter((e) => e.kind === kind)}
          usage={admin.usage}
          onAdd={() => setAdding(kind)}
          onEditNotes={(entry) => setDialog({ action: 'notes', entry })}
        />
      ))}
      {adding !== null ? (
        <NewOrgDialog
          kind={adding}
          text=""
          mode="settings"
          onAdded={() => {
            setAdding(null);
            admin.reload();
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {dialog?.action === 'notes' ? (
        <NotesDialog entry={dialog.entry} onSaved={closeAndReload} onClose={closeDialog} />
      ) : null}
    </div>
  );
}
