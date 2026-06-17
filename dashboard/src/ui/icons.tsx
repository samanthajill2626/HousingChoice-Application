// Small monochrome icons — inline SVG, 24x24 viewBox, stroke = currentColor so
// they inherit the surrounding text color. Decorative: each is aria-hidden, so
// the nav link / button text carries the accessible name (don't rely on an icon
// for a control's label). Sized via the `size` prop (default 18).

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
      <path d="M3 9.5h18M8 3v3M16 3v3M8.5 14l2.2 2.2L15.5 12" />
    </Svg>
  );
}

/** Cases — kanban columns. */
export function CasesIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </Svg>
  );
}

/** Contacts — two people. */
export function ContactsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.8 5.6a3 3 0 0 1 0 6.8M17.5 19a5.6 5.6 0 0 0-2.3-4.4" />
    </Svg>
  );
}

/** Listings — a building. */
export function ListingsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 20V6l8-3 8 3v14" />
      <path d="M9.5 20v-5h5v5M9 8h.5M14.5 8h.5M9 11.5h.5M14.5 11.5h.5" />
    </Svg>
  );
}

/** Inbox — a tray. */
export function InboxIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M3 13l2.4-7.2A2 2 0 0 1 7.3 4.5h9.4a2 2 0 0 1 1.9 1.3L21 13v4.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M3 13h5l1.5 2.5h5L21 13" />
    </Svg>
  );
}

/** Broadcasts — a megaphone. */
export function BroadcastsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <path d="M4 10v4a1 1 0 0 0 1 1h2.2l8.8 4V5L7.2 9H5a1 1 0 0 0-1 1z" />
      <path d="M17.5 8.5a4 4 0 0 1 0 7M7.5 15v3.5" />
    </Svg>
  );
}

/** Settings — a gear. */
export function SettingsIcon({ size }: IconProps): React.JSX.Element {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.4 5.6l-1.9 1.9M7.5 16.5l-1.9 1.9M18.4 18.4l-1.9-1.9M7.5 7.5 5.6 5.6" />
    </Svg>
  );
}

/** Nav-icon registry — keyed by the `icon` id on a nav item (see app/nav.ts). */
export const NAV_ICONS: Record<string, (p: IconProps) => React.JSX.Element> = {
  today: TodayIcon,
  cases: CasesIcon,
  contacts: ContactsIcon,
  listings: ListingsIcon,
  inbox: InboxIcon,
  broadcasts: BroadcastsIcon,
  settings: SettingsIcon,
};
