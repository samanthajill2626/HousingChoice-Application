// ToursPage — the /tours list page. Two sections:
//
//   Upcoming  — tours in the next 30 days (from=start-of-today, to=+30d),
//               grouped by local date (soonest first; "Today" label for today).
//               Row: tenant name - property (unit address) - time - status - type.
//
//   Needs booking — time-less tours (status='requested'), oldest first.
//               Row: tenant name - property - status - type (no time column).
//
// Each row links to /tours/:tourId (the TourDetail page). Tenant names and unit
// labels are resolved from the full contacts + units lists (same cross-reference
// pattern used by PlacementsBoard / TenantFile). Staff-facing vocabulary: "property"
// for the unit (per GLOSSARY.md).
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  TOUR_STATUS_LABELS,
  TOUR_TYPE_LABELS,
  type Tour,
  type Contact,
  type UnitItem,
} from '../../api/index.js';
import { Spinner } from '../../ui/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { useTours } from './useTours.js';
import { useContacts } from '../contacts/useContacts.js';
import { useListings } from '../listings/useListings.js';
import styles from './ToursPage.module.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a tenant's display name from the contacts map. Falls back to the
 *  raw tenantId when the contact hasn't loaded yet. */
function tenantName(contacts: Map<string, Contact>, tenantId: string): string {
  const c = contacts.get(tenantId);
  if (!c) return tenantId;
  return contactDisplayName(c.firstName, c.lastName, c.phone);
}

/** Resolve a unit's property label from the units map. Falls back to the
 *  unitId when the unit hasn't loaded yet. Staff-facing word: "property". */
function propertyLabel(units: Map<string, UnitItem>, unitId: string): string {
  const u = units.get(unitId);
  if (!u) return unitId;
  return formatAddress(u.address) || unitId;
}

/** Format just the time part of a scheduledAt ISO string for display, e.g.
 *  "2:30 PM". Returns '' when absent or unparseable. */
function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** YYYY-MM-DD local key for grouping. Returns '' for undefined input. */
function localDateKey(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A human-readable date group header, e.g. "Today", "Thu Jul 3". */
function dateGroupLabel(dateKey: string, todayKey: string): string {
  if (dateKey === todayKey) return 'Today';
  const d = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** Today's YYYY-MM-DD key in local time. */
function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = (now.getMonth() + 1).toString().padStart(2, '0');
  const d = now.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

interface TourRowProps {
  tour: Tour;
  contacts: Map<string, Contact>;
  units: Map<string, UnitItem>;
  showTime: boolean;
}

function TourRow({ tour, contacts, units, showTime }: TourRowProps): React.JSX.Element {
  const tenant = tenantName(contacts, tour.tenantId);
  const property = propertyLabel(units, tour.unitId);
  const timeLabel = showTime ? formatTime(tour.scheduledAt) : undefined;
  const statusLabel = TOUR_STATUS_LABELS[tour.status] ?? tour.status;
  const typeLabel = TOUR_TYPE_LABELS[tour.tourType as keyof typeof TOUR_TYPE_LABELS] ?? tour.tourType;

  return (
    <li className={styles.rowItem}>
      <Link
        to={`/tours/${tour.tourId}`}
        className={styles.row}
        aria-label={`Tour for ${tenant} at ${property}`}
      >
        <span className={styles.tenant}>{tenant}</span>
        <span className={styles.property}>{property}</span>
        {timeLabel !== undefined ? <span className={styles.time}>{timeLabel}</span> : null}
        <span className={styles.badge}>{statusLabel}</span>
        <span className={styles.badge}>{typeLabel}</span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ToursPage(): React.JSX.Element {
  const { status: toursStatus, upcoming, needsBooking } = useTours();
  const { status: contactsStatus, contacts: contactsList } = useContacts('all');
  const { status: unitsStatus, units: unitsList } = useListings();

  const loading =
    toursStatus === 'loading' || contactsStatus === 'loading' || unitsStatus === 'loading';
  const error =
    toursStatus === 'error' || contactsStatus === 'error' || unitsStatus === 'error';

  // Build lookup maps for cross-referencing.
  const contactsMap = useMemo(() => {
    const m = new Map<string, Contact>();
    for (const c of contactsList) m.set(c.contactId, c);
    return m;
  }, [contactsList]);

  const unitsMap = useMemo(() => {
    const m = new Map<string, UnitItem>();
    for (const u of unitsList) m.set(u.unitId, u);
    return m;
  }, [unitsList]);

  // Group upcoming tours by local date key, preserving soonest-first order.
  const upcomingGroups = useMemo(() => {
    const today = todayKey();
    const groups: { dateKey: string; label: string; tours: Tour[] }[] = [];
    const byKey = new Map<string, Tour[]>();
    const keyOrder: string[] = [];
    for (const t of upcoming) {
      const key = localDateKey(t.scheduledAt);
      if (!byKey.has(key)) {
        byKey.set(key, []);
        keyOrder.push(key);
      }
      byKey.get(key)!.push(t);
    }
    for (const key of keyOrder) {
      groups.push({ dateKey: key, label: dateGroupLabel(key, today), tours: byKey.get(key)! });
    }
    return groups;
  }, [upcoming]);

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Tours</h1>
      </div>
      <p className={styles.sub}>
        Upcoming scheduled tours and unbooked tour requests.
      </p>

      {loading ? <Spinner center /> : null}

      {!loading && error ? (
        <p className={styles.error} role="alert">
          We couldn&apos;t load tours. Please try again.
        </p>
      ) : null}

      {!loading && !error ? (
        <>
          {/* --- Upcoming section --- */}
          <section className={styles.section} aria-label="Upcoming tours">
            <h2 className={styles.sectionTitle}>Upcoming</h2>
            {upcomingGroups.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>No tours scheduled in the next 30 days.</p>
              </div>
            ) : (
              upcomingGroups.map((g) => (
                <div key={g.dateKey} className={styles.dateGroup}>
                  <p className={styles.dateLabel}>{g.label}</p>
                  <ul className={styles.rows} aria-label={`Tours on ${g.label}`}>
                    {g.tours.map((t) => (
                      <TourRow
                        key={t.tourId}
                        tour={t}
                        contacts={contactsMap}
                        units={unitsMap}
                        showTime={true}
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>

          {/* --- Needs booking section --- */}
          <section className={styles.section} aria-label="Needs booking">
            <h2 className={styles.sectionTitle}>Needs booking</h2>
            {needsBooking.length === 0 ? (
              <div className={styles.empty}>
                <p className={styles.emptyText}>No unbooked tour requests.</p>
              </div>
            ) : (
              <ul className={styles.rows} aria-label="Unbooked tour requests">
                {needsBooking.map((t) => (
                  <TourRow
                    key={t.tourId}
                    tour={t}
                    contacts={contactsMap}
                    units={unitsMap}
                    showTime={false}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
