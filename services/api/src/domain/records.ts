// Plain record listers: row → contract mapping. No invented fields.
import type { Account, Alert, Budget, Channel, CostItem, EvidenceRef, Integration, Product } from "@forge/contracts";

type R = Record<string, any>;
export const mapEvidence = (r: R): EvidenceRef => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, claim: r.claim, label: r.label, source: r.source, url: r.url, observedAt: r.observed_at, collectedBy: r.collected_by });

export async function evidenceFor(db: D1Database, subjectType: string, subjectId: string): Promise<EvidenceRef[]> {
  return (await db.prepare(`SELECT * FROM evidence WHERE subject_type = ? AND subject_id = ? ORDER BY observed_at DESC`).bind(subjectType, subjectId).all<R>()).results.map(mapEvidence);
}

export async function listProducts(db: D1Database, nicheId?: string): Promise<Product[]> {
  const st = nicheId ? db.prepare(`SELECT * FROM products WHERE niche_id = ? ORDER BY tier DESC, name`).bind(nicheId) : db.prepare(`SELECT * FROM products ORDER BY niche_id, tier DESC, name`);
  const rows = (await st.all<R>()).results;
  return Promise.all(rows.map(async (r) => ({
    id: r.id, nicheId: r.niche_id, name: r.name, kind: r.kind, tier: r.tier,
    sitePriceCents: r.site_price_cents, checkoutPriceCents: r.checkout_price_cents,
    priceMismatch: r.site_price_cents != null && r.checkout_price_cents != null && r.site_price_cents !== r.checkout_price_cents,
    status: r.status, checkoutStatus: r.checkout_status, deliveryStatus: r.delivery_status, notes: r.notes,
    evidence: await evidenceFor(db, "product", r.id),
  })));
}

export async function listChannels(db: D1Database, nicheId?: string): Promise<Channel[]> {
  const st = nicheId ? db.prepare(`SELECT * FROM channels WHERE niche_id = ? ORDER BY platform`).bind(nicheId) : db.prepare(`SELECT * FROM channels ORDER BY niche_id, platform`);
  return (await st.all<R>()).results.map((r) => ({ id: r.id, nicheId: r.niche_id, platform: r.platform, status: r.status, cadence: r.cadence, accountUrl: r.account_url, lastVerifiedAt: r.last_verified_at, lastVerifiedUrl: r.last_verified_url, jobId: r.registry_id, notes: r.notes }));
}

export async function listIntegrations(db: D1Database, nicheId?: string): Promise<Integration[]> {
  const st = nicheId ? db.prepare(`SELECT * FROM integrations WHERE niche_id = ? OR niche_id IS NULL ORDER BY service`).bind(nicheId) : db.prepare(`SELECT * FROM integrations ORDER BY service`);
  return (await st.all<R>()).results.map((r) => ({ id: r.id, service: r.service, nicheId: r.niche_id, purpose: r.purpose, status: r.status, accessMode: r.access_mode, lastCheckedAt: r.last_checked_at, lastOkAt: r.last_ok_at, detail: r.detail, blocker: r.blocker }));
}

export async function listAccounts(db: D1Database): Promise<Account[]> {
  // Explicit column list: the accounts table has no secret column, and the API never selects '*' here.
  const rows = (await db.prepare(`SELECT id, service, niche_id, identifier, status, url, password_manager_ref, owner, notes FROM accounts ORDER BY service`).all<R>()).results;
  return rows.map((r) => ({ id: r.id, service: r.service, nicheId: r.niche_id, identifier: r.identifier, status: r.status, url: r.url, passwordManagerRef: r.password_manager_ref, owner: r.owner, notes: r.notes }));
}

export const mapAlert = (r: R): Alert => ({ id: r.id, severity: r.severity, nicheId: r.niche_id, source: r.source, title: r.title, detail: r.detail, state: r.state, firstSeen: r.first_seen, lastSeen: r.last_seen, nextAction: r.next_action, needsOwner: !!r.needs_owner, evidenceUrl: r.evidence_url });
export async function listAlerts(db: D1Database, opts: { state?: string; nicheId?: string } = {}): Promise<Alert[]> {
  const where: string[] = []; const params: unknown[] = [];
  if (opts.state) { where.push("state = ?"); params.push(opts.state); }
  if (opts.nicheId) { where.push("(niche_id = ? OR niche_id IS NULL)"); params.push(opts.nicheId); }
  const sql = `SELECT * FROM alerts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen DESC`;
  return (await db.prepare(sql).bind(...params).all<R>()).results.map(mapAlert);
}

export async function listCosts(db: D1Database, nicheId?: string): Promise<CostItem[]> {
  const st = nicheId ? db.prepare(`SELECT * FROM cost_items WHERE niche_id = ? OR niche_id IS NULL ORDER BY vendor`).bind(nicheId) : db.prepare(`SELECT * FROM cost_items ORDER BY vendor`);
  return (await st.all<R>()).results.map((r) => ({ id: r.id, nicheId: r.niche_id, vendor: r.vendor, item: r.item, amountCents: r.amount_cents, cadence: r.cadence, evidence: r.evidence, allocationRule: r.allocation_rule, notes: r.notes }));
}

export async function listBudgets(db: D1Database): Promise<Budget[]> {
  return (await db.prepare(`SELECT * FROM budgets ORDER BY id`).all<R>()).results.map((r) => ({ id: r.id, scope: r.scope, ceilingCents: r.ceiling_cents, approvedCents: r.approved_cents, spentCents: r.spent_cents, evidence: r.evidence, notes: r.notes }));
}
