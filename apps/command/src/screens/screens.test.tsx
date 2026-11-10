import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TestApp } from '../App';
import { createFixtureSource } from '../data/fixtureSource';

const renderAt = (path: string) => render(<TestApp source={createFixtureSource()} path={path} />);

describe('Portfolio', () => {
  it('leads with an outcome sentence built from data', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: /None has taken a live payment yet/ })).toBeInTheDocument();
    expect(screen.getByText(/1 of 9 marketing channels verified/)).toBeInTheDocument();
  });

  it('shows period and freshness on headline metrics', async () => {
    renderAt('/');
    const rev = await screen.findByTestId('stat-Verified revenue');
    expect(within(rev).getByText('Verified')).toBeInTheDocument();
    expect(within(rev).getByText('Nov 1–10, 2026')).toBeInTheDocument();
    expect(within(rev).getByText(/as of/)).toBeInTheDocument();
  });

  it('marks contribution incomplete instead of inventing a number', async () => {
    renderAt('/');
    expect((await screen.findAllByTestId('contribution-value'))[0]).toHaveTextContent('Incomplete');
    expect(screen.getByText('Not yet established')).toBeInTheDocument();
  });

  it('lists all three businesses with health', async () => {
    renderAt('/');
    for (const n of ['Quilt Plan Kit', 'Bidline', 'Loaf Ledger']) expect((await screen.findAllByRole('link', { name: n })).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
  });
});

describe('Niche drill-down', () => {
  it('shows the failed Bidline kit and the price mismatch', async () => {
    renderAt('/niches/bidline');
    expect(await screen.findByRole('heading', { level: 1, name: /Bidline/ })).toBeInTheDocument();
    expect(screen.getByText(/byte-identical to the free template/)).toBeInTheDocument();
    expect(screen.getByText('$19.00')).toBeInTheDocument();
    expect(screen.getByText('$19.99')).toBeInTheDocument();
  });

  it('handles an unknown niche', async () => {
    renderAt('/niches/nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'No business with that name' })).toBeInTheDocument();
  });
});

describe('Opportunities', () => {
  it('shows an honest empty state when the Scout has not run', async () => {
    renderAt('/opportunities');
    expect(await screen.findByRole('heading', { level: 1, name: /has not run yet/ })).toBeInTheDocument();
    expect(screen.queryByText('Vegetable garden planners')).not.toBeInTheDocument();
  });

  it('labels sample data with a banner and disables commissioning', async () => {
    renderAt('/opportunities?preview=sample');
    expect(await screen.findByRole('note', { name: 'Sample data' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Commission a Launch Blueprint/ })).toBeDisabled();
    expect(screen.getAllByText('Recommended')).toHaveLength(1);
  });

  it('switches the selected opportunity', async () => {
    renderAt('/opportunities?preview=sample');
    await userEvent.click(await screen.findByRole('button', { name: /Woodworking cut-list tools/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'Woodworking cut-list tools' })).toBeInTheDocument();
  });
});

describe('Builder', () => {
  it('says no build is under way by default', async () => {
    renderAt('/builder');
    expect(await screen.findByRole('heading', { level: 1, name: /No business build is under way/ })).toBeInTheDocument();
  });
  it('renders nine milestones in sample mode', async () => {
    renderAt('/builder?preview=sample');
    const track = await screen.findByRole('list', { name: 'Build milestones' });
    expect(within(track).getAllByRole('listitem').filter((li) => li.classList.contains('track__step'))).toHaveLength(9);
  });
});

describe('Operations', () => {
  it('pauses and resumes an approved job, saying it is simulated in snapshot mode', async () => {
    renderAt('/operations');
    const btn = await screen.findByRole('button', { name: /Pause N8N-04/ });
    await userEvent.click(btn);
    expect(await screen.findByText(/N8N-04 paused\. Snapshot mode: this is simulated/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Resume N8N-04/ }));
    expect(await screen.findByText(/N8N-04 resumed/)).toBeInTheDocument();
  });

  it('does not offer pause for non-approved automation', async () => {
    renderAt('/operations');
    await screen.findByRole('button', { name: /Pause N8N-02/ });
    expect(screen.queryByRole('button', { name: /Pause CF-02/ })).not.toBeInTheDocument();
  });

  it('filters alerts by severity', async () => {
    renderAt('/operations');
    await userEvent.selectOptions(await screen.findByLabelText('Severity'), 'critical');
    expect(screen.getByText('1 shown')).toBeInTheDocument();
  });

  it('shows an in-app weekly summary and no approval queue', async () => {
    renderAt('/operations');
    expect(await screen.findByRole('heading', { name: 'Weekly summary' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });
});

describe('Accounts', () => {
  it('never renders a password field or reveal control', async () => {
    const { container } = renderAt('/accounts');
    await screen.findByRole('heading', { level: 1, name: /accounts/ });
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /reveal|show password/i })).not.toBeInTheDocument();
    expect(screen.getAllByText('Not linked').length).toBe(10);
  });
});

describe('Opportunities with real Scout output shape', () => {
  it('renders the Intelligence fixture through the API mapper without inventing sections', async () => {
    const { mapOpportunityBoard } = await import('../data/apiMap');
    const run = (await import('../data/__fixtures__/opportunity-run.fixture.json')).default;
    const { OpportunitiesView } = await import('./Opportunities');
    const { MemoryRouter } = await import('react-router-dom');
    const board = mapOpportunityBoard({
      state: 'ready', runAt: '2026-11-10T03:00:00Z', scoringModelVersion: '1.0.0', note: 'fixture',
      opportunities: run.opportunities.map((o) => ({
        id: o.opportunity_id, opportunityKey: o.opportunity_key, title: o.title, score: o.adjusted_score, rank: o.rank,
        recommended: o.recommended, scoringModelVersion: '1.0.0', briefRef: null, runId: o.run_id, status: 'candidate' as const, content: o,
      })),
    });
    render(<MemoryRouter><OpportunitiesView board={board} /></MemoryRouter>);
    expect(screen.getByRole('heading', { level: 1, name: /Strongest recommendation: FIXTURE: fixture-niche-a/ })).toBeInTheDocument();
    expect(screen.getByText('No seasonal data in this run.')).toBeInTheDocument();
    expect(screen.getAllByText('Not covered in this run.').length).toBeGreaterThan(0);
  });
});

describe('QA-001 regressions', () => {
  it('D3: Loaf Ledger page views are not connected, not 0 verified', async () => {
    renderAt('/niches/loaf-ledger');
    const pv = await screen.findByTestId('stat-Page views');
    expect(within(pv).getByText('Not connected')).toBeInTheDocument();
    expect(within(pv).queryByText('0')).not.toBeInTheDocument();
  });
  it('D4: Operations headline does not claim jobs ran on time without a heartbeat', async () => {
    renderAt('/operations');
    const h1 = await screen.findByRole('heading', { level: 1 });
    expect(h1).not.toHaveTextContent(/on time|on schedule/);
    expect(h1).toHaveTextContent(/nothing yet checks that they are still running/);
  });
  it('D5: Quilt Plan Kit search is configured, not running', async () => {
    renderAt('/niches/quilt-plan-kit');
    const card = (await screen.findByText('Search (SEO)', { selector: '.channel__name' })).closest('li')!;
    expect(within(card).getByText('Configured')).toBeInTheDocument();
  });
  it('D7: an unsafe vault or console link is not rendered as a link', async () => {
    const { AccountsView } = await import('./Accounts');
    const { accounts } = await import('../data/fixtures');
    const bad = accounts.map((a, i) => (i === 0 ? { ...a, passwordManagerRef: 'javascript:alert(1)', consoleUrl: 'javascript:alert(2)' } : a));
    const { container } = render(<AccountsView accounts={bad} />);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });
  it('D9: unknown routes have an h1', async () => {
    renderAt('/nowhere');
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('Accounts with 1Password links', () => {
  it('links a row to its 1Password item and shows nothing secret', async () => {
    const { AccountsView } = await import('./Accounts');
    const { accounts } = await import('../data/fixtures');
    const linked = accounts.map((a, i) => (i === 0 ? { ...a, passwordManagerRef: 'https://start.1password.com/open/i?a=ACC&v=VAULT&i=ITEM' } : a));
    render(<AccountsView accounts={linked} />);
    expect(screen.getByRole('heading', { level: 1, name: /1 linked to 1Password/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open in 1Password/ })).toHaveAttribute('href', 'https://start.1password.com/open/i?a=ACC&v=VAULT&i=ITEM');
  });
});

describe('Operations with Operator and controls data (M6)', () => {
  const board = {
    state: 'ready' as const,
    note: '',
    asOf: '2026-11-10T04:10:00Z',
    control: { globalPause: false, pausedAt: null, pausedBy: null, reason: null },
    summary: { id: 's1', period: { start: '2026-11-02T00:00:00Z', end: '2026-11-09T00:00:00Z', label: 'Week of 2026-11-02' }, generatedAt: '2026-11-10T04:00:14Z', headline: ['Revenue: $0.00 gross from 0 live order(s).'], unknowns: ['Lemon Squeezy (unconnected)'] },
    schedules: [{ id: 'OPS-SITE-HEALTH', kind: 'ops.site_health', nicheId: null, cadence: 'Every hour', enabled: true, lastSlot: '2026-11-10T04:00Z', lastJobStatus: 'succeeded', lastJobUpdatedAt: null }],
    checks: [{ kind: 'site_health', nicheId: 'bidline', targets: 3, passing: 1, unknown: 2, lastCheckedAt: '2026-11-10T03:46:00Z', findings: [{ code: 'checker_error', severity: 'info' as const, message: 'Site state UNKNOWN', target: 'x' }] }],
    content: [],
    policies: [{ channelId: 'ch_qpk_pinterest', nicheId: 'quilt-plan-kit', platform: 'pinterest', channelStatus: 'verified', mode: 'draft_only', publisher: 'dry_run', dailyCap: 0, windowEnd: null, approvalId: null }],
    proposal: null,
    recommendations: null,
    lifecycle: null,
  };
  const source = () => {
    const base = createFixtureSource();
    return {
      ...base,
      getOperator: async () => board,
      async getPortfolio() {
        const p = await base.getPortfolio();
        p.alerts.push({ id: 'ctl1', severity: 'critical', nicheId: 'bidline', title: 'Site price $19.00 ≠ checkout $19.99', detail: '', source: 'controls:FIN-PR-01', firstSeen: p.generatedAt, lastSeen: p.generatedAt, state: 'open', nextAction: 'Set the checkout price.', needsOwner: true });
        return p;
      },
    };
  };

  it('uses the Operator weekly summary, lists schedules, unknown checks and dry-run boundaries', async () => {
    render(<TestApp source={source()} path="/operations" />);
    expect(await screen.findByText('Revenue: $0.00 gross from 0 live order(s).')).toBeInTheDocument();
    expect(screen.getByText(/generated .* by the Operator/)).toBeInTheDocument();
    expect(screen.getByText('Emergency stop is off. FORGE jobs run on their schedules.')).toBeInTheDocument();
    expect(screen.getByText('OPS-SITE-HEALTH')).toBeInTheDocument();
    expect(screen.getByText('2 unknown')).toBeInTheDocument();
    expect(screen.getByText('Dry run (posts nothing)')).toBeInTheDocument();
    expect(screen.getByText(/Nothing planned or drafted yet/)).toBeInTheDocument();
  });

  it('shows controls findings with their code and labels alert sources', async () => {
    render(<TestApp source={source()} path="/operations" />);
    const region = await screen.findByRole('region', { name: 'Controls findings table, scrollable' });
    expect(within(region).getByText('FIN-PR-01')).toBeInTheDocument();
    expect(screen.getAllByText('Controls · FIN-PR-01').length).toBeGreaterThan(0);
    await userEvent.selectOptions(screen.getByLabelText('Raised by'), 'controls');
    expect(screen.getByText('1 shown')).toBeInTheDocument();
  });

  it('says plainly when the snapshot has no Operator data', async () => {
    renderAt('/operations');
    expect(await screen.findByText('Operator data is not connected in this view')).toBeInTheDocument();
    expect(screen.getByText(/derived in Command from current records/)).toBeInTheDocument();
  });
});

describe('opsHeadline with heartbeat data', () => {
  it('does not call jobs without a heartbeat "on schedule"', async () => {
    const { opsHeadline } = await import('./Operations');
    const job = (id: string, heartbeatOk: boolean | null) => ({ id, heartbeatOk, lastResult: 'success' }) as unknown as import('../data/types').Job;
    const h = opsHeadline([job('a', true), job('b', null), job('c', false)], 0, true);
    expect(h).toBe("No scheduled job reported a failure. 1 on schedule, 1 running late, 1 with no heartbeat yet, so FORGE can't confirm they run.");
    expect(opsHeadline([job('a', true)], 0, true)).toBe('No scheduled job reported a failure. The rest are on schedule.');
  });
});

describe('Operator decisions (phase 2)', () => {
  const proposal = {
    version: '2026-11-10.1', windowEnd: '2027-02-08T04:00:00Z', summary: 'One decision covers every channel below for 90 days.',
    channels: [
      { channelId: 'ch_qpk_pinterest', nicheId: 'quilt-plan-kit', platform: 'pinterest', mode: 'standing', publisher: 'dry_run', dailyCap: 1, why: 'Pins are low-risk.', liveConnectionNeeded: 'Pinterest API access.' },
      { channelId: 'ch_qpk_email', nicheId: 'quilt-plan-kit', platform: 'email', mode: 'approval_each', publisher: 'dry_run', dailyCap: 1, why: "Emails can't be taken back.", liveConnectionNeeded: 'MailerLite sending.' },
    ],
  };
  const board = (applied: boolean) => ({
    state: 'ready' as const, note: '', asOf: null, control: { globalPause: false, pausedAt: null, pausedBy: null, reason: null }, summary: null,
    schedules: [], checks: [], content: [],
    policies: proposal.channels.map((c) => ({ ...c, channelStatus: 'configured', windowEnd: null, approvalId: applied ? 'apr_1' : null, mode: applied ? c.mode : 'draft_only' })),
    proposal,
    recommendations: [{ id: 'r1', nicheId: 'bidline', rule: 'calc_no_checkout', title: 'Calculator use with no checkout clicks', detail: '41 uses, 0 clicks in 28 days.', action: 'Add a kit link under the result.', impact: 'high', evidenceLabel: 'VERIFIED', status: 'proposed', needsOwner: false, createdAt: null }],
    lifecycle: { snapshot: { state: 'unconnected', takenAt: null, note: null, groups: [], forms: [], automations: [] }, sequences: [{ id: 'LC-QPK-WELCOME', nicheId: 'quilt-plan-kit', kind: 'welcome', name: 'FORGE · Quilt Plan Kit · Welcome', status: 'draft', emails: 3, lint: [], mailerliteAutomationId: '2037' }] },
  });

  it('applies the whole proposal in one confirmed decision', async () => {
    let applied = false;
    const calls: string[] = [];
    const src = {
      ...createFixtureSource(),
      getOperator: async () => board(applied),
      applyPublishingProposal: async (v: string) => {
        calls.push(v);
        applied = true;
        return { approvalId: 'apr_1', windowEnd: proposal.windowEnd };
      },
    };
    render(<TestApp source={src} path="/operations" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Apply all 2 boundaries' }));
    expect(screen.getByText(/records one owner approval covering all 2 channels/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm: apply all' }));
    expect(await screen.findByText(/Applied\. One approval \(apr_1\)/)).toBeInTheDocument();
    expect(calls).toEqual(['2026-11-10.1']);
    expect(within(screen.getByTestId('publishing-proposal')).getByText('Applied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply all/ })).not.toBeInTheDocument();
  });

  it('decides recommendations as a batch and shows lifecycle numbers as unknown', async () => {
    const decided: [string[], string][] = [];
    const src = { ...createFixtureSource(), getOperator: async () => board(true), decideRecommendations: async (ids: string[], st: string) => (decided.push([ids, st]), ids.length) };
    render(<TestApp source={src} path="/operations" />);
    expect(await screen.findByText('Subscriber numbers are unknown')).toBeInTheDocument();
    expect(screen.getByText(/UNKNOWN, not zero/)).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept selected' });
    expect(accept).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select: Calculator use with no checkout clicks' }));
    await userEvent.click(accept);
    expect(decided).toEqual([[['r1'], 'accepted']]);
    expect(await screen.findByText(/1 proposal marked accepted/)).toBeInTheDocument();
  });
});

describe('QA-012 C1–C3', () => {
  const p = { version: 'v1', windowEnd: '2027-02-08T04:00:00Z', summary: 'S', channels: [{ channelId: 'a', nicheId: 'quilt-plan-kit', platform: 'pinterest', mode: 'standing', publisher: 'dry_run', dailyCap: 1, why: 'w', liveConnectionNeeded: 'l' }] };
  const mk = (windowEnd: string, lifecycleState = 'live') => ({
    state: 'ready' as const, note: '', asOf: null, control: null, summary: null, schedules: [], checks: [], content: [], recommendations: null,
    policies: [{ channelId: 'a', nicheId: 'quilt-plan-kit', platform: 'pinterest', channelStatus: 'verified', mode: 'standing', publisher: 'dry_run', dailyCap: 1, windowEnd, approvalId: 'apr_1' }],
    proposal: p,
    lifecycle: { snapshot: { state: lifecycleState, takenAt: '2026-11-10T09:00:00Z', note: null, groups: [{ id: 'g', name: 'QPK list', nicheId: 'quilt-plan-kit', active: 4, unconfirmed: 1 }], forms: [], automations: [] }, sequences: [] },
  });
  it('shows the applied window with its year, then Expired once it passes', async () => {
    const { unmount } = render(<TestApp source={{ ...createFixtureSource(), getOperator: async () => mk('2099-02-08T04:00:00Z') }} path="/operations" />);
    expect(await screen.findByText('Applied until Feb 8, 2099')).toBeInTheDocument();
    unmount();
    render(<TestApp source={{ ...createFixtureSource(), getOperator: async () => mk('2020-02-08T04:00:00Z') }} path="/operations" />);
    expect(await screen.findByText('Expired Feb 8, 2020')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply all 1 boundary' })).toBeInTheDocument();
  });
  it('shows when MailerLite was read', async () => {
    render(<TestApp source={{ ...createFixtureSource(), getOperator: async () => mk('2099-02-08T04:00:00Z') }} path="/operations" />);
    expect(await screen.findByText(/^read Nov 10/)).toBeInTheDocument();
  });
});
