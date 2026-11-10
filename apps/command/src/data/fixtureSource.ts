import { accounts, jobs, niches, portfolio } from './fixtures';
import { sampleBuild, sampleOpportunities } from './samples';
import type { CommandDataSource, Job } from './types';

/** In-memory source backed by audit fixtures. Pausing is local to the session only. */
export function createFixtureSource(): CommandDataSource {
  const jobState = new Map<string, Job>(jobs.map((j) => [j.id, { ...j }]));
  const clone = <T,>(v: T): T => structuredClone(v);
  return {
    kind: 'fixtures',
    async getPortfolio() {
      return clone({ ...portfolio, jobs: [...jobState.values()] });
    },
    async getNiche(id) {
      return clone(niches.find((n) => n.id === id) ?? null);
    },
    async getOpportunities(opts) {
      if (opts?.sample) {
        return {
          state: 'sample',
          runAt: null,
          scoutVersion: null,
          note: 'Sample data for design review. The Opportunity Scout has not run.',
          opportunities: clone(sampleOpportunities),
        };
      }
      return {
        state: 'not_run',
        runAt: null,
        scoutVersion: null,
        note: 'The Opportunity Scout has not run yet. Its first output will appear here with sources and confidence.',
        opportunities: [],
      };
    },
    async getBuilds(opts) {
      if (opts?.sample) {
        return { state: 'sample', note: 'Sample build for design review. No build has been commissioned.', builds: [clone(sampleBuild)] };
      }
      return { state: 'none', note: 'No business build has been commissioned yet.', builds: [] };
    },
    async getAccounts() {
      return clone(accounts);
    },
    async setJobPaused(id, paused) {
      const job = jobState.get(id);
      if (!job) throw new Error(`Unknown job ${id}`);
      if (!job.pausable) throw new Error(`${id} cannot be paused from Command`);
      job.paused = paused;
      return clone(job);
    },
  };
}
