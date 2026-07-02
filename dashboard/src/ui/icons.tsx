// Small monochrome icons — inline SVG, 24x24 viewBox, stroke = currentColor so
// they inherit the surrounding text color. Decorative: each is aria-hidden, so
// the nav link / button text carries the accessible name (don't rely on an icon
// for a control's label). Sized via the `size` prop (default 18). Geometry is
// crisp at 16–20px (round caps/joins, consistent stroke).

function Svg({ children, size = 18 }: { children: React.ReactNode; size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

type IconProps = { size?: number };

/** Today — calendar with a check. */
export function TodayIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M8 3v3M16 3v3" />
      <path d="M8.5 14.5l2 2 4-4" />
    </Svg>
  );
}

/** Placements — a board with columns (kanban). */
export function PlacementsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <rect x="6.8" y="8" width="3.4" height="8.4" rx="0.7" />
      <rect x="13.8" y="8" width="3.4" height="5" rx="0.7" />
    </Svg>
  );
}

/** Contacts — two people. */
export function ContactsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M3.5 19v-1a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v1" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17 19v-1a4 4 0 0 0-2.6-3.75" />
    </Svg>
  );
}

/** Tours — a house with a clock (viewing appointment). */
export function ToursIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 10.5L12 4l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9.5z" />
      <circle cx="12" cy="14" r="3.5" />
      <path d="M12 12.5v1.5l1 1" />
    </Svg>
  );
}

/** Properties — a building. */
export function ListingsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 21V8l8-4 8 4v13" />
      <path d="M3 21h18" />
      <path d="M9.5 21v-4.5h5V21" />
      <path d="M8.5 9.5h.01M15.5 9.5h.01M8.5 12.8h.01M15.5 12.8h.01" />
    </Svg>
  );
}

/** Inbox — a tray. */
export function InboxIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M22 12.5h-5.5l-2 3h-5l-2-3H2" />
      <path d="M5.6 5.2 2 12.5V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.5L18.4 5.2A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.8 1.2z" />
    </Svg>
  );
}

/** Broadcasts — a megaphone. */
export function BroadcastsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 10v3a1 1 0 0 0 1 1h2l9 4.5V5.5L7 10H5a1 1 0 0 0-1 1z" />
      <path d="M18 8.8a4 4 0 0 1 0 6.4" />
      <path d="M7 14v3.6a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V15.5" />
    </Svg>
  );
}

/** Settings — sliders (reads cleanly at small sizes). */
export function SettingsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M5 21v-6M5 11V3M12 21v-9M12 8V3M19 21v-5M19 12V3" />
      <path d="M3 15h4M10 8h4M17 16h4" />
    </Svg>
  );
}

/** Menu (hamburger) — opens the mobile nav drawer. */
export function MenuIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3.5 6h17M3.5 12h17M3.5 18h17" />
    </Svg>
  );
}

/** Chevron — points left (« collapse) or right (» expand) via the `dir` prop;
 *  used by the desktop sidebar's rail toggle. */
export function ChevronIcon({
  size,
  dir = 'left',
}: IconProps & { dir?: 'left' | 'right' }): React.JSX.Element {
  return (
    <Svg size={size}>
      {dir === 'left' ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </Svg>
  );
}

/** Close (X) — dismisses the mobile nav drawer. */
export function CloseIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

/** Nav-icon registry — keyed by the `icon` id on a nav item (see app/nav.ts). */
export const NAV_ICONS: Record<string, (p: IconProps) => React.JSX.Element> = {
  today: TodayIcon,
  placements: PlacementsIcon,
  tours: ToursIcon,
  contacts: ContactsIcon,
  listings: ListingsIcon,
  inbox: InboxIcon,
  broadcasts: BroadcastsIcon,
  settings: SettingsIcon,
};
