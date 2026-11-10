import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useSource } from '../data/DataContext';
import { Icon, type IconName } from './Icon';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Portfolio', icon: 'overview', end: true },
  { to: '/niches', label: 'Executed niches', icon: 'niches' },
  { to: '/opportunities', label: 'Opportunities', icon: 'compass' },
  { to: '/builder', label: 'Builder', icon: 'layers' },
  { to: '/operations', label: 'Operations & alerts', icon: 'bell' },
  { to: '/accounts', label: 'Accounts', icon: 'key' },
];

type Theme = 'system' | 'light' | 'dark';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('forge-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function AppShell({ children, openAlerts }: { children: ReactNode; openAlerts?: number }) {
  const source = useSource();
  const loc = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => setMenuOpen(false), [loc.pathname]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('forge-theme', theme);
    } catch {
      /* storage unavailable: theme still applies for this session */
    }
  }, [theme]);

  const nextTheme: Theme = theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system';

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          className="icon-btn topbar__menu"
          aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={menuOpen}
          aria-controls="primary-nav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name={menuOpen ? 'close' : 'menu'} size={20} />
        </button>
        <Brand />
      </header>
      <aside className={`rail${menuOpen ? ' is-open' : ''}`}>
        <div className="rail__brand">
          <Brand />
        </div>
        <nav id="primary-nav" aria-label="Primary">
          <ul className="nav">
            {NAV.map((n) => (
              <li key={n.to}>
                <NavLink to={n.to + loc.search} end={n.end} className={({ isActive }) => `nav__link${isActive ? ' is-active' : ''}`}>
                  <Icon name={n.icon} size={18} />
                  <span>{n.label}</span>
                  {n.to === '/operations' && openAlerts ? (
                    <span className="nav__count" aria-label={`${openAlerts} open alerts`}>
                      {openAlerts}
                    </span>
                  ) : null}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="rail__foot">
          <div className="source-pill" data-source={source.kind}>
            <span className="source-pill__dot" aria-hidden="true" />
            <div>
              <span className="source-pill__label">Data source</span>
              <span className="source-pill__value">{source.kind === 'api' ? 'Platform API' : 'Audit snapshot · Nov 10'}</span>
            </div>
          </div>
          <button className="theme-btn" onClick={() => setTheme(nextTheme)} aria-label={`Theme: ${theme}. Switch to ${nextTheme}.`}>
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} size={16} />
            <span>{theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
      <main id="main" className="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}

function Brand() {
  return (
    <Link className="brand" to="/" aria-label="FORGE Command, portfolio">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--night)" />
        <path d="M8 22.5 16 9l8 13.5" fill="none" stroke="var(--brass)" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M11.5 22.5h9" stroke="#fbfaf6" strokeOpacity=".5" strokeWidth="1.6" />
      </svg>
      <span className="brand__word">
        FORGE <span>Command</span>
      </span>
    </Link>
  );
}
