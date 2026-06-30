// useTeam — owns the Team section's data: the roster (GET /api/users), the
// idempotent invite (POST), and an OPTIMISTIC role change (PATCH) that reverts
// on the server-side lockout guards (cannot_demote_self / cannot_demote_last_admin
// → 409). The list is small + bounded (the team), so no pagination.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  inviteUser,
  listUsers,
  setUserRole,
  type AdminUserView,
  type UserRole,
} from '../../api/index.js';

export type TeamStatus = 'loading' | 'ready' | 'error';

/** The result of an invite: `created=false` means the email was already on the
 *  team (a clean no-op the UI surfaces as "already on the team"). */
export interface InviteResult {
  user: AdminUserView;
  created: boolean;
}

/** The result of a role change: ok, or a per-row error message to show inline
 *  (the optimistic change has already been reverted by the hook). */
export type RoleChangeResult = { ok: true } | { ok: false; error: string };

export interface TeamState {
  status: TeamStatus;
  users: AdminUserView[];
  retry: () => void;
  /** Invite (idempotent). Throws ApiError on a 400 (caller shows it inline). */
  invite: (email: string, role: UserRole) => Promise<InviteResult>;
  /** Optimistically change a user's role; reverts + returns an error on a 409
   *  lockout guard. Never throws. */
  changeRole: (userId: string, role: UserRole) => Promise<RoleChangeResult>;
}

/** Map the server's lockout `error` codes to a friendly inline message. */
function lockoutMessage(code: string): string | undefined {
  if (code === 'cannot_demote_self') return "You can't remove your own admin access.";
  if (code === 'cannot_demote_last_admin') return 'The team must keep at least one admin.';
  return undefined;
}

export function useTeam(): TeamState {
  const [status, setStatus] = useState<TeamStatus>('loading');
  const [users, setUsers] = useState<AdminUserView[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const list = await listUsers(controller.signal);
      if (controller.signal.aborted) return;
      setUsers(list);
      setStatus('ready');
    } catch (err) {
      if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
        return;
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const retry = useCallback(() => {
    setStatus('loading');
    void load();
  }, [load]);

  const invite = useCallback(async (email: string, role: UserRole): Promise<InviteResult> => {
    const result = await inviteUser({ email, role });
    // Upsert the returned user into the roster (new on created; refreshed name/role
    // otherwise) so the list reflects the invite without a full reload.
    setUsers((prev) => {
      const idx = prev.findIndex((u) => u.userId === result.user.userId);
      if (idx === -1) return [...prev, result.user];
      const next = [...prev];
      next[idx] = result.user;
      return next;
    });
    return result;
  }, []);

  const changeRole = useCallback(
    async (userId: string, role: UserRole): Promise<RoleChangeResult> => {
      // Optimistic: flip the row now, capture the prior role to revert on failure.
      let prevRole: UserRole | undefined;
      setUsers((prev) =>
        prev.map((u) => {
          if (u.userId !== userId) return u;
          prevRole = u.role;
          return { ...u, role };
        }),
      );
      try {
        const { user } = await setUserRole(userId, role);
        // Commit the server's canonical row (epoch/role authoritative).
        setUsers((prev) => prev.map((u) => (u.userId === userId ? user : u)));
        return { ok: true };
      } catch (err) {
        // Revert the optimistic change.
        if (prevRole !== undefined) {
          const reverted = prevRole;
          setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, role: reverted } : u)));
        }
        if (err instanceof ApiError) {
          const msg = lockoutMessage(err.code);
          return { ok: false, error: msg ?? "Couldn't change the role — please try again." };
        }
        return { ok: false, error: "Couldn't change the role — please try again." };
      }
    },
    [],
  );

  return { status, users, retry, invite, changeRole };
}
