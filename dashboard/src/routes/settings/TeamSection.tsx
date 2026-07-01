// TeamSection — admin-only (also route-guarded). The team roster (desktop table
// / mobile stacked cards) with an inline role control per row, plus the invite
// form. Lockout guards (cannot_demote_self / cannot_demote_last_admin) are
// server-side; useTeam reverts the optimistic role change and the row shows the
// message inline.
//
// FUTURE: no delete/deactivate in v1 (no backend for it) — see the design spec.
import { useAuth } from '../../app/AuthContext.js';
import { useTeam } from './useTeam.js';
import { UserRow } from './UserRow.js';
import { InviteForm } from './InviteForm.js';
import { useIsMobile } from './useIsMobile.js';
import { Button, Spinner } from '../../ui/index.js';
import styles from './TeamSection.module.css';

export function TeamSection(): React.JSX.Element {
  const { status, users, retry, invite, changeRole, assignVoiceLine, clearVoiceLine } = useTeam();
  const { isAdmin } = useAuth();
  const isMobile = useIsMobile();

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
                  />
                ))}
              </tbody>
            </table>
          )}

          <InviteForm onInvite={invite} />
        </>
      )}
    </section>
  );
}
