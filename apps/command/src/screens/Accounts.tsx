import { useResource } from '../data/DataContext';
import type { Account } from '../data/types';
import { Icon } from '../components/Icon';
import { safeHref } from '../lib/safeUrl';
import { ErrorNote, ExternalLink, Loading, PageHeader, Section } from '../components/primitives';

const STATUS: Record<Account['status'], { label: string; tone: string }> = {
  active: { label: 'Active', tone: 'good' },
  test_mode: { label: 'Test mode', tone: 'info' },
  pending: { label: 'Pending', tone: 'warn' },
  not_created: { label: 'Not created', tone: 'outline' },
  unknown: { label: 'Unknown', tone: 'outline' },
};
const AUTH: Record<Account['authMethod'], string> = { oauth: 'OAuth', password: 'Password', api_token: 'API token', unknown: 'Unknown' };
const SCOPE: Record<string, string> = { portfolio: 'Portfolio', bidline: 'Bidline', 'quilt-plan-kit': 'Quilt Plan Kit', 'loaf-ledger': 'Loaf Ledger' };

export function AccountsScreen() {
  const [res] = useResource((s) => s.getAccounts(), []);
  if (res.status === 'loading') return <Loading />;
  if (res.status === 'error') return <ErrorNote error={res.error} />;
  return <AccountsView accounts={res.data} />;
}

/**
 * Account directory. Identifiers, status, links and password-manager references only.
 * This component has no field, prop or state that could hold a password.
 */
export function AccountsView({ accounts }: { accounts: Account[] }) {
  const linked = accounts.filter((a) => safeHref(a.passwordManagerRef, { vault: true })).length;
  const shared = accounts.filter((a) => a.sharedWith);
  return (
    <div className="page">
      <PageHeader
        kicker="Account directory"
        title={`${accounts.length} accounts. ${linked === 0 ? 'None is linked to 1Password yet.' : `${linked} linked to 1Password.`}`}
        lede="Passwords never live in FORGE. Each account links to its entry in your password manager, where you reveal or rotate it."
      />
      <div className="vault-note" role="note">
        <Icon name="lock" size={18} />
        <div>
          <p>
            <strong>Password manager: 1Password.</strong> Each row links to its 1Password item once the item exists there; rows say
            "Not linked" until then. FORGE stores only the item link, never the password. Automation tokens stay in Cloudflare and GitHub
            encrypted secrets and are never shown here.
          </p>
        </div>
      </div>
      {shared.length > 0 && (
        <p className="blast">
          <Icon name="alert-triangle" size={14} /> {shared.length} accounts are shared with other businesses ({[...new Set(shared.map((a) => a.sharedWith))].join('; ')}). A
          problem there can affect FORGE.
        </p>
      )}
      <Section title="Accounts" kicker="Identifiers, status and links" id="accounts">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Accounts table, scrollable">
          <table className="table accounts">
            <caption className="sr-only">Accounts</caption>
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Account</th>
                <th scope="col">Used by</th>
                <th scope="col">Status</th>
                <th scope="col">Sign-in</th>
                <th scope="col">1Password</th>
                <th scope="col">
                  <span className="sr-only">Console</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const st = STATUS[a.status];
                return (
                  <tr key={a.id}>
                    <th scope="row">
                      <span className="acc__service">{a.service}</span>
                      {a.note && <span className="acc__note">{a.note}</span>}
                    </th>
                    <td className="wrap">
                      <span className="mono small">{a.identifier}</span>
                      {a.sharedWith && <span className="acc__shared">Shared with {a.sharedWith}</span>}
                    </td>
                    <td className="wrap">{a.nicheIds.map((n) => SCOPE[n] ?? n).join(', ')}</td>
                    <td>
                      <span className={`tag tag--${st.tone}`}>{st.label}</span>
                    </td>
                    <td>{AUTH[a.authMethod]}</td>
                    <td>
                      {safeHref(a.passwordManagerRef, { vault: true }) ? (
                        <a className="vault-link" href={safeHref(a.passwordManagerRef, { vault: true })!}>
                          <Icon name="key" size={14} /> Open in 1Password
                        </a>
                      ) : (
                        <span className="muted small">Not linked</span>
                      )}
                    </td>
                    <td>{a.consoleUrl ? <ExternalLink href={a.consoleUrl}>Console</ExternalLink> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}
