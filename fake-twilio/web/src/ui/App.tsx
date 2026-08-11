// App — the fake-phones UI shell. A thin composition over the live data hook
// (`useFakePhones`) and the presentational components: the persistent DevBanner
// on top, then a two-pane body (RosterRail on the left at --hc-hub-list-width,
// a PhonePanel OR GroupPanel on the right) that mirrors the dashboard hub
// layout. All state lives in the hook (initial load + SSE merge) — the App
// holds NO duplicated conversation state; the only local UI state is "is the
// ad-hoc dialog open?".
//
// Wiring (always for the SELECTED party / group):
//   - Composer.onSend            → sendAsParty({ from: selected.number, body, mediaUrls })
//   - GroupPanel.onSend          → sendAsParty({ from: <picked member>, to: <pool>, … })
//   - Composer.onSetDeliveryProfile → setDeliveryOutcome(<party or picked member>, profile)
//   - RosterRail ＋ Ad-hoc        → AdHocDialog → addAdHoc(input)
import { useEffect, useRef, useState } from 'react';
import { useFakePhones } from '../state/useFakePhones.js';
import { AdHocDialog } from './AdHocDialog.js';
import { Composer, type ComposerSendInput } from './Composer.js';
import { DevBanner } from './DevBanner.js';
import { GroupPanel } from './GroupPanel.js';
import { MessageBubble } from './MessageBubble.js';
import { RosterRail } from './RosterRail.js';
import { isDirectMessage } from '../api/types.js';
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
  otherPersonas,
  carrierGroupWith,
  onToggleCarrierGroupMember,
}: {
  persona: Persona | undefined;
  thread: Thread | undefined;
  onSend: (input: ComposerSendInput) => void | Promise<void>;
  onSetDeliveryProfile: (profile: DeliveryProfile) => void;
  deliveryResetSignal: number;
  sendError?: string;
  otherPersonas: Persona[];
  carrierGroupWith: string[];
  onToggleCarrierGroupMember: (number: string) => void;
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

      {/* NATIVE CARRIER group texting. Named "Carrier group" everywhere and
          NEVER "Group text": the rail on the left already has a section
          literally called "Group texts" meaning RELAY groups, and the dashboard
          chip for THIS product is "Group text" - three labels for two products
          would make every spec selector ambiguous.

          Picking one or more recipients turns the next send from a 1:1 into a
          carrier group text: it still goes to the business number, but it
          carries the undocumented OtherRecipients envelope, which is the ONLY
          thing that distinguishes the two on the wire. */}
      <fieldset className={styles.carrierGroup}>
        <legend className={styles.carrierGroupLegend}>Carrier group recipients</legend>
        <p className={styles.carrierGroupHint}>
          {carrierGroupWith.length === 0
            ? 'None picked - the next send is an ordinary one-to-one text.'
            : `The next send is a carrier group text with ${carrierGroupWith.length} other handset${
                carrierGroupWith.length === 1 ? '' : 's'
              }.`}
        </p>
        {otherPersonas.length === 0 ? (
          <p className={styles.carrierGroupHint}>No other handsets to group with.</p>
        ) : (
          <ul className={styles.carrierGroupList}>
            {otherPersonas.map((other) => (
              <li key={other.number}>
                <label className={styles.carrierGroupItem}>
                  <input
                    type="checkbox"
                    checked={carrierGroupWith.includes(other.number)}
                    onChange={() => onToggleCarrierGroupMember(other.number)}
                  />
                  <span>
                    {other.label} {other.number}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>

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
  const rawSelectedThread = phones.threads.find((t) => t.partyNumber === phones.selected);
  // The 1:1 pane shows BUSINESS traffic only (one side = the app number) —
  // relay-group traffic renders exclusively in the GroupPanel. Filtering at
  // DISPLAY time keeps the hook's raw threads faithful to /control/threads
  // (which the e2e scenario steps assert pool legs into).
  const selectedThread: Thread | undefined = rawSelectedThread
    ? { ...rawSelectedThread, messages: rawSelectedThread.messages.filter(isDirectMessage) }
    : undefined;
  // Group selection is mutually exclusive with persona selection (the hook
  // nulls one when the other is set). A stale pool (e.g. after reset cleared
  // the groups) simply finds nothing and the empty PhonePanel state shows.
  const selectedGroup = phones.groups.find((g) => g.poolNumber === phones.selectedGroup);

  // The Composer's delivery-profile radio is one-shot in the engine: a non-normal
  // profile is consumed on the next app→party OUTBOUND, then the engine reverts to
  // normal. Bump this signal so the radio follows suit — when that outbound lands
  // (the selected thread gains an outbound), and when the selected party changes.
  // Counted on the FILTERED thread: profiles arm app→party 1:1 sends; group
  // fan-out legs consuming a profile isn't a flow the fake models.
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

  // NATIVE CARRIER group seam: the other handsets the next send is addressed to.
  // Cleared on every party switch (below) - a carrier group is a property of the
  // message being composed, not a standing setting.
  const [carrierGroupWith, setCarrierGroupWith] = useState<string[]>([]);
  const otherPersonas = phones.personas.filter((p) => p.number !== phones.selected);

  const handleSend = async (input: ComposerSendInput): Promise<void> => {
    if (!selectedPersona) return;
    setSendError(undefined);
    try {
      if (carrierGroupWith.length > 0) {
        // A carrier group text: still addressed to the business number, but
        // carrying the OtherRecipients envelope that makes it a group.
        await phones.sendGroupAsParty({
          from: selectedPersona.number,
          otherRecipients: carrierGroupWith,
          body: input.body,
          ...(input.mediaUrls.length > 0 && { mediaUrls: input.mediaUrls }),
        });
        return;
      }
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

  // Group reply-as-member: the GroupPanel picks the member; the pool is the
  // selected group's. This is the interactive path that triggers the app's
  // REAL relay fan-out (the app sees member→pool exactly as from a phone).
  const handleGroupSend = async (input: {
    from: string;
    body: string;
    mediaUrls: string[];
  }): Promise<void> => {
    if (!selectedGroup) return;
    setSendError(undefined);
    try {
      await phones.sendAsParty({
        from: input.from,
        to: selectedGroup.poolNumber,
        body: input.body,
        ...(input.mediaUrls.length > 0 && { mediaUrls: input.mediaUrls }),
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send the message.');
      // Re-throw so the Composer keeps the composed message + picked images.
      throw err;
    }
  };

  const handleGroupSetDeliveryProfile = (memberNumber: string, profile: DeliveryProfile): void => {
    void phones.setDeliveryOutcome(memberNumber, profile);
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
            // The carrier-group picker belongs to the message being composed on
            // the party we are leaving; carrying it over would silently address
            // the next send to a group nobody chose.
            setCarrierGroupWith([]);
            phones.select(number);
          }}
          onAddAdHoc={() => {
            setAdHocError(undefined);
            setAdHocOpen(true);
          }}
          groups={phones.groups}
          groupUnreadByPool={phones.groupUnreadByPool}
          selectedGroup={phones.selectedGroup}
          onSelectGroup={(poolNumber) => {
            // Same hygiene as a persona switch: the error belonged elsewhere.
            setSendError(undefined);
            phones.selectGroup(poolNumber);
          }}
        />
        {selectedGroup ? (
          // Keyed by pool so switching groups remounts the panel (fresh picked
          // member + composer state), exactly like switching phones feels.
          <GroupPanel
            key={selectedGroup.poolNumber}
            group={selectedGroup}
            onSend={handleGroupSend}
            onSetDeliveryProfile={handleGroupSetDeliveryProfile}
            {...(sendError !== undefined && { sendError })}
          />
        ) : (
          <PhonePanel
            persona={selectedPersona}
            thread={selectedThread}
            onSend={handleSend}
            onSetDeliveryProfile={handleSetDeliveryProfile}
            deliveryResetSignal={deliveryResetSignal}
            otherPersonas={otherPersonas}
            carrierGroupWith={carrierGroupWith}
            onToggleCarrierGroupMember={(number) =>
              setCarrierGroupWith((prev) =>
                prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number],
              )
            }
            {...(sendError !== undefined && { sendError })}
          />
        )}
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
