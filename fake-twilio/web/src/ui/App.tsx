// App — the fake-phones UI shell. A thin composition over the live data hook
// (`useFakePhones`) and the presentational components: the persistent DevBanner
// on top, then a two-pane body (RosterRail on the left at --hc-hub-list-width,
// a PhonePanel on the right) that mirrors the dashboard hub layout. All state
// lives in the hook (initial load + SSE merge) — the App holds NO duplicated
// conversation state; the only local UI state is "is the ad-hoc dialog open?".
//
// Wiring (always for the SELECTED party):
//   - Composer.onSend            → sendAsParty({ from: selected.number, body, mediaUrls })
//   - Composer.onSetDeliveryProfile → setDeliveryOutcome(selected.number, profile)
//   - RosterRail ＋ Ad-hoc        → AdHocDialog → addAdHoc(input)
import { useEffect, useRef, useState } from 'react';
import { useFakePhones } from '../state/useFakePhones.js';
import { AdHocDialog } from './AdHocDialog.js';
import { Composer, type ComposerSendInput } from './Composer.js';
import { DevBanner } from './DevBanner.js';
import { MessageBubble } from './MessageBubble.js';
import { RosterRail } from './RosterRail.js';
import type { AddAdHocInput, DeliveryProfile, Persona, Thread } from '../api/types.js';
import styles from './App.module.css';

/** The right pane: a header for the selected party, a scrollable conversation
 *  log of MessageBubbles, and the Composer. Empty-state when nothing selected. */
function PhonePanel({
  persona,
  thread,
  onSend,
  onSetDeliveryProfile,
  deliveryResetSignal,
  sendError,
}: {
  persona: Persona | undefined;
  thread: Thread | undefined;
  onSend: (input: ComposerSendInput) => void | Promise<void>;
  onSetDeliveryProfile: (profile: DeliveryProfile) => void;
  deliveryResetSignal: number;
  sendError?: string;
}): React.JSX.Element {
  if (!persona) {
    return (
      <section className={styles.panel} aria-label="Conversation">
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No persona selected</p>
          <p className={styles.emptyHint}>Select a persona from the left to view its conversation.</p>
        </div>
      </section>
    );
  }

  const messages = thread?.messages ?? [];

  return (
    <section className={styles.panel} aria-label="Conversation">
      <header className={styles.panelHeader}>
        <span className={styles.panelLabel}>{persona.label}</span>
        <span className={styles.panelNumber}>{persona.number}</span>
      </header>

      <div className={styles.log} role="log" aria-label="Conversation" aria-live="polite">
        {messages.length === 0 ? (
          <p className={styles.threadEmpty}>No messages yet — send the first one below.</p>
        ) : (
          messages.map((m) => <MessageBubble key={m.sid} message={m} />)
        )}
      </div>

      {sendError !== undefined && sendError !== '' && (
        <p role="alert" className={styles.sendError}>
          {sendError}
        </p>
      )}

      <Composer
        onSend={onSend}
        onSetDeliveryProfile={onSetDeliveryProfile}
        resetSignal={deliveryResetSignal}
      />
    </section>
  );
}

export function App(): React.JSX.Element {
  const phones = useFakePhones();
  const [adHocOpen, setAdHocOpen] = useState(false);
  const [adHocError, setAdHocError] = useState<string | undefined>(undefined);
  const [sendError, setSendError] = useState<string | undefined>(undefined);

  const selectedPersona = phones.personas.find((p) => p.number === phones.selected);
  const selectedThread = phones.threads.find((t) => t.partyNumber === phones.selected);

  // The Composer's delivery-profile radio is one-shot in the engine: a non-normal
  // profile is consumed on the next app→party OUTBOUND, then the engine reverts to
  // normal. Bump this signal so the radio follows suit — when that outbound lands
  // (the selected thread gains an outbound), and when the selected party changes.
  const [deliveryResetSignal, setDeliveryResetSignal] = useState(0);
  const selectedOutboundCount =
    selectedThread?.messages.filter((m) => m.direction === 'outbound').length ?? 0;
  const prevOutboundCountRef = useRef(selectedOutboundCount);
  useEffect(() => {
    if (selectedOutboundCount > prevOutboundCountRef.current) {
      setDeliveryResetSignal((n) => n + 1);
    }
    prevOutboundCountRef.current = selectedOutboundCount;
  }, [selectedOutboundCount]);

  const handleSend = async (input: ComposerSendInput): Promise<void> => {
    if (!selectedPersona) return;
    setSendError(undefined);
    try {
      await phones.sendAsParty({
        from: selectedPersona.number,
        body: input.body,
        ...(input.mediaUrls.length > 0 && { mediaUrls: input.mediaUrls }),
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send the message.');
      // Re-throw so the Composer keeps the composed message + picked images.
      throw err;
    }
  };

  const handleSetDeliveryProfile = (profile: DeliveryProfile): void => {
    if (!selectedPersona) return;
    void phones.setDeliveryOutcome(selectedPersona.number, profile);
  };

  const handleAddAdHoc = (input: AddAdHocInput): void => {
    setAdHocError(undefined);
    void (async () => {
      try {
        const persona = await phones.addAdHoc(input);
        setAdHocOpen(false);
        phones.select(persona.number);
      } catch (err) {
        setAdHocError(err instanceof Error ? err.message : 'Could not add the number.');
      }
    })();
  };

  return (
    <div className={styles.app}>
      <DevBanner />
      <main className={styles.body}>
        <RosterRail
          personas={phones.personas}
          unreadByNumber={phones.unreadByNumber}
          selected={phones.selected}
          onSelect={(number) => {
            // A stale send error belongs to the party it happened on.
            setSendError(undefined);
            // The armed delivery profile is per-party + one-shot; don't carry one
            // party's selection over to the next. Reset the radio on every switch.
            setDeliveryResetSignal((n) => n + 1);
            phones.select(number);
          }}
          onAddAdHoc={() => {
            setAdHocError(undefined);
            setAdHocOpen(true);
          }}
        />
        <PhonePanel
          persona={selectedPersona}
          thread={selectedThread}
          onSend={handleSend}
          onSetDeliveryProfile={handleSetDeliveryProfile}
          deliveryResetSignal={deliveryResetSignal}
          {...(sendError !== undefined && { sendError })}
        />
      </main>

      {adHocOpen && (
        <AdHocDialog
          onSubmit={handleAddAdHoc}
          onClose={() => setAdHocOpen(false)}
          {...(adHocError !== undefined && { error: adHocError })}
        />
      )}
    </div>
  );
}
