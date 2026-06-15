// BroadcastComposer (M1.8 "Share Listings") — a Sheet that drives the
// create-draft → preview → send flow against the M1.8a backend.
//
// Flow: the operator picks audience narrowers (bedroom size + housing
// authority; opt-out/unreachable exclusion is ALWAYS on and shown as enforced)
// and writes a message (merge-token hints shown). "Preview audience" creates or
// refreshes the draft (POST /broadcasts) then re-resolves the count + a small
// sample (POST /broadcasts/:id/preview). "Send" snapshots + fans out
// (POST /broadcasts/:id/send), surfacing audience_too_large / empty_audience /
// broadcast_not_draft as toasts. On a successful send it hands the broadcastId
// to the caller (which routes to the live results view).
//
// Honest identity: a sampled contact with no firstName shows the formatted
// phone, never a fabricated name. No PII is ever logged (samples stay on-screen).
import { useCallback, useState } from 'react';
import {
  ApiError,
  createBroadcast,
  previewBroadcast,
  sendBroadcast,
  type AudienceTooLargeError,
  type BroadcastPreviewResult,
  type CreateBroadcastBody,
  type UnitItem,
} from '../../api';
import { Badge, Button, Field, Input, Sheet, Spinner, Textarea, useToast } from '../../ui';
import { formatPhone } from '../thread/identity';
import {
  MERGE_TOKENS,
  defaultShareTemplate,
  unitTokenPreview,
} from './broadcast';
import styles from './BroadcastComposer.module.css';

export interface BroadcastComposerProps {
  open: boolean;
  onClose: () => void;
  /** The unit being shared (Share-Listings variant); omit for a general
   *  unit-less broadcast. Pre-fills bedroom size, housing-authority suggestion,
   *  and the default flyer-link template. */
  unit?: UnitItem;
  /** Called with the new broadcastId after a successful send, so the caller can
   *  navigate to the live results view. */
  onSent?: (broadcastId: string) => void;
}

export function BroadcastComposer({
  open,
  onClose,
  unit,
  onSent,
}: BroadcastComposerProps): React.JSX.Element {
  const toast = useToast();

  // --- Audience narrowers + message (pre-filled from the unit when present) ---
  const [bedroomSize, setBedroomSize] = useState<string>(
    typeof unit?.beds === 'number' ? String(unit.beds) : '',
  );
  const [housingAuthority, setHousingAuthority] = useState<string>(unit?.jurisdiction ?? '');
  const [template, setTemplate] = useState<string>(() => defaultShareTemplate(unit));

  // --- Draft + preview + send state ------------------------------------------
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState<BroadcastPreviewResult | undefined>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);

  const tokenPreview = unitTokenPreview(unit);

  /** Build the create body from the current form (trimmed; empty → omitted). */
  const buildBody = useCallback((): CreateBroadcastBody | { error: string } => {
    const body_template = template.trim();
    if (body_template.length === 0) {
      return { error: 'Write a message before previewing or sending.' };
    }
    const audience_filter: NonNullable<CreateBroadcastBody['audience_filter']> = {};
    const ha = housingAuthority.trim();
    if (ha.length > 0) audience_filter.housing_authority = ha;
    if (bedroomSize.trim().length > 0) {
      const n = Number(bedroomSize);
      if (!Number.isInteger(n) || n < 0 || n > 12) {
        return { error: 'Bedroom size must be a whole number between 0 and 12.' };
      }
      audience_filter.bedroomSize = n;
    }
    return {
      body_template,
      ...(unit !== undefined && { unitId: unit.unitId }),
      ...(Object.keys(audience_filter).length > 0 && { audience_filter }),
    };
  }, [template, housingAuthority, bedroomSize, unit]);

  /**
   * Preview audience: (re)create the draft with the CURRENT filter/template,
   * then resolve the live count + sample. We always create a fresh draft so a
   * changed filter is reflected (a draft's filter is snapshotted at create).
   */
  const handlePreview = useCallback(async (): Promise<void> => {
    if (previewing) return;
    setFormError(undefined);
    const body = buildBody();
    if ('error' in body) {
      setFormError(body.error);
      return;
    }
    setPreviewing(true);
    try {
      const created = await createBroadcast(body);
      setDraftId(created.broadcastId);
      const result = await previewBroadcast(created.broadcastId);
      setPreview(result);
    } catch (err) {
      setPreview(undefined);
      setDraftId(undefined);
      const msg = err instanceof ApiError ? err.message : 'Could not preview the audience.';
      setFormError(msg);
      toast.error(msg);
    } finally {
      setPreviewing(false);
    }
  }, [previewing, buildBody, toast]);

  /** Send the previewed draft, surfacing the backend refusals as toasts. */
  const handleSend = useCallback(async (): Promise<void> => {
    if (sending || draftId === undefined) return;
    setSending(true);
    setFormError(undefined);
    try {
      const result = await sendBroadcast(draftId);
      toast.success(`Broadcast sending to ${result.count} recipient${result.count === 1 ? '' : 's'}.`);
      onSent?.(result.broadcastId);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'audience_too_large') {
          const body = err.body as Partial<AudienceTooLargeError> | undefined;
          const msg =
            body?.message ?? 'Audience is too large — narrow the housing authority and/or bedroom size.';
          setFormError(msg);
          toast.error(msg);
          // Re-preview so the (still-draft) count + truncated cue refresh.
          void handlePreview();
        } else if (err.code === 'empty_audience') {
          const msg = 'No one matches this filter — adjust the bedroom size or housing authority.';
          setFormError(msg);
          toast.error(msg);
        } else if (err.code === 'broadcast_not_draft') {
          const msg = 'This broadcast was already sent.';
          setFormError(msg);
          toast.error(msg);
        } else {
          setFormError(err.message);
          toast.error(err.message);
        }
      } else {
        const msg = 'Could not send the broadcast.';
        setFormError(msg);
        toast.error(msg);
      }
    } finally {
      setSending(false);
    }
  }, [sending, draftId, toast, onSent, handlePreview]);

  // A changed filter/template invalidates the previewed draft — force a
  // re-preview before send (the draft snapshotted the old filter).
  const invalidatePreview = useCallback(() => {
    setPreview(undefined);
    setDraftId(undefined);
  }, []);

  const count = preview?.count ?? 0;
  const overCap = preview?.truncated === true;
  const canSend =
    draftId !== undefined && preview !== undefined && count > 0 && !overCap && !sending;

  const title = unit !== undefined ? 'Share this listing' : 'New broadcast';

  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <div className={styles.body}>
        <p className={styles.lead}>
          Text this {unit !== undefined ? 'listing’s flyer' : 'message'} to a filtered set of
          tenants. Opted-out and unreachable contacts are always excluded.
        </p>

        <div className={styles.filters}>
          <Field label="Bedroom size" hint="Exact voucher size; leave blank for all">
            {({ id, describedBy }) => (
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                max={12}
                placeholder="Any"
                value={bedroomSize}
                {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                onChange={(e) => {
                  setBedroomSize(e.target.value);
                  invalidatePreview();
                }}
              />
            )}
          </Field>
          <Field label="Housing authority" hint="Optional; leave blank for all">
            {({ id, describedBy }) => (
              <Input
                id={id}
                placeholder="Any"
                value={housingAuthority}
                {...(describedBy !== undefined && { 'aria-describedby': describedBy })}
                onChange={(e) => {
                  setHousingAuthority(e.target.value);
                  invalidatePreview();
                }}
              />
            )}
          </Field>
        </div>

        <div className={styles.enforced}>
          <Badge tone="neutral" dot>
            Excludes opted-out
          </Badge>
          <Badge tone="neutral" dot>
            Excludes unreachable
          </Badge>
        </div>

        <Field label="Message">
          {({ id }) => (
            <Textarea
              id={id}
              rows={4}
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                invalidatePreview();
              }}
            />
          )}
        </Field>

        <div className={styles.tokens} aria-label="Merge fields">
          <span className={styles.tokensLabel}>Merge fields:</span>
          {MERGE_TOKENS.map((t) => (
            <code key={t.token} className={styles.token} title={t.hint}>
              {t.token}
            </code>
          ))}
        </div>

        {unit !== undefined && (
          <dl className={styles.tokenPreview}>
            {tokenPreview.beds !== '' && (
              <div>
                <dt>[Beds]</dt>
                <dd>{tokenPreview.beds}</dd>
              </div>
            )}
            {tokenPreview.address !== '' && (
              <div>
                <dt>[Address]</dt>
                <dd>{tokenPreview.address}</dd>
              </div>
            )}
            {tokenPreview.rent !== '' && (
              <div>
                <dt>[Rent]</dt>
                <dd>{tokenPreview.rent}</dd>
              </div>
            )}
          </dl>
        )}

        {formError !== undefined && (
          <p className={styles.error} role="alert">
            {formError}
          </p>
        )}

        {/* Audience count preview. */}
        {previewing ? (
          <div className={styles.previewBox}>
            <Spinner size="sm" /> <span>Resolving audience…</span>
          </div>
        ) : preview !== undefined ? (
          <div className={styles.previewBox}>
            <div className={styles.count}>
              <strong>{count}</strong> recipient{count === 1 ? '' : 's'}
              {overCap && (
                <Badge tone="warning" dot>
                  Over cap — narrow your filter
                </Badge>
              )}
              {!overCap && count === 0 && (
                <Badge tone="warning" dot>
                  No one matches
                </Badge>
              )}
            </div>
            {overCap && (
              <p className={styles.capNote}>
                The audience is too large to send. Narrow the bedroom size and/or housing
                authority.
              </p>
            )}
            {preview.sample.length > 0 && (
              <ul className={styles.sample} aria-label="Audience sample">
                {preview.sample.slice(0, 8).map((c) => (
                  <li key={c.contactId} className={styles.sampleRow}>
                    {c.firstName !== undefined && c.firstName.length > 0
                      ? c.firstName
                      : formatPhone(c.phone)}
                  </li>
                ))}
                {preview.sample.length > 8 && (
                  <li className={styles.sampleMore}>+{preview.sample.length - 8} more</li>
                )}
              </ul>
            )}
          </div>
        ) : null}

        <div className={styles.actions}>
          <Button variant="secondary" onClick={handlePreview} loading={previewing}>
            Preview audience
          </Button>
          <Button onClick={handleSend} disabled={!canSend} loading={sending}>
            Send broadcast
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
