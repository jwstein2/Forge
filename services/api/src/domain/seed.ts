/**
 * Load the git registry into the platform database. Idempotent: existing rows are left untouched
 * (ON CONFLICT DO NOTHING), so runtime state such as a paused flag is never overwritten by a re-seed.
 */
import type { RegistryData } from "./registry-data.ts";
import { nowIso } from "../lib/util.ts";

type Row = Record<string, unknown>;
const AUDIT_ACTOR = "seed:registry";

export async function seedRegistry(db: D1Database, data: RegistryData, at = nowIso()): Promise<Record<string, number>> {
  const stmts: D1PreparedStatement[] = [];
  const count: Record<string, number> = {};
  const add = (table: string, s: D1PreparedStatement) => { stmts.push(s); count[table] = (count[table] ?? 0) + 1; };
  const evidenceAt = (data.niches as { _meta: { asOf: string } })._meta.asOf;
  const addEvidence = (subjectType: string, subjectId: string, ev: Row[] | undefined) => {
    (ev ?? []).forEach((e, i) => add("evidence", db.prepare(
      `INSERT INTO evidence (id,subject_type,subject_id,claim,label,source,url,observed_at,collected_by) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    ).bind(`ev_${subjectType}_${subjectId}_${i}`, subjectType, subjectId, e.claim, e.label, e.source, e.url ?? null, evidenceAt, AUDIT_ACTOR)));
  };

  for (const n of data.niches.niches as Row[]) {
    add("niches", db.prepare(`INSERT INTO niches (id,name,tagline,positioning,lifecycle,site_url,pages_project,ledger_vertical,event_path_prefix,beacon,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET beacon=excluded.beacon`)
      .bind(n.id, n.name, n.tagline, n.positioning, n.lifecycle, n.siteUrl, n.pagesProject, n.ledgerVertical, n.eventPathPrefix, n.beacon ?? "unknown", at, at));
    addEvidence("niche", String(n.id), n.evidence as Row[]);
  }
  for (const p of data.products.products as Row[]) {
    add("products", db.prepare(`INSERT INTO products (id,niche_id,name,kind,tier,site_price_cents,checkout_price_cents,ledger_product_name,status,checkout_status,delivery_status,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(p.id, p.nicheId, p.name, p.kind, p.tier, p.sitePriceCents, p.checkoutPriceCents, p.ledgerProductName, p.status, p.checkoutStatus, p.deliveryStatus, p.notes, at));
    addEvidence("product", String(p.id), p.evidence as Row[]);
  }
  for (const r of data.registry.entries as Row[]) {
    add("registry_entries", db.prepare(`INSERT INTO registry_entries (id,kind,name,niche_id,department,owner,runner,external_ref,trigger_desc,cadence,interval_minutes,model,cost_cap_cents,retry_budget,status,pausable,defects_json,defined_in,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(r.id, r.kind, r.name, r.nicheId, r.department, r.owner, r.runner, r.externalRef, r.trigger, r.cadence, r.intervalMinutes, r.model, r.costCapCents, r.retryBudget, r.status, r.pausable ? 1 : 0, JSON.stringify(r.defects ?? []), r.definedIn, r.notes, at));
  }
  for (const c of data.channels.channels as Row[]) {
    add("channels", db.prepare(`INSERT INTO channels (id,niche_id,platform,status,cadence,account_url,last_verified_at,last_verified_url,registry_id,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(c.id, c.nicheId, c.platform, c.status, c.cadence, c.accountUrl, c.lastVerifiedAt, c.lastVerifiedUrl, c.registryId, c.notes, at));
  }
  for (const i of data.integrations.integrations as Row[]) {
    add("integrations", db.prepare(`INSERT INTO integrations (id,service,niche_id,purpose,status,access_mode,last_checked_at,last_ok_at,detail,blocker,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(i.id, i.service, i.nicheId, i.purpose, i.status, i.accessMode, i.lastCheckedAt, i.lastOkAt, i.detail, i.blocker, at));
  }
  for (const a of data.accounts.accounts as Row[]) {
    add("accounts", db.prepare(`INSERT INTO accounts (id,service,niche_id,identifier,status,url,password_manager_ref,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(a.id, a.service, a.nicheId, a.identifier, a.status, a.url, a.passwordManagerRef, a.notes, at));
  }
  for (const c of data.costs.costItems as Row[]) {
    add("cost_items", db.prepare(`INSERT INTO cost_items (id,niche_id,category,vendor,item,amount_cents,cadence,evidence,allocation_rule,notes,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(c.id, c.nicheId, c.category, c.vendor, c.item, c.amountCents, c.cadence, c.evidence, c.allocationRule, c.notes, at));
  }
  for (const b of data.budgets.budgets as Row[]) {
    add("budgets", db.prepare(`INSERT INTO budgets (id,scope,ceiling_cents,approved_cents,spent_cents,evidence,notes,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
      .bind(b.id, b.scope, b.ceilingCents, b.approvedCents, b.spentCents, b.evidence, b.notes, at));
  }
  for (const a of data.alerts.alerts as Row[]) {
    add("alerts", db.prepare(`INSERT INTO alerts (id,severity,niche_id,source,title,detail,state,dedupe_key,first_seen,last_seen,next_action,needs_owner) VALUES (?,?,?,?,?,?,'open',?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .bind(a.id, a.severity, a.nicheId, a.source, a.title, a.detail, a.dedupeKey, evidenceAt, evidenceAt, a.nextAction, a.needsOwner ? 1 : 0));
  }
  add("system_controls", db.prepare(`INSERT INTO system_controls (key,value_json,updated_by,updated_at) VALUES ('global_pause',?,?,?) ON CONFLICT(key) DO NOTHING`)
    .bind(JSON.stringify({ paused: false, reason: null }), AUDIT_ACTOR, at));
  await db.batch(stmts);
  return count;
}
