// useTeam — owns the Team section's data: the roster (GET /api/users), the
// idempotent invite (POST), and an OPTIMISTIC role change (PATCH) that reverts
// on the server-side lockout guards (cannot_demote_self / cannot_demote_last_admin
// → 409). The list is small + bounded (the team), so no pagination.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  assignInboundVoiceLine,
  clearInboundVoiceLine,
  inviteUser,
  listUsers,
  removeUser,
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

/** The result of an inbound-voice-line assign/clear: ok, or a per-row error to
 *  show inline (e.g. the user has no verified cell → can't hold the line). */
export type VoiceLineResult = { ok: true } | { ok: false; error: string };

/** The result of a remove: ok (row dropped from the roster), or a per-row error
 *  to show in the confirm dialog (e.g. a 409 guard). Never throws. */
export type RemoveResult = { ok: true } | { ok: false; error: string };

export interface TeamState {
  status: TeamStatus;
  users: AdminUserView[];
  retry: () => void;
  /** Invite (idempotent). Throws ApiError on a 400 (caller shows it inline). */
  invite: (email: string, role: UserRole) => Promise<InviteResult>;
  /** Optimistically change a user's role; reverts + returns an error on a 409
   *  lockout guard. Never throws. */
  changeRole: (userId: string, role: UserRole) => Promise<RoleChangeResult>;
  /** Assign the single inbound voice line to a user (MOVES it off any prior
   *  holder — the hook flips the whole roster so only one badge shows). Returns
   *  a friendly error on 409 cell_not_verified. Never throws. */
  assignVoiceLine: (userId: string) => Promise<VoiceLineResult>;
  /** Clear the inbound voice line from its current holder. Never throws. */
  clearVoiceLine: (userId: string) => Promise<VoiceLineResult>;
  /** Remove a teammate (hard delete). On success the row is dropped from the
   *  roster; on a 409 guard returns a friendly error. Never throws. */
  remove: (userId: string) => Promise<RemoveResult>;
}

/** Map the server's lockout `error` codes to a friendly inline message. */
function lockoutMessage(code: string): string | undefined {
  if (code === 'cannot_demote_self') return "You can't remove your own admin access.";
  if (code === 'cannot_demote_last_admin') return 'The team must keep at least one admin.';
  return undefined;
}

/** Map the server's remove-guard `error` codes to a friendly message. */
function removeMessage(code: string): string | undefined {
  if (code === 'cannot_remove_last_admin') return 'The team must keep at least one admin.';
  if (code === 'cannot_remove_self') return "You can't remove your own account.";
  if (code === 'voice_line_assigned')
    return 'Reassign the inbound voice line before removing this teammate.';
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

  // Assign the single inbound voice line. On success the server returns the
  // updated holder; we flip the WHOLE roster so exactly one user carries the
  // flag (single-holder invariant reflected in the UI without a refetch).
  const assignVoiceLine = useCallback(async (userId: string): Promise<VoiceLineResult> => {
    try {
      const updated = await assignInboundVoiceLine(userId);
      setUsers((prev) =>
        prev.map((u) =>
          u.userId === userId
            ? { ...updated, inbound_voice_line: true }
            : { ...u, inbound_voice_line: false },
        ),
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cell_not_verified') {
        return {
          ok: false,
          error: 'This teammate needs a verified cell before holding the inbound line.',
        };
      }
      return { ok: false, error: "Couldn't assign the inbound line — please try again." };
    }
  }, []);

  const clearVoiceLine = useCallback(async (userId: string): Promise<VoiceLineResult> => {
    try {
      const updated = await clearInboundVoiceLine(userId);
      setUsers((prev) =>
        prev.map((u) => (u.userId === userId ? { ...updated, inbound_voice_line: false } : u)),
      );
      return { ok: true };
    } catch {
      return { ok: false, error: "Couldn't clear the inbound line — please try again." };
    }
  }, []);

  const remove = useCallback(async (userId: string): Promise<RemoveResult> => {
    try {
      await removeUser(userId);
      // Drop the row locally so the roster reflects the removal without a reload.
      setUsers((prev) => prev.filter((u) => u.userId !== userId));
      return { ok: true };
    } catch (err) {
      if (err instanceof ApiError) {
        const msg = removeMessage(err.code);
        return { ok: false, error: msg ?? "Couldn't remove the teammate. Please try again." };
      }
      return { ok: false, error: "Couldn't remove the teammate. Please try again." };
    }
  }, []);

  return { status, users, retry, invite, changeRole, assignVoiceLine, clearVoiceLine, remove };
}
