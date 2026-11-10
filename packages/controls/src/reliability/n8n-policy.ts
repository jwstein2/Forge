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
/** How many values a cron field takes within its range (handles *, lists, ranges, steps). */
function fieldCount(field: string, size: number, lo: number): number {
  let n = 0;
  for (const part of field.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw ? Math.max(1, Number(stepRaw)) : 1;
    let a = lo, b = lo + size - 1;
    if (rangeRaw && rangeRaw !== "*") {
      const [x, y] = rangeRaw.split("-").map(Number);
      a = x!; b = y ?? (stepRaw ? lo + size - 1 : x!);
    }
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return NaN;
    n += Math.floor((b - a) / step) + 1;
  }
  return n;
}
/** Average minutes between runs for a 5- or 6-field cron expression. */
function cronMinutes(expr: string): number | null {
  const f = expr.trim().split(/\s+/); if (f.length < 5) return null;
  const [min, hr, dom, mon, dow] = (f.length === 6 ? f.slice(1) : f) as string[];
  const perHour = fieldCount(min!, 60, 0); const hours = fieldCount(hr!, 24, 0);
  if (!Number.isFinite(perHour) || !Number.isFinite(hours)) return null;
  const perDay = perHour * hours;
  const months = mon === "*" ? 12 : fieldCount(mon!, 12, 1);
  let daysPerYear: number;
  if (dom !== "*" && dow === "*") daysPerYear = fieldCount(dom!, 31, 1) * months;
  else if (dow !== "*" && dom === "*") daysPerYear = (fieldCount(dow!, 7, 0) * 365 / 7) * (months / 12);
  else daysPerYear = 365 * (months / 12);
  const runsPerYear = perDay * daysPerYear;
  if (!Number.isFinite(runsPerYear) || runsPerYear <= 0) return null;
  return Math.round((365 * 1440) / runsPerYear);
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

const SAFE_TYPES = /\.(code|crypto|if|filter|switch|set|respondToWebhook|noOp|merge|stopAndError|dateTime)$/i;
function isSideEffect(n: N8nNode): boolean {
  // Only explicit read operations are safe; a missing operation is treated as a write (QA-006 R1: fail closed).
  if (/\.dataTable$/i.test(n.type)) return !["get", "rowExists", "rowNotExists"].includes(n.parameters?.operation);
  return !SAFE_TYPES.test(n.type);
}
/** A gate verifies a signature if it compares the output of an upstream HMAC node (by its dataPropertyName), or is a Code node that computes an HMAC and throws/returns nothing on mismatch. */
function verifyingGate(wf: N8nWorkflow, n: N8nNode, seenHmacProps: string[]): boolean {
  if (GATE_TYPES.test(n.type)) return seenHmacProps.some((p) => JSON.stringify(n.parameters ?? {}).includes(p));
  if (/\.code$/i.test(n.type)) { const js = String(n.parameters?.jsCode ?? ""); return /createHmac|crypto\.subtle/.test(js) && /\bthrow\b|return\s*\[\s*\]/.test(js); }
  return false;
}
/** Side-effect nodes reachable from a webhook on a path that has not yet passed the TRUE branch of a verifying gate. */
function sideEffectsBeforeVerification(wf: N8nWorkflow, start: string): string[] {
  const byName = new Map(wf.nodes.map((n) => [n.name, n]));
  const hits = new Set<string>(); const seen = new Set<string>();
  const walk = (name: string, props: string[]) => {
    const k = `${name}|${props.join(",")}`; if (seen.has(k)) return; seen.add(k);
    const n = byName.get(name); if (!n || n.disabled) return;
    if (name !== start && isSideEffect(n)) { hits.add(name); return; }
    const p = /\.crypto$/i.test(n.type) && n.parameters?.action === "hmac" ? [...props, String(n.parameters?.dataPropertyName ?? "data")] : props;
    const outs = wf.connections[name]?.main ?? [];
    if (name !== start && verifyingGate(wf, n, p)) {
      // Only the first (true) output is verified; other outputs continue unverified. A verifying Code node verifies all outputs.
      if (/\.code$/i.test(n.type)) return;
      outs.slice(1).forEach((o) => (o ?? []).forEach((c) => walk(c.node, p)));
      return;
    }
    outs.forEach((o) => (o ?? []).forEach((c) => walk(c.node, p)));
  };
  walk(start, []);
  return [...hits];
}

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
    const exposed = auth === "none" ? sideEffectsBeforeVerification(wf, w.name) : [];
    if (exposed.length) f.push({ ...base, code: "N8N-P3", gate: "G12", severity: "critical",
      title: `${wf.name}: webhook "${w.name}" reaches side effects without a signature check`, detail: `Unverified requests can reach: ${exposed.slice(0, 5).join(", ")}. Verify an HMAC signature (or header auth) and stop before any side effect when it fails.`,
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
