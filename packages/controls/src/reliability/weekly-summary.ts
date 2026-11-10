/**
 * Weekly operational summary (constitution §10: in-app Alerts + weekly summaries; no daily email,
 * no approval queues). Failure-first ordering. Composes content only; delivery is the caller's choice and
 * `shouldInterrupt()` is the only thing that may justify an out-of-cycle notification.
 */
import type { Alert } from "@forge/contracts";

export interface RunLite { registryId: string; name: string; status: "success" | "failed" | "running" | "timeout" | "skipped"; startedAt: string }
export interface JobHealth { registryId: string; name: string; heartbeat: string; lastSuccessAt: string | null }
export interface MoneyLine { nicheId: string; label: string; grossCents: number | null; refundsCents: number | null; contributionCents: number | null; state: string }

export interface WeeklySummary {
  period: { start: string; end: string };
  headline: string;
  needsOwner: Alert[];
  critical: Alert[];
  warnings: number;
  failedRuns: { name: string; count: number; lastAt: string }[];
  lateJobs: JobHealth[];
  unobservedJobs: JobHealth[];
  money: MoneyLine[];
  markdown: string;
}

const usd = (c: number | null) => (c == null ? "unknown" : `$${(c / 100).toFixed(2)}`);

export function composeWeekly(input: { now: Date; alerts: Alert[]; runs: RunLite[]; jobs: JobHealth[]; money: MoneyLine[] }): WeeklySummary {
  const end = input.now.toISOString();
  const start = new Date(input.now.getTime() - 7 * 864e5).toISOString();
  const open = input.alerts.filter((a) => a.state !== "resolved");
  const needsOwner = open.filter((a) => a.needsOwner);
  const critical = open.filter((a) => a.severity === "critical" && !a.needsOwner);
  const warnings = open.filter((a) => a.severity === "warning").length;
  const failed = new Map<string, { name: string; count: number; lastAt: string }>();
  for (const r of input.runs) {
    if (r.startedAt < start || r.startedAt >= end || (r.status !== "failed" && r.status !== "timeout")) continue;
    const x = failed.get(r.registryId) ?? { name: r.name, count: 0, lastAt: r.startedAt };
    x.count++;
    if (r.startedAt > x.lastAt) x.lastAt = r.startedAt;
    failed.set(r.registryId, x);
  }
  const failedRuns = [...failed.values()].sort((a, b) => b.count - a.count);
  const lateJobs = input.jobs.filter((j) => j.heartbeat === "late");
  const unobservedJobs = input.jobs.filter((j) => j.heartbeat === "never_observed");

  const problems = needsOwner.length + critical.length + failedRuns.length + lateJobs.length;
  const parts = [
    needsOwner.length ? `${needsOwner.length} decision(s) for you` : "",
    critical.length ? `${critical.length} critical alert(s)` : "",
    failedRuns.length ? `${failedRuns.length} job(s) failed` : "",
    lateJobs.length ? `${lateJobs.length} job(s) late` : "",
  ].filter(Boolean);
  const headline = problems === 0
    ? `Quiet week: no critical alerts, no failed runs${unobservedJobs.length ? `, but ${unobservedJobs.length} job(s) still report no heartbeat` : ""}.`
    : `${parts.join(", ")}.`;

  const md: string[] = ["# FORGE weekly summary", `${start.slice(0, 10)} to ${end.slice(0, 10)}`, "", `**${headline}**`, ""];
  if (needsOwner.length) md.push("## Needs your decision", ...needsOwner.map((a) => `- ${a.title}${a.nextAction ? ` (${a.nextAction})` : ""}`), "");
  if (critical.length) md.push("## Critical", ...critical.map((a) => `- ${a.title}`), "");
  if (failedRuns.length || lateJobs.length) {
    md.push("## Automation",
      ...failedRuns.map((f) => `- ${f.name}: ${f.count} failed run(s), last ${f.lastAt.slice(0, 16)}Z`),
      ...lateJobs.map((j) => `- ${j.name}: late (last success ${j.lastSuccessAt ?? "never"})`), "");
  }
  if (unobservedJobs.length) md.push("## Not yet observable", ...unobservedJobs.map((j) => `- ${j.name}: no heartbeat connected, so FORGE cannot confirm it runs`), "");
  md.push("## Money (verified ledger only)", "| Niche | Gross | Refunds | Contribution |", "|---|---|---|---|",
    ...input.money.map((m) => `| ${m.label} | ${usd(m.grossCents)} | ${usd(m.refundsCents)} | ${m.contributionCents == null ? `unknown (${m.state})` : usd(m.contributionCents)} |`), "");
  md.push(`${warnings} open warning(s) are in Command, Alerts.`);
  return { period: { start, end }, headline, needsOwner, critical, warnings, failedRuns, lateJobs, unobservedJobs, money: input.money, markdown: md.join("\n") };
}

/** Out-of-cycle interruption only for things that lose money or customers now. Everything else waits for the weekly summary. */
export function shouldInterrupt(alerts: Alert[], alreadyNotified: Set<string>): Alert[] {
  const urgent = /checkout|payment|ledger|delivery|webhook|signature|secret|outage|down/i;
  return alerts.filter((a) => a.state === "open" && a.severity === "critical" && urgent.test(`${a.source} ${a.title}`) && !alreadyNotified.has(a.id));
}
