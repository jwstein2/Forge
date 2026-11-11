import type * as C from './contracts';
import {
  mapAccount,
  mapActivity,
  mapAlert,
  mapBuildBoard,
  mapFinancials,
  mapIntegration,
  mapJob,
  mapNiche,
  mapOpportunityBoard,
  mapScoutRun,
  mapSeries,
} from './apiMap';
import { mapContent, mapLifecycle, mapScheduler, type RawScheduler, mapPolicy, mapRecommendation, mapSchedule, mapSummary, rollupChecks, type RawCheck, type RawContent, type RawLifecycle, type RawPolicy, type RawRecommendation, type RawSchedule, type RawSummary } from './operatorMap';
import type { BriefRef, CommandDataSource, Job, Niche, NicheId, OperatorBoard, PortfolioSummary, PublishingProposal } from './types';

/** Shown when a request never got an answer: offline, or (behind Cloudflare Access) a sign-in that expired and redirected. */
export const UNREACHABLE =
  'Could not reach the FORGE API. If this page has been open a while, your Cloudflare Access sign-in may have expired: reload the page to sign in again.';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiSourceOptions {
  /** Development only: value for the x-forge-dev-token header. Staging/production use Cloudflare Access cookies. */
  devToken?: string;
  fetcher?: typeof fetch;
}

/**
 * Platform API source (services/api, base /api/v1, envelope { ok, data, meta }).
 * Assembles the view models the screens need from the contract endpoints (CONTRACTS.md §5–6).
 */
export function createApiSource(base: string, opts: ApiSourceOptions = {}): CommandDataSource {
  const fetcher = opts.fetcher ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.devToken) headers['x-forge-dev-token'] = opts.devToken;
  let jobCache: Job[] = [];

  async function call<T>(path: string, init?: RequestInit): Promise<{ data: T; meta: C.ResponseMeta | null }> {
    let res: Response;
    try {
      res = await fetcher(`${base}${path}`, { credentials: 'include', redirect: 'manual', ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    } catch {
      throw new ApiError(0, 'unreachable', UNREACHABLE);
    }
    // Access answers an expired session with a redirect to its login page; with redirect:'manual' that is an opaque response.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new ApiError(401, 'unauthorized', UNREACHABLE);
    let body: C.ApiResponse<T> | null = null;
    try {
      body = (await res.json()) as C.ApiResponse<T>;
    } catch {
      /* non-JSON error page */
    }
    if (!body && (res.status === 401 || res.status === 403)) throw new ApiError(res.status, 'unauthorized', UNREACHABLE);
    if (!res.ok || !body || body.ok === false) {
      const err = body && body.ok === false ? body.error : { code: 'internal', message: `HTTP ${res.status}` };
      throw new ApiError(res.status, err.code, err.message);
    }
    return { data: body.data, meta: body.meta ?? null };
  }
  const get = async <T,>(path: string) => (await call<T>(path)).data;

  async function latestBriefVersion(id: string): Promise<string | null> {
    try {
      const briefs = await get<C.MarketBriefEnvelope[]>(`/briefs?niche=${encodeURIComponent(id)}`);
      const live = briefs.filter((b) => b.status !== 'superseded').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return live[0] ? `${live[0].version}${live[0].status === 'draft' ? ' (draft)' : ''}` : null;
    } catch {
      return null;
    }
  }

  async function allBriefs(): Promise<BriefRef[] | undefined> {
    try {
      const briefs = await get<C.MarketBriefEnvelope[]>('/briefs');
      return briefs.map((b) => ({ id: b.id, nicheId: b.nicheId, version: b.version, status: b.status, createdAt: b.createdAt, approvedBy: b.approvedBy }));
    } catch {
      return undefined;
    }
  }

  /** Latest Scout run; undefined when the endpoint isn't there or fails (the board still renders). */
  async function scoutRun() {
    try {
      return mapScoutRun(await get<Parameters<typeof mapScoutRun>[0]>('/intelligence/runs'));
    } catch {
      return undefined;
    }
  }

  async function series(metric: 'revenue' | 'page_views', nicheId: string) {
    try {
      return mapSeries(await get<C.TrendSeries>(`/series?metric=${metric}&niche=${encodeURIComponent(nicheId)}&period=last7`));
    } catch {
      return null;
    }
  }

  async function niche(id: string): Promise<Niche | null> {
    try {
      const [detail, brief] = await Promise.all([get<C.NicheDetail>(`/niches/${encodeURIComponent(id)}`), latestBriefVersion(id)]);
      return mapNiche(detail, brief);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  }

  return {
    kind: 'api',
    async getPortfolio(): Promise<PortfolioSummary> {
      const { data: summary, meta } = await call<C.PortfolioSummary>('/portfolio?period=mtd');
      const ids = summary.niches.map((n) => n.id);
      const [niches, registry, alerts, integrations, revenue] = await Promise.all([
        Promise.all(ids.map((id) => niche(id))),
        get<C.RegistryEntry[]>('/jobs'),
        get<C.Alert[]>('/alerts'),
        get<C.Integration[]>('/integrations'),
        series('revenue', 'portfolio'),
      ]);
      jobCache = registry.map(mapJob);
      return {
        generatedAt: meta?.generatedAt ?? new Date().toISOString(),
        period: summary.period,
        financials: mapFinancials(summary.financials),
        niches: niches.filter((n): n is Niche => n !== null),
        // Revenue trend from GET /series (API 1.1.0). If the endpoint fails, the chart is omitted, never guessed.
        trends: revenue ? [{ ...revenue, id: 'revenue' }] : [],
        activity: summary.recentActivity.map(mapActivity),
        alerts: alerts.map(mapAlert),
        jobs: jobCache,
        integrations: integrations.map((i) => mapIntegration(i, ids)),
        budget: summary.budget,
      };
    },
    getNiche: (id: NicheId) => niche(id),
    async getOpportunities() {
      const [board, briefs, run] = await Promise.all([get<C.OpportunityBoard>('/opportunities'), allBriefs(), scoutRun()]);
      return { ...mapOpportunityBoard(board), briefs, run };
    },
    async getOperator(): Promise<OperatorBoard> {
      // Each part degrades on its own: a failed call becomes an empty list plus a note, never invented rows.
      const failed: string[] = [];
      const soft = async <T,>(label: string, path: string, empty: T): Promise<{ v: T; at: string | null }> => {
        try {
          const r = await call<T>(path);
          return { v: r.data, at: r.meta?.generatedAt ?? null };
        } catch {
          failed.push(label);
          return { v: empty, at: null };
        }
      };
      const [control, summary, schedules, checks, content, policies] = await Promise.all([
        soft<C.SystemControl | null>('emergency-stop state', '/control', null),
        soft<RawSummary | null>('weekly summary', '/operator/summaries/latest', null),
        soft<RawSchedule[]>('schedules', '/operator/schedules', []),
        soft<RawCheck[]>('site checks', '/operator/checks?limit=500', []),
        soft<RawContent[]>('content pipeline', '/operator/content', []),
        soft<RawPolicy[]>('channel policies', '/operator/policies', []),
      ]);
      // Phase 2 endpoints: a 404 means this API version doesn't have them yet, which is not a failure to report.
      const optional = async <T,>(label: string, path: string): Promise<T | null> => {
        try {
          return (await call<T>(path)).data;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) failed.push(label);
          return null;
        }
      };
      const [proposal, recos, lifecycle, sched] = await Promise.all([
        optional<PublishingProposal>('publishing proposal', '/operator/policies/proposal'),
        optional<RawRecommendation[]>('recommendations', '/operator/recommendations?status=proposed'),
        optional<RawLifecycle>('email lifecycle', '/operator/lifecycle'),
        optional<RawScheduler>('scheduler state', '/system/scheduler'),
      ]);
      if (failed.length >= 6 && !proposal && !recos && !lifecycle) throw new ApiError(0, 'unreachable', 'The Operator endpoints did not answer.');
      return {
        state: 'ready',
        note: failed.length ? `Could not load: ${failed.join(', ')}. Those parts are left empty rather than guessed.` : '',
        asOf: control.at ?? schedules.at ?? null,
        control: control.v,
        summary: mapSummary(summary.v),
        schedules: schedules.v.map(mapSchedule),
        checks: rollupChecks(checks.v),
        content: content.v.map(mapContent),
        policies: policies.v.map(mapPolicy),
        proposal,
        recommendations: recos ? recos.map(mapRecommendation) : null,
        lifecycle: lifecycle ? mapLifecycle(lifecycle) : null,
        scheduler: sched ? mapScheduler(sched) : null,
      };
    },
    async applyPublishingProposal(version: string) {
      try {
        const r = await call<{ approvalId: string; windowEnd: string }>('/operator/policies/proposal/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ version, sourceRef: 'command:operations' }),
        });
        return { approvalId: r.data.approvalId, windowEnd: r.data.windowEnd };
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) throw new ApiError(409, 'conflict', 'The proposal changed since this page loaded. It has been reloaded; review it and apply again.');
        if (e instanceof ApiError && e.status === 403) throw new ApiError(403, 'forbidden', 'Only the owner can apply the publishing proposal.');
        throw e;
      }
    },
    async decideRecommendations(ids: string[], status: 'accepted' | 'dismissed' | 'done') {
      const r = await call<{ updated: number }>('/operator/recommendations/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids, status }),
      });
      return r.data.updated;
    },
    async getBuilds() {
      const { data, meta } = await call<C.BuildBoard>('/builds');
      return mapBuildBoard(data, meta?.generatedAt ?? null);
    },
    async getAccounts() {
      return (await get<C.Account[]>('/accounts')).map(mapAccount);
    },
    async setJobPaused(id: string, paused: boolean) {
      try {
        const r = await call<{ id: string; paused: boolean }>(`/jobs/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
        const prior = jobCache.find((j) => j.id === id);
        if (!prior) throw new ApiError(404, 'not_found', `Unknown job ${id}`);
        const updated = { ...prior, paused: r.data.paused };
        jobCache = jobCache.map((j) => (j.id === id ? updated : j));
        return updated;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          throw new Error(`${id} runs outside FORGE's control (for example in n8n), so it can't be paused from Command. Pause it in its own runner.`);
        }
        if (e instanceof ApiError && e.status === 423) throw new Error('FORGE is under an emergency stop; resume the system first.');
        throw e;
      }
    },
  };
}
