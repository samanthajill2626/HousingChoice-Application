// Friendly error mapping for the admin screens. The api client throws ApiError
// with a machine-readable `code` (the server's { error } value); these helpers
// turn the codes Feature Agent 3 cares about into operator-friendly prose.
import { ApiError } from '../../api/index.js';

/**
 * Map a role-change failure to a friendly message. The server's lockout guards
 * surface as ApiError(409, ...):
 *   - 'cannot_demote_last_admin' → you can't strip the org of its only admin
 *   - 'cannot_demote_self'       → you can't change your own role
 * Anything else (403 forbidden, validation, network) falls back to a generic
 * line so the UI never shows a raw code.
 */
export function roleChangeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'cannot_demote_last_admin':
        return "You can't remove the last admin.";
      case 'cannot_demote_self':
        return "You can't change your own role.";
      case 'forbidden':
        return 'Only admins can change roles.';
      default:
        break;
    }
  }
  return "Couldn't change the role. Please try again.";
}

/**
 * Map an invite failure to a friendly message. Validation problems come back as
 * 400 (invalid email / role); 403 means a non-admin tried.
 */
export function inviteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'forbidden') return 'Only admins can invite users.';
    if (err.status === 400) return 'Enter a valid email address.';
  }
  return "Couldn't send the invite. Please try again.";
}

/**
 * Map a settings-save failure to a friendly message. VAs hit 403 'forbidden' on
 * the PUT; validation issues (too long, too many quick replies) come back 400.
 */
export function settingsErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'forbidden') return 'Only admins can edit these settings.';
    if (err.status === 400) return 'Some fields are invalid — check the limits and try again.';
  }
  return "Couldn't save settings. Please try again.";
}
