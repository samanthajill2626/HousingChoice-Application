// OrgListSection - Settings > Housing authorities & agencies (spec 2026-10-06
// D10-D13; plan 3.6). Visible to EVERY signed-in user (the tab is not
// admin-only and its route is unguarded): everyone sees the two lists - the
// name, its spellings, its notes and how many records use it - adds an entry
// (through "Is this really new?") and edits notes. Admin-only actions render
// only for `useAuth().isAdmin` - absent, never merely disabled, for a VA (S14
// S8) - and the server enforces requireRole('admin') on each. The data and the
// polling while a rewrite runs: useOrgAdmin.
//
// Layout (design review 2026-10-07 Option B): three segments with counts and
// a search (OrgListPane), a compact list beside a detail panel
// (OrgDetailPanel; NotOnListPanel for a value) on the shared two-pane shell -
// one pane at a time at its narrow width, with a Back link. What is selected
// lives in the URL (orgSelection). Focus follows the selection: into the
// panel's heading when something is picked, back to its row on Back or Close.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { runOrgRewriteAgain, type OrgEntry, type OrgKind } from '../../api/index.js';
import { serverNowMs } from '../../api/serverClock.js';
import { useAuth } from '../../app/AuthContext.js';
import { Button, Spinner, useTwoPaneNarrow } from '../../ui/index.js';
import shell from '../../ui/twoPaneShell.module.css';
import { NewOrgDialog } from '../orgs/NewOrgDialog.js';
import { canRunAgain, orgErrorCopy, rewriteStatusText } from '../orgs/orgCopy.js';
import {
  DeleteDialog,
  KindDialog,
  MergeDialog,
  NotesDialog,
  RenameDialog,
  SpellingsDialog,
  skippedSpellingsNotice,
} from './OrgEntryDialogs.js';
import { OrgEntryPanel, OrgPanelMessage, OrgPanelPlaceholder, type EntryAction } from './OrgDetailPanel.js';
import { NotOnListList, OrgEntryList, OrgViewBar, type RowRef } from './OrgListPane.js';
import { NotOnListPanel } from './NotOnListSection.js';
import {
  SEGMENT_KIND,
  entryHref,
  entryMatches,
  listHref,
  readOrgLocation,
  segmentForKind,
  selectionKey,
  valueKey,
  valueMatches,
  type OrgSegment,
} from './orgSelection.js';
import { useOrgAdmin } from './useOrgAdmin.js';
import styles from './OrgListSection.module.css';
import layout from './OrgSettings.module.css';

/** The entry dialog that is open, if any (everything but notes is admin-only). */
type EntryDialog = {
  action: EntryAction;
  entry: OrgEntry;
};

const LEDE =
  'The names records use for who runs a tenant voucher (housing authorities) and who helps the tenant ' +
  '(agencies). Everyone can add names and edit notes; spellings, renames and settling the values that ' +
  'are not on the list are for admins.';

function byName(a: OrgEntry, b: OrgEntry): number {
  return a.name.localeCompare(b.name);
}

export function OrgListSection(): React.JSX.Element {
  const admin = useOrgAdmin();
  const { isAdmin } = useAuth();
  const [adding, setAdding] = useState<OrgKind | null>(null);
  const [dialog, setDialog] = useState<EntryDialog | null>(null);
  const [runAgainBusy, setRunAgainBusy] = useState(false);
  // A result to tell staff about (a failed Run again, a spelling D12 skipped).
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // An entry just added, shown in the panel until the re-read lists it.
  const [justAdded, setJustAdded] = useState<OrgEntry | null>(null);
  const { list } = admin;

  const { orgId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const narrow = useTwoPaneNarrow();
  const { view, selection } = readOrgLocation(orgId, searchParams);
  const selectedEntry =
    selection?.type === 'entry'
      ? (list.entries.find((e) => e.orgId === selection.orgId) ??
        (justAdded?.orgId === selection.orgId ? justAdded : undefined))
      : undefined;
  // An entry's kind picks its list (so a kind change follows it); a value is
  // always "Not on the list"; otherwise the URL's view.
  const segment: OrgSegment =
    selectedEntry !== undefined
      ? segmentForKind(selectedEntry.kind)
      : selection?.type === 'value'
        ? 'not-on-list'
        : view;
  const selectedKey = selectionKey(selection);

  // Focus follows the selection (review P11): a new pick moves it to the
  // panel's heading; leaving the panel (Back, Close, the browser's Back)
  // returns it to the row it came from - or, after the entry or value left
  // the list (Delete, Merge, a settle), to the list's heading. The first
  // render takes no focus: a deep link must not steal it on page load.
  const panelHeadingRef = useRef<HTMLHeadingElement>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowLinks = useRef(new Map<string, HTMLAnchorElement>());
  const focusListNext = useRef(false);
  const previousKey = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = previousKey.current;
    previousKey.current = selectedKey;
    if (previous === undefined || previous === selectedKey) return;
    if (selectedKey !== null) {
      panelHeadingRef.current?.focus();
    } else if (focusListNext.current) {
      listHeadingRef.current?.focus();
    } else if (previous !== null) {
      rowLinks.current.get(previous)?.focus();
    }
    focusListNext.current = false;
  }, [selectedKey]);

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
  // The heartbeat is a SERVER stamp: judge it on the server's clock, as the
  // server's lock does (code review R1-ADV-FE-4; api/serverClock.ts).
  const serverNow = serverNowMs();
  const closeDialog = (): void => setDialog(null);
  // An action that succeeds clears the notice an earlier one left: it would no
  // longer describe the page (worklist RE2-3).
  const closeAndReload = (): void => {
    setDialog(null);
    setNotice(null);
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

  // Leave the panel once its entry or value has left the list (Delete, Merge,
  // a settle): focus then goes to the list's heading, not to a row that is
  // about to disappear.
  const leaveForList = (): void => {
    focusListNext.current = true;
    void navigate(listHref(segment));
  };
  const rowRef: RowRef = (key) => (el) => {
    if (el !== null) rowLinks.current.set(key, el);
    else rowLinks.current.delete(key);
  };

  // The search narrows every list at once, so each segment's count says
  // where the matches are.
  const ofKind = (kind: OrgKind): OrgEntry[] => list.entries.filter((e) => e.kind === kind);
  const matching = (kind: OrgKind): OrgEntry[] => ofKind(kind).filter((e) => entryMatches(e, query)).sort(byName);
  const housingAuthorities = matching('housing_authority');
  const agencies = matching('agency');
  const notOnList = admin.notOnList?.filter((row) => valueMatches(row, query)) ?? null;
  const counts: Record<OrgSegment, number | null> = {
    'housing-authorities': housingAuthorities.length,
    agencies: agencies.length,
    'not-on-list': notOnList?.length ?? null,
  };

  let panel: React.ReactNode;
  if (selection === null) {
    panel = <OrgPanelPlaceholder segment={segment} isAdmin={isAdmin} />;
  } else if (selection.type === 'entry') {
    panel =
      selectedEntry !== undefined ? (
        <OrgEntryPanel
          entry={selectedEntry}
          usage={admin.usage?.[selectedEntry.orgId]}
          isAdmin={isAdmin}
          rewriteLive={admin.rewriteLive}
          segment={segment}
          narrow={narrow}
          headingRef={panelHeadingRef}
          onAction={(action) => setDialog({ action, entry: selectedEntry })}
        />
      ) : (
        <OrgPanelMessage
          segment={segment}
          narrow={narrow}
          headingRef={panelHeadingRef}
          title="Name not found"
          text="This name is not on the list - it may have been merged or deleted, or the link is out of date."
        />
      );
  } else {
    const row = admin.notOnList?.find((r) => r.field === selection.field && r.value === selection.value);
    if (row !== undefined) {
      panel = (
        <NotOnListPanel
          key={valueKey(row.field, row.value)}
          row={row}
          rows={admin.notOnList ?? []}
          entries={list.entries}
          isAdmin={isAdmin}
          rewriteLive={admin.rewriteLive}
          narrow={narrow}
          headingRef={panelHeadingRef}
          onSettled={(result) => {
            admin.reload();
            setNotice(result.skippedSpellings.length > 0 ? skippedSpellingsNotice(result.skippedSpellings) : null);
            leaveForList();
          }}
        />
      );
    } else if (admin.notOnList === null && !admin.notOnListError) {
      panel = (
        <div className={layout.center}>
          <Spinner />
        </div>
      );
    } else {
      panel = (
        <OrgPanelMessage
          segment={segment}
          narrow={narrow}
          headingRef={panelHeadingRef}
          title={selection.value}
          text={
            admin.notOnList === null
              ? "Couldn't load the values that are not on the list."
              : 'No record holds this value any more - it was settled or changed.'
          }
        />
      );
    }
  }

  // One pane at a time at the shell's narrow width: the list, or the panel
  // (whose Back link returns to the list) - with nothing above the panel but
  // the update status.
  const panelOnly = narrow && selection !== null;

  return (
    <div className={layout.page}>
      {panelOnly ? null : <p className={layout.lede}>{LEDE}</p>}
      {lastRewrite !== undefined ? (
        <div className={styles.statusRow}>
          <p className={styles.status}>{rewriteStatusText(lastRewrite, serverNow)}</p>
          {isAdmin && canRunAgain(lastRewrite, serverNow) ? (
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
      {panelOnly ? null : (
        <OrgViewBar
          segment={segment}
          counts={counts}
          query={query}
          onSegment={(next) => void navigate(listHref(next))}
          onQuery={setQuery}
        />
      )}
      <div className={layout.split}>
        <div className={`${layout.listPane} ${selection === null ? shell.paneActive : shell.paneHidden}`}>
          {segment === 'not-on-list' ? (
            <NotOnListList
              rows={notOnList}
              total={admin.notOnList?.length ?? 0}
              error={admin.notOnListError}
              query={query}
              selectedKey={selectedKey}
              headingRef={listHeadingRef}
              rowRef={rowRef}
              onRetry={admin.reload}
            />
          ) : (
            <OrgEntryList
              kind={SEGMENT_KIND[segment]}
              entries={segment === 'agencies' ? agencies : housingAuthorities}
              total={ofKind(SEGMENT_KIND[segment]).length}
              query={query}
              usage={admin.usage}
              selectedKey={selectedKey}
              headingRef={listHeadingRef}
              rowRef={rowRef}
              onAdd={() => setAdding(SEGMENT_KIND[segment])}
            />
          )}
        </div>
        <div className={`${layout.detailPane} ${selection !== null ? shell.paneActive : shell.paneHidden}`}>
          {panel}
        </div>
      </div>
      {adding !== null ? (
        <NewOrgDialog
          kind={adding}
          text=""
          mode="settings"
          onAdded={(entry) => {
            // A clean action: an earlier notice no longer describes the page
            // (worklist RE2-3; code review R1-CONF-2). The new entry opens in
            // the panel at once; the re-read then lists it.
            setAdding(null);
            setNotice(null);
            setJustAdded(entry);
            admin.reload();
            void navigate(entryHref(entry.orgId));
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
      {dialog?.action === 'notes' ? (
        <NotesDialog entry={dialog.entry} onSaved={closeAndReload} onClose={closeDialog} />
      ) : null}
      {dialog?.action === 'spellings' ? (
        <SpellingsDialog entry={dialog.entry} onSaved={closeAndReload} onClose={closeDialog} />
      ) : null}
      {dialog?.action === 'rename' ? (
        <RenameDialog
          entry={dialog.entry}
          usage={admin.usage?.[dialog.entry.orgId]}
          onRenamed={(result) => {
            closeAndReload();
            setNotice(
              result.skippedSpellings !== undefined && result.skippedSpellings.length > 0
                ? skippedSpellingsNotice(result.skippedSpellings)
                : null,
            );
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.action === 'merge' ? (
        <MergeDialog
          entry={dialog.entry}
          entries={list.entries}
          usage={admin.usage?.[dialog.entry.orgId]}
          onMerged={() => {
            closeAndReload();
            leaveForList();
          }}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.action === 'kind' ? (
        <KindDialog
          entry={dialog.entry}
          usage={admin.usage?.[dialog.entry.orgId]}
          onChanged={closeAndReload}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.action === 'delete' ? (
        <DeleteDialog
          entry={dialog.entry}
          usage={admin.usage?.[dialog.entry.orgId]}
          onDeleted={() => {
            closeAndReload();
            leaveForList();
          }}
          onClose={closeDialog}
        />
      ) : null}
    </div>
  );
}
