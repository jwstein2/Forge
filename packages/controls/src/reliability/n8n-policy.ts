/**
 * Static policy checks over n8n workflow definitions (read-only; gates G11, G12, G14).
 *
 *  N8N-P1 (G14) scheduled workflow, more often than weekly, reaches an email node with no IF/Filter/Switch gate → "always sends".
 *  N8N-P2 (G14) gated alert email on a sub-daily schedule with no throttle → a persistent outage emails many times a day.
 *  N8N-P3 (G12) webhook trigger with no auth and no signature check before side effects.
 *  N8N-P4 (G12) HMAC computed over re-serialised JSON instead of the raw request body (fragile; can reject valid or mask altered bodies).
 *  N8N-P5 (G12) one secret used both as an HMAC key and as a bearer token sent in a header (key reuse), and/or secrets kept in a data table rather than n8n credentials.
 *  N8N-P6 (G11) scheduled workflow sends no heartbeat to FORGE, so a silent stop is invisible.
 */
import type { Finding } from "../findings.ts";

export interface N8nNode { name: string; type: string; parameters?: Record<string, any>; disabled?: boolean }
export interface N8nWorkflow { id: string; name: string; active?: boolean; nodes: N8nNode[]; connections: Record<string, { main?: ({ node: string }[] | null)[] }> }

const EMAIL_TYPES = /\.(gmail|emailSend|microsoftOutlook|sendGrid|mailjet|mailgun|awsSes|sendInBlue|brevo)$/i;
const GATE_TYPES = /\.(if|filter|switch)$/i;
const SCHEDULE_TYPES = /\.(scheduleTrigger|cron|interval)$/i;
const WEBHOOK_TYPES = /\.(webhook|formTrigger)$/i;

/** Minutes between runs for a schedule node (smallest interval when several rules exist); null if unknown. */
export function scheduleMinutes(n: N8nNode): number | null {
  const p = n.parameters ?? {};
  const rules: any[] = p.rule?.interval ?? [];
  if (!rules.length && p.cronExpression) return cronMinutes(String(p.cronExpression));
  let best: number | null = null;
  for (const r of rules) {
    let m: number | null;
    switch (r.field ?? "days") {
      case "seconds": m = (r.secondsInterval ?? 30) / 60; break;
      case "minutes": m = r.minutesInterval ?? 5; break;
      case "hours": m = 60 * (r.hoursInterval ?? 1); break;
      case "days": m = 1440 * (r.daysInterval ?? 1); break;
      case "weeks": m = 10080 * (r.weeksInterval ?? 1); break;
      case "months": m = 43200 * (r.monthsInterval ?? 1); break;
      case "cronExpression": m = cronMinutes(String(r.expression ?? "")); break;
      default: m = null;
    }
    if (m != null && (best == null || m < best)) best = m;
  }
  return best;
}
function cronMinutes(expr: string): number | null {
  const f = expr.trim().split(/\s+/); if (f.length < 5) return null;
  const [min, hr, dom, , dow] = f.length === 6 ? f.slice(1) : f;
  if (min?.startsWith("*/")) return Number(min.slice(2));
  if (min === "*") return 1;
  if (hr?.startsWith("*/")) return 60 * Number(hr.slice(2));
  if (hr === "*") return 60;
  if (dow && dow !== "*" && dom === "*") return 10080 / Math.max(1, dow.split(",").length);
  if (dom && dom !== "*") return 43200;
  return 1440;
}

function successors(wf: N8nWorkflow, name: string): string[] {
  return (wf.connections[name]?.main ?? []).flatMap((out) => (out ?? []).map((c) => c.node));
}
/** All email nodes reachable from `start`, and whether every path to each passes a gate. */
function reachEmail(wf: N8nWorkflow, start: string): { email: string; gated: boolean }[] {
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const res = new Map<string, boolean>(); // email -> gated on ALL paths
  const walk = (name: string, gated: boolean, seen: Set<string>) => {
    if (seen.has(name)) return; seen.add(name);
    const n = byName.get(name); if (!n || n.disabled) return;
    const g = gated || GATE_TYPES.test(n.type);
    if (EMAIL_TYPES.test(n.type)) { res.set(name, (res.get(name) ?? true) && gated); return; }
    for (const s of successors(wf, name)) walk(s, g, new Set(seen));
  };
  walk(start, false, new Set());
  return [...res].map(([email, gated]) => ({ email, gated }));
}
const reachable = (wf: N8nWorkflow, start: string): Set<string> => {
  const out = new Set<string>(); const q = [start];
  while (q.length) { const x = q.shift()!; if (out.has(x)) continue; out.add(x); q.push(...successors(wf, x)); }
  return out;
};

export function checkWorkflow(wf: N8nWorkflow, opts: { heartbeatUrlPattern?: RegExp } = {}): Finding[] {
  const f: Finding[] = [];
  const key = (c: string) => `n8n:${wf.id}:${c}`;
  const hb = opts.heartbeatUrlPattern ?? /\/ingest\/heartbeat\b/;
  const base = { nicheId: null, needsOwner: false } as const;

  for (const t of wf.nodes.filter((n) => SCHEDULE_TYPES.test(n.type) && !n.disabled)) {
    const every = scheduleMinutes(t);
    for (const e of reachEmail(wf, t.name)) {
      if (!e.gated && (every == null || every < 10080)) f.push({ ...base, code: "N8N-P1", gate: "G14", severity: "critical",
        title: `${wf.name}: "${t.name}" always sends email`, detail: `"${e.email}" runs on every scheduled run (${every == null ? "unknown cadence" : `every ${fmtEvery(every)}`}) with no condition. Owner policy: no unsolicited daily email; send only on failure or weekly.`,
        dedupeKey: key(`p1:${t.name}:${e.email}`) });
      if (e.gated && every != null && every < 1440) f.push({ ...base, code: "N8N-P2", gate: "G14", severity: "warning",
        title: `${wf.name}: alert email can repeat ${Math.floor(1440 / every)} times a day`, detail: `"${e.email}" is gated, but a problem that persists re-sends every ${fmtEvery(every)}. Send once per incident (remember the last alert and only re-send on change or after 24h), and raise a FORGE alert instead of repeat emails.`,
        dedupeKey: key(`p2:${t.name}:${e.email}`) });
    }
    const downstream = [...reachable(wf, t.name)].map((n) => wf.nodes.find((x) => x.name === n)).filter(Boolean) as N8nNode[];
    const sendsHeartbeat = downstream.some((n) => /httpRequest$/i.test(n.type) && hb.test(String(n.parameters?.url ?? "")));
    if (!sendsHeartbeat) f.push({ ...base, code: "N8N-P6", gate: "G11", severity: "warning",
      title: `${wf.name}: "${t.name}" sends no heartbeat to FORGE`, detail: "If this schedule silently stops or errors before its last node, nothing notices. Add a final signed POST to FORGE /ingest/heartbeat (and an Error Trigger workflow that posts status=failed).",
      dedupeKey: key(`p6:${t.name}`) });
  }

  for (const w of wf.nodes.filter((n) => WEBHOOK_TYPES.test(n.type) && !n.disabled)) {
    const auth = String(w.parameters?.authentication ?? "none");
    const down = [...reachable(wf, w.name)].map((n) => wf.nodes.find((x) => x.name === n)).filter(Boolean) as N8nNode[];
    const hmacNodes = down.filter((n) => /\.crypto$/i.test(n.type) && n.parameters?.action === "hmac");
    const codeVerifies = down.some((n) => /\.code$/i.test(n.type) && /createHmac|crypto\.subtle/.test(String(n.parameters?.jsCode ?? "")));
    const gateAfterHmac = hmacNodes.some((h) => successors(wf, h.name).some((s) => GATE_TYPES.test(wf.nodes.find((x) => x.name === s)?.type ?? "")));
    if (auth === "none" && !gateAfterHmac && !codeVerifies) f.push({ ...base, code: "N8N-P3", gate: "G12", severity: "critical",
      title: `${wf.name}: webhook "${w.name}" accepts unauthenticated requests`, detail: "Anyone who learns the URL can trigger it. Verify an HMAC signature (or header auth) and stop before any side effect when it fails.",
      dedupeKey: key(`p3:${w.name}`) });
    for (const h of hmacNodes) {
      const v = String(h.parameters?.value ?? "");
      if (/JSON\.stringify\(/.test(v)) f.push({ ...base, code: "N8N-P4", gate: "G12", severity: "warning",
        title: `${wf.name}: signature computed over re-serialised JSON`, detail: `"${h.name}" signs JSON.stringify(body) rather than the raw request bytes the sender signed. It works only while both sides serialise identically; enable the webhook's Raw Body option and HMAC the raw body.`,
        dedupeKey: key(`p4:${h.name}`) });
    }
  }

  // Secret handling: data-table secrets and key reuse between HMAC verification and bearer headers.
  const tableKeys = new Map<string, string[]>(); // secret key name -> node names reading it
  for (const n of wf.nodes.filter((x) => /\.dataTable$/i.test(x.type))) {
    for (const c of n.parameters?.filters?.conditions ?? []) {
      const k = String(c.keyValue ?? ""); if (/secret|token|key|password/i.test(k)) tableKeys.set(k, [...(tableKeys.get(k) ?? []), n.name]);
    }
  }
  for (const [k, readers] of tableKeys) {
    const usedFor = new Set<string>();
    for (const r of readers) for (const s of reachable(wf, r)) {
      const n = wf.nodes.find((x) => x.name === s); if (!n || s === r) continue;
      if (/\.crypto$/i.test(n.type) && successors(wf, r).includes(s)) usedFor.add("hmac");
      if (/httpRequest$/i.test(n.type) && successors(wf, r).includes(s) && JSON.stringify(n.parameters?.headerParameters ?? {}).includes("$json.value")) usedFor.add("bearer");
    }
    if (usedFor.has("hmac") && usedFor.has("bearer")) f.push({ ...base, code: "N8N-P5", gate: "G12", severity: "warning",
      title: `${wf.name}: "${k}" is both the HMAC key and a bearer token`, detail: "The same value is sent in a request header and used to verify signed sale forwards. Anyone who sees the header can forge sales. Use separate secrets (forward-signing secret vs report token).",
      dedupeKey: key(`p5:reuse:${k}`) });
    f.push({ ...base, code: "N8N-P5", gate: "G12", severity: "info",
      title: `${wf.name}: "${k}" is stored in an n8n data table`, detail: "Data tables are readable by anyone with workflow access and are exported with the project. Prefer an n8n credential (Header Auth / Crypto credential).",
      dedupeKey: key(`p5:table:${k}`) });
  }
  return f;
}

const fmtEvery = (m: number) => (m % 1440 === 0 ? `${m / 1440} day(s)` : m % 60 === 0 ? `${m / 60} hour(s)` : `${m} minute(s)`);
