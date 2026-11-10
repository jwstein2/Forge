/**
 * ops.lifecycle_watch — daily, read-only look at the email lifecycle in MailerLite.
 *
 * Reads groups, embedded forms and automations with GET requests only (MAILERLITE_API_KEY, a Worker secret the
 * owner has to approve). Without the key it records an 'unconnected' snapshot and raises nothing: unknown stays
 * unknown, never "0 subscribers".
 *
 * Alerts:
 *  - an automation FORGE knows about is broken                                        → critical
 *  - people are in a signup group but its welcome automation is not on                → warning, needs owner
 *  - unconfirmed (double opt-in not clicked) is at least half of a group with 10+     → warning
 *  - bounces + spam complaints reach 5 in a group                                     → warning
 * It never enables, edits or sends anything.
 */
import type { HandlerDef } from "../../../../services/api/src/orchestration/engine.ts";
import { alertStmt, checkStmt, flush, newId, nowIso, resolveStmt, type Finding } from "../lib.ts";
import { SEQUENCES } from "../lifecycle/sequences.ts";

export interface MlGroup { id: string; name: string; active_count: number; unconfirmed_count: number; unsubscribed_count: number; bounced_count: number; junk_count: number }
export interface MlForm { id: string; name: string; active: boolean; opens_count: number; conversions_count: number }
export interface MlAutomation { id: string; name: string; enabled: boolean; broken?: boolean; complete?: boolean; stats?: { sent?: number } }
export interface MailerLiteReader { mode: "live" | "unconnected"; groups(): Promise<MlGroup[]>; forms(): Promise<MlForm[]>; automations(): Promise<MlAutomation[]> }

export const unconnectedMailerLite: MailerLiteReader = { mode: "unconnected", groups: async () => [], forms: async () => [], automations: async () => [] };

/** Read-only MailerLite API client. Three GETs per run (three subrequests). */
export function mailerLiteApi(apiKey: string, fetcher: typeof fetch = fetch): MailerLiteReader {
  const get = async <T>(path: string): Promise<T[]> => {
    const res = await fetcher(`https://connect.mailerlite.com/api${path}`, { method: "GET", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
    if (!res.ok) throw new Error(`MailerLite ${path} HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T[] };
    return body.data ?? [];
  };
  return {
    mode: "live",
    groups: () => get<MlGroup>("/groups?limit=100"),
    forms: () => get<MlForm>("/forms/embedded?limit=100"),
    automations: async () => (await get<MlAutomation>("/automations?limit=100")).map((a) => ({ ...a, id: String(a.id) })),
  };
}

export const mailerLiteFromEnv = (env: Record<string, unknown>): MailerLiteReader =>
  typeof env.MAILERLITE_API_KEY === "string" && env.MAILERLITE_API_KEY.length > 10 ? mailerLiteApi(env.MAILERLITE_API_KEY) : unconnectedMailerLite;

const WELCOMES = SEQUENCES.filter((s) => s.kind === "welcome" && s.trigger.mailerliteGroupId);

export function lifecycleWatch(reader: (env: Record<string, unknown>) => MailerLiteReader = mailerLiteFromEnv): HandlerDef {
  return {
    kind: "ops.lifecycle_watch",
    registryId: "OPS-LIFECYCLE-WATCH",
    steps: [{
      name: "read",
      async run({ db, env, jobId }) {
        const ml = reader(env as unknown as Record<string, unknown>);
        const at = nowIso();
        if (ml.mode === "unconnected") {
          await db.prepare(`INSERT INTO op_lifecycle_snapshots (id,taken_at,state,source,job_id) VALUES (?,?,'unconnected','none',?)`).bind(newId("lcs"), at, jobId).run();
          return { output: { state: "unconnected", note: "MAILERLITE_API_KEY not set; subscriber counts and automation status are UNKNOWN." } };
        }
        let groups: MlGroup[]; let forms: MlForm[]; let autos: MlAutomation[];
        try { [groups, forms, autos] = await Promise.all([ml.groups(), ml.forms(), ml.automations()]); }
        catch (e) {
          const error = String((e as Error).message ?? e).slice(0, 300);
          await db.prepare(`INSERT INTO op_lifecycle_snapshots (id,taken_at,state,source,error,job_id) VALUES (?,?,'error','mailerlite.api',?,?)`).bind(newId("lcs"), at, error, jobId).run();
          return { output: { state: "error", error } };
        }
        const stmts: D1PreparedStatement[] = [];
        const findings: Finding[] = [];
        const byGroup = new Map(groups.map((g) => [String(g.id), g]));
        const byAuto = new Map(autos.map((a) => [String(a.id), a]));
        const autoRows: Record<string, unknown>[] = [];
        for (const s of WELCOMES) {
          const g = byGroup.get(s.trigger.mailerliteGroupId!);
          const a = (s.mailerliteAutomationId && byAuto.get(s.mailerliteAutomationId)) || autos.find((x) => x.name === s.name);
          const status = !a ? "missing" : a.broken ? "broken" : a.enabled ? "active" : "off";
          autoRows.push({ id: a?.id ?? null, name: s.name, nicheId: s.nicheId, sequence: s.id, status, sent: a?.stats?.sent ?? null });
          const kBroken = `ops:lifecycle:broken:${s.id}`; const kWaiting = `ops:lifecycle:welcome_off:${s.id}`;
          if (status === "broken") { findings.push({ code: "automation_broken", severity: "critical", message: `${s.name} is broken in MailerLite` });
            stmts.push(alertStmt(db, { key: kBroken, severity: "critical", nicheId: s.nicheId, source: "ops.lifecycle_watch", title: `${s.name} automation is broken`, detail: "MailerLite reports the automation as broken, so new subscribers are not getting it.", nextAction: "Open the automation in MailerLite and fix the step it flags.", evidenceUrl: a ? `https://dashboard.mailerlite.com/automations/${a.id}` : null })); }
          else stmts.push(resolveStmt(db, kBroken));
          const waiting = g ? Number(g.active_count) : 0;
          if (g && waiting > 0 && status !== "active") { findings.push({ code: "welcome_off", severity: "warning", message: `${waiting} subscriber(s) in "${g.name}" and the welcome sequence is ${status}` });
            stmts.push(alertStmt(db, { key: kWaiting, severity: "warning", nicheId: s.nicheId, source: "ops.lifecycle_watch", needsOwner: true, title: `${s.name}: ${waiting} subscriber(s) waiting, welcome emails are ${status}`,
              detail: `People are joining "${g.name}" but the welcome sequence is ${status}, so nobody receives the download or the follow-ups. Turning it on only affects people who join after that.`,
              nextAction: "Review the draft in MailerLite and enable it (owner decision).", evidenceUrl: a ? `https://dashboard.mailerlite.com/automations/${a.id}` : null })); }
          else stmts.push(resolveStmt(db, kWaiting));
        }
        for (const g of groups) {
          const total = Number(g.active_count) + Number(g.unconfirmed_count);
          const kUnc = `ops:lifecycle:unconfirmed:${g.id}`; const kBad = `ops:lifecycle:deliverability:${g.id}`;
          if (total >= 10 && Number(g.unconfirmed_count) * 2 >= total) { findings.push({ code: "unconfirmed_high", severity: "warning", message: `${g.unconfirmed_count} of ${total} in "${g.name}" never confirmed` });
            stmts.push(alertStmt(db, { key: kUnc, severity: "warning", source: "ops.lifecycle_watch", title: `"${g.name}": half or more of signups never confirmed`, detail: `${g.unconfirmed_count} unconfirmed vs ${g.active_count} active. The confirmation email may be landing in spam or be unclear.`, nextAction: "Send yourself a test signup and check the confirmation email." })); }
          else stmts.push(resolveStmt(db, kUnc));
          if (Number(g.bounced_count) + Number(g.junk_count) >= 5) { findings.push({ code: "deliverability", severity: "warning", message: `"${g.name}": ${g.bounced_count} bounced, ${g.junk_count} spam complaints` });
            stmts.push(alertStmt(db, { key: kBad, severity: "warning", source: "ops.lifecycle_watch", title: `"${g.name}": bounces or spam complaints`, detail: `${g.bounced_count} bounced and ${g.junk_count} marked as spam.`, nextAction: "Check the signup form for fake or mistyped addresses and review the sender domain setup." })); }
          else stmts.push(resolveStmt(db, kBad));
        }
        const groupRows = groups.map((g) => ({ id: String(g.id), name: g.name, nicheId: WELCOMES.find((s) => s.trigger.mailerliteGroupId === String(g.id))?.nicheId ?? null, active: g.active_count, unconfirmed: g.unconfirmed_count, unsubscribed: g.unsubscribed_count, bounced: g.bounced_count, junk: g.junk_count }));
        const formRows = forms.map((f) => ({ id: String(f.id), name: f.name, active: !!f.active, opens: f.opens_count, conversions: f.conversions_count }));
        stmts.push(db.prepare(`INSERT INTO op_lifecycle_snapshots (id,taken_at,state,source,groups_json,forms_json,automations_json,job_id) VALUES (?,?,'live','mailerlite.api',?,?,?,?)`)
          .bind(newId("lcs"), at, JSON.stringify(groupRows), JSON.stringify(formRows), JSON.stringify(autoRows), jobId));
        stmts.push(checkStmt(db, { kind: "lifecycle", target: "mailerlite", ok: !findings.some((f) => f.severity !== "info"), findings, jobId }));
        await flush(db, stmts);
        return { output: { state: "live", groups: groupRows.length, forms: formRows.length, automations: autoRows, findings: findings.map((f) => f.code) } };
      },
    }],
  };
}
