// NarrowLayout — the centered, readable max-width column used by the non-hub
// screens (Admin Users, Settings, Quick reply, Not found). The conversation hub
// goes full-bleed; these forms read better constrained to --hc-content-max. It
// simply wraps the nested <Outlet/> in the scoped narrow container (the narrow
// max-width was moved OFF AppLayout's shared content area so the hub can use the
// full page width).
import { Outlet } from 'react-router-dom';
import styles from './AppLayout.module.css';

export function NarrowLayout(): React.JSX.Element {
  return (
    <div className={styles.narrow}>
      <Outlet />
    </div>
  );
}
