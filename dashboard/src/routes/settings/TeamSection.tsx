// TeamSection — admin-only (also route-guarded). The team roster (desktop table
// / mobile stacked cards) with an inline role control per row, plus the invite
// form. Lockout guards (cannot_demote_self / cannot_demote_last_admin) are
// server-side; useTeam reverts the optimistic role change and the row shows the
// message inline.
import { useState } from 'react';
import { useAuth } from '../../app/AuthContext.js';
import { useTeam } from './useTeam.js';
import { UserRow } from './UserRow.js';
import { InviteForm } from './InviteForm.js';
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog.js';
import { useIsMobile } from './useIsMobile.js';
import { Button, Spinner } from '../../ui/index.js';
import type { AdminUserView } from '../../api/index.js';
import styles from './TeamSection.module.css';

/** Why this member's Remove is disabled, or undefined when removable. Order
 *  mirrors the server guards: last-admin (fundamental invariant) -> self ->
 *  voice-line-holder. */
function removeDisabledReason(
  u: AdminUserView,
  meUserId: string | undefined,
  adminCount: number,
): string | undefined {
  if (u.role === 'admin' && adminCount <= 1) return 'The team must keep at least one admin.';
  if (u.userId === meUserId) return "You can't remove your own account.";
  if (u.inbound_voice_line === true) return 'Reassign the inbound voice line first.';
  return undefined;
}

export function TeamSection(): React.JSX.Element {
  const { status, users, retry, invite, changeRole, assignVoiceLine, clearVoiceLine, remove } =
    useTeam();
  const { isAdmin, me } = useAuth();
  const isMobile = useIsMobile();
  const [removing, setRemoving] = useState<AdminUserView | null>(null);
  const adminCount = users.filter((u) => u.role === 'admin').length;

  return (
    <section className={styles.section} aria-labelledby="team-heading">
      <h2 id="team-heading" className={styles.heading}>
        Team
      </h2>

      {status === 'loading' ? (
        <div className={styles.center}>
          <Spinner />
        </div>
      ) : status === 'error' ? (
        <div role="alert" className={styles.errorBlock}>
          <p>Couldn't load the team.</p>
          <Button variant="secondary" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {users.length === 0 ? (
            <p className={styles.empty}>No teammates yet — invite someone below.</p>
          ) : isMobile ? (
            <ul className={styles.cards}>
              {users.map((u) => (
                <UserRow
                  key={u.userId}
                  user={u}
                  onChangeRole={changeRole}
                  onAssignVoiceLine={assignVoiceLine}
                  onClearVoiceLine={clearVoiceLine}
                  variant="card"
                  viewerIsAdmin={isAdmin}
                  onRequestRemove={setRemoving}
                  removeDisabledReason={removeDisabledReason(u, me?.userId, adminCount)}
                />
              ))}
            </ul>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.th} scope="col">
                    Member
                  </th>
                  <th className={styles.th} scope="col">
                    Role
                  </th>
                  <th className={styles.th} scope="col">
                    Cell
                  </th>
                  <th className={styles.th} scope="col">
                    Voice line
                  </th>
                  <th className={styles.th} scope="col">
                    Status
                  </th>
                  <th className={styles.th} scope="col">
                    Last login
                  </th>
                  <th className={styles.th} scope="col">
                    <span className={styles.srOnly}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <UserRow
                    key={u.userId}
                    user={u}
                    onChangeRole={changeRole}
                    onAssignVoiceLine={assignVoiceLine}
                    onClearVoiceLine={clearVoiceLine}
                    variant="table"
                    viewerIsAdmin={isAdmin}
                    onRequestRemove={setRemoving}
                    removeDisabledReason={removeDisabledReason(u, me?.userId, adminCount)}
                  />
                ))}
              </tbody>
            </table>
          )}

          <InviteForm onInvite={invite} />
        </>
      )}

      {removing !== null ? (
        <ConfirmRemoveDialog
          user={removing}
          onClose={() => setRemoving(null)}
          onConfirm={remove}
        />
      ) : null}
    </section>
  );
}
