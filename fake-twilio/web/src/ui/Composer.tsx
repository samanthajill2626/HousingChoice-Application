// Composer — the bottom bar of a phone panel. A labelled textarea (Enter sends,
// Shift+Enter newlines — the dashboard composer idiom), a Send button, a picker
// of the canned MMS assets (each a toggle button that adds/removes its URL from
// the outgoing mediaUrls), and a segmented delivery-profile control rendered as a
// native radiogroup (Normal / Stall at sent / Fail) that drives the next
// outbound message's status callbacks. Pure presentational: onSend gets the body
// + chosen media; onSetDeliveryProfile fires whenever the profile changes.
import { useId, useState } from 'react';
import { Button } from './Button.js';
import { cannedAssets } from '../assets/canned/index.js';
import type { DeliveryProfile } from '../api/types.js';
import styles from './Composer.module.css';

export interface ComposerSendInput {
  body: string;
  mediaUrls: string[];
}

export interface ComposerProps {
  onSend: (input: ComposerSendInput) => void;
  onSetDeliveryProfile: (profile: DeliveryProfile) => void;
  disabled?: boolean;
}

type ProfileKey = 'normal' | 'stall' | 'fail';

const PROFILES: ReadonlyArray<{ key: ProfileKey; label: string; profile: DeliveryProfile }> = [
  { key: 'normal', label: 'Normal', profile: { kind: 'normal' } },
  { key: 'stall', label: 'Stall at sent', profile: { kind: 'stall', stallAt: 'sent' } },
  { key: 'fail', label: 'Fail', profile: { kind: 'fail' } },
];

export function Composer({ onSend, onSetDeliveryProfile, disabled = false }: ComposerProps): React.JSX.Element {
  const [body, setBody] = useState('');
  const [media, setMedia] = useState<string[]>([]);
  const [profile, setProfile] = useState<ProfileKey>('normal');
  const groupName = useId();

  const canSend = !disabled && (body.trim() !== '' || media.length > 0);

  const send = (): void => {
    if (!canSend) return;
    onSend({ body: body.trim(), mediaUrls: media });
    setBody('');
    setMedia([]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const toggleMedia = (url: string): void => {
    setMedia((prev) => (prev.includes(url) ? prev.filter((u) => u !== url) : [...prev, url]));
  };

  const selectProfile = (key: ProfileKey): void => {
    setProfile(key);
    const found = PROFILES.find((p) => p.key === key);
    if (found) onSetDeliveryProfile(found.profile);
  };

  return (
    <div className={styles.composer}>
      <div
        className={styles.profile}
        role="radiogroup"
        aria-label="Delivery profile"
      >
        {PROFILES.map((p) => {
          const checked = p.key === profile;
          return (
            <label key={p.key} className={`${styles.segment} ${checked ? styles.segmentChecked : ''}`}>
              <input
                type="radio"
                name={groupName}
                className={styles.segmentInput}
                value={p.key}
                checked={checked}
                onChange={() => selectProfile(p.key)}
              />
              {p.label}
            </label>
          );
        })}
      </div>

      <div className={styles.assets} aria-label="Attach a canned image" role="group">
        {cannedAssets.map((a) => {
          const picked = media.includes(a.url);
          return (
            <button
              key={a.id}
              type="button"
              className={`${styles.asset} ${picked ? styles.assetPicked : ''}`}
              aria-pressed={picked}
              onClick={() => toggleMedia(a.url)}
            >
              <img className={styles.assetThumb} src={a.url} alt="" aria-hidden="true" />
              {a.label}
            </button>
          );
        })}
      </div>

      <div className={styles.inputRow}>
        <textarea
          className={styles.textarea}
          aria-label="Message"
          rows={2}
          value={body}
          placeholder="Type a message…"
          disabled={disabled}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <Button variant="primary" onClick={send} disabled={!canSend}>
          Send
        </Button>
      </div>
    </div>
  );
}
