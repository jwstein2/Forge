/**
 * SAMPLE design data for screens whose real source does not exist yet
 * (Opportunity Scout has never run; no business build has been commissioned).
 *
 * This is NOT research. Every Metric is state 'sample' and every claim is labelled
 * 'inferred' or 'unknown'. The UI shows these only behind a persistent SAMPLE banner
 * when the owner opts in with ?preview=sample. The default view shows the honest empty state.
 */
import type { Build, BuildStage, Metric, Opportunity } from './types';

const P = { start: '2027-01-01', end: '2027-12-31', label: 'Modelled year 1' };
const s = (value: number, note?: string): Metric => ({
  value,
  unit: 'usd',
  state: 'sample',
  period: P,
  asOf: null,
  source: 'Sample data — not research',
  note,
});

const comps = (a: number, b: number, c: number, d: number, e: number) => [
  { label: 'Demand evidence', value: a, weight: 0.25 },
  { label: 'Willingness to pay', value: b, weight: 0.2 },
  { label: 'Competitive gap', value: c, weight: 0.2 },
  { label: 'FORGE reuse', value: d, weight: 0.2 },
  { label: 'Launch effort (inverse)', value: e, weight: 0.15 },
];
const total = (c: ReturnType<typeof comps>) => Math.round(c.reduce((t, x) => t + x.value * x.weight, 0));

function opp(o: Omit<Opportunity, 'score'> & { components: ReturnType<typeof comps> }): Opportunity {
  const { components, ...rest } = o;
  return { ...rest, score: { total: total(components), components } };
}

export const sampleOpportunities: Opportunity[] = [
  opp({
    id: 'sample-garden',
    rank: 1,
    name: 'Vegetable garden planners',
    recommended: true,
    segment: 'First- and second-year home vegetable gardeners',
    problem: 'Knowing what to plant when, and how much space each crop needs, for their frost dates.',
    hunch: 'The quilting calculator pattern (exact, local, printable) transfers almost unchanged to planting calendars, and the buying window opens in late winter, which leaves time to build.',
    components: comps(72, 58, 64, 88, 80),
    confidence: 'low',
    demand: [
      { claim: 'Search interest in planting calendars rises each spring', label: 'inferred' },
      { claim: 'Monthly keyword volume', label: 'unknown' },
    ],
    competitors: [
      { name: 'Extension-service calendars', scope: 'local', offer: 'Free PDF calendars', price: 'Free' },
      { name: 'Planner shops on marketplaces', scope: 'national', offer: 'Printable planners', price: 'Unknown' },
    ],
    demographics: [{ claim: 'Audience skews toward homeowners with yard space', label: 'inferred' }],
    productModel: 'Free frost-date calculator + paid printable planner and spreadsheet',
    offer: { price: 'Sample: $9–$15', monetization: 'One-time digital download; seed-company affiliate later if eligible' },
    seasonality: { months: [40, 70, 100, 90, 60, 30, 20, 15, 20, 15, 10, 25], peak: 'March', launchBy: 'January', source: 'Sample curve — not Google Trends' },
    distribution: ['Pinterest', 'Search (SEO)', 'Email'],
    economics: { downside: s(150), base: s(900), upside: s(2400), launchCost: s(11, 'Domain only'), assumptions: ['Sample figures for layout only'] },
    risks: ['Strong free alternatives', 'Regional accuracy is hard'],
    gaps: ['No keyword volumes collected', 'No competitor pricing collected'],
    reuse: ['Calculator shell', 'Checkout button', 'Pinterest drip', 'Legal templates'],
    complexity: 'low',
    verdict: 'go',
    verdictReason: 'Sample verdict: highest reuse and a clear seasonal window.',
  }),
  opp({
    id: 'sample-woodwork',
    rank: 2,
    name: 'Woodworking cut-list tools',
    recommended: false,
    segment: 'Hobby woodworkers building furniture from plans',
    problem: 'Turning a plan into a cut list that wastes as little lumber as possible.',
    hunch: 'Shares buyers and tooling with Bidline; could reuse its estimating engine.',
    components: comps(60, 62, 50, 76, 60),
    confidence: 'low',
    demand: [{ claim: 'Cut-list search demand', label: 'unknown' }],
    competitors: [{ name: 'Desktop cut-optimiser apps', scope: 'national', offer: 'Software', price: 'Unknown' }],
    demographics: [{ claim: 'Overlaps with contractor audience', label: 'inferred' }],
    productModel: 'Free cut-list calculator + paid spreadsheet',
    offer: { price: 'Sample: $12–$19', monetization: 'One-time download; tool affiliate if eligible' },
    seasonality: { months: [70, 65, 60, 50, 40, 35, 35, 40, 50, 60, 80, 100], peak: 'December', launchBy: 'September', source: 'Sample curve — not Google Trends' },
    distribution: ['YouTube', 'Search (SEO)', 'Pinterest'],
    economics: { downside: s(100), base: s(600), upside: s(1800), launchCost: s(11), assumptions: ['Sample figures for layout only'] },
    risks: ['Software competitors are free', 'Optimisation logic needs QA'],
    gaps: ['No demand data'],
    reuse: ['Bidline estimating logic', 'Checkout button'],
    complexity: 'medium',
    verdict: 'hold',
    verdictReason: 'Sample verdict: wait for Bidline demand evidence first.',
  }),
  opp({
    id: 'sample-wedding',
    rank: 3,
    name: 'DIY wedding budget planners',
    recommended: false,
    segment: 'Couples planning a small, self-organised wedding',
    problem: 'Keeping a budget and vendor plan in one place.',
    hunch: 'High willingness to pay, but crowded and needs a strong brand.',
    components: comps(55, 74, 30, 52, 55),
    confidence: 'low',
    demand: [{ claim: 'Demand', label: 'unknown' }],
    competitors: [{ name: 'Marketplace template sellers', scope: 'national', offer: 'Templates', price: 'Unknown' }],
    demographics: [{ claim: 'Audience age band', label: 'unknown' }],
    productModel: 'Paid spreadsheet + printable checklist',
    offer: { price: 'Sample: $15–$25', monetization: 'One-time download' },
    seasonality: { months: [100, 90, 70, 55, 45, 40, 40, 45, 50, 60, 75, 85], peak: 'January', launchBy: 'October', source: 'Sample curve — not Google Trends' },
    distribution: ['Pinterest', 'Instagram'],
    economics: { downside: s(50), base: s(500), upside: s(2000), launchCost: s(11), assumptions: ['Sample figures for layout only'] },
    risks: ['Saturated market', 'Brand-heavy'],
    gaps: ['No competitor scan'],
    reuse: ['Spreadsheet builder', 'Checkout button'],
    complexity: 'medium',
    verdict: 'no_go',
    verdictReason: 'Sample verdict: weakest competitive gap.',
  }),
];

const stage = (
  id: BuildStage['id'],
  label: string,
  status: BuildStage['status'],
  dependsOn: BuildStage['id'][],
  cost: number,
  gate: BuildStage['gate']['result'],
  outputs: BuildStage['outputs'] = [],
  blocker?: string,
): BuildStage => ({
  id,
  label,
  status,
  dependsOn,
  outputs,
  cost: s(cost),
  gate: { result: gate, reviewer: gate === 'NOT RUN' ? null : 'Independent QA (sample)' },
  blocker,
});

export const sampleBuild: Build = {
  id: 'sample-build-garden',
  nicheName: 'Vegetable garden planners',
  state: 'sample',
  commissionedAt: '2026-12-01T00:00:00Z',
  budget: s(150, 'Sample operating budget'),
  spent: s(38),
  blueprintVersion: '0.3.0',
  stages: [
    stage('research', 'Research', 'passed', [], 6, 'PASS', [{ label: 'Audience & Market Brief v1.0', status: 'tested' }]),
    stage('blueprint', 'Blueprint', 'passed', ['research'], 4, 'PASS', [{ label: 'Launch Blueprint v0.3', status: 'tested' }]),
    stage('products', 'Products', 'in_progress', ['blueprint'], 12, 'NOT RUN', [{ label: 'Planner spreadsheet', status: 'built' }]),
    stage('brand', 'Brand', 'review', ['blueprint'], 8, 'NOT RUN', [{ label: 'Brand system', status: 'built' }]),
    stage('website', 'Website', 'not_started', ['brand', 'products'], 0, 'NOT RUN'),
    stage('integrations', 'Integrations', 'blocked', ['website'], 0, 'BLOCKED', [], 'Needs owner approval for a new Lemon Squeezy store.'),
    stage('marketing', 'Marketing', 'not_started', ['website'], 0, 'NOT RUN'),
    stage('testing', 'Testing', 'not_started', ['integrations', 'marketing'], 0, 'NOT RUN'),
    stage('launch_readiness', 'Launch readiness', 'not_started', ['testing'], 0, 'NOT RUN'),
  ],
};
