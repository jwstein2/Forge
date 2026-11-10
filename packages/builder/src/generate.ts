/**
 * Deterministic Launch Blueprint generator: same brief + same options => byte-identical blueprint.
 * It only rearranges what the brief already says and names what is missing. It never invents demand,
 * proof, prices, targets or customers; anything the brief does not support becomes an `unknowns` entry.
 */
import type { Brief, BriefClaim, BriefMetric } from "./brief.ts";
import { contentHash } from "./hash.ts";
import { PLAYBOOKS, classifyPlaybook } from "./playbooks.ts";
import { stagePlans } from "./stages.ts";
import {
  BLUEPRINT_SCHEMA_VERSION, GENERATOR_VERSION,
  type ChannelPlan, type ClaimRef, type Integration, type LaunchBlueprint, type OfferTier, type PageSpec, type Price, type ProductSpec, type Unknown,
} from "./types.ts";

export interface RegistryProduct { id: string; nicheId: string; name: string; kind: string; tier: string }

export interface GenerateOptions {
  version?: string;                 // default 1.0.0
  supersedes?: string | null;
  createdAt?: string;               // default: the brief's updated_at (keeps output deterministic)
  businessKind?: "existing_niche" | "new_business";
  opportunity?: { opportunity_id: string; rank: number | null; recommended: boolean } | null;
  budgetCeilingCents?: number | null;
  registryProducts?: RegistryProduct[];
  /** A hold/stop call in the brief refuses generation unless the caller explicitly overrides it. */
  allowHold?: boolean;
  changelog?: string;
}

export class BlueprintRefused extends Error {}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
const ref = (c: BriefClaim): ClaimRef => ({ claim_id: c.id, statement: c.statement, evidence: c.evidence });
const EVIDENCE_RANK = { VERIFIED: 0, ESTIMATED: 1, INFERRED: 2, UNKNOWN: 3 } as const;
const byEvidence = (a: BriefClaim, b: BriefClaim) => EVIDENCE_RANK[a.evidence] - EVIDENCE_RANK[b.evidence];

function price(m: BriefMetric | undefined): Price {
  if (!m || m.value === undefined || m.value === null) return { value: null, currency: "USD", evidence: "UNKNOWN", note: "No price in the brief." };
  const p: Price = { value: m.value, currency: "USD", evidence: m.evidence };
  if (m.to_resolve) p.note = m.to_resolve;
  return p;
}

const REGISTRY_KIND: Record<string, string> = { "spreadsheet-template": "spreadsheet", "printable-pdf": "pdf", "kdp-book": "book" };

function matchRegistry(products: RegistryProduct[], niche: string, playbook: string): string | null {
  const kind = REGISTRY_KIND[playbook];
  if (!kind) return null;
  const hits = products.filter((p) => p.nicheId === niche && p.tier === "paid" && p.kind === kind);
  return hits.length === 1 ? hits[0]!.id : null;
}

/** Prefer claims about the primary segment, then stronger evidence; stable for equal keys. */
function pick(claims: BriefClaim[], primary: string | null, n: number): BriefClaim[] {
  const indexed = claims.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    const pa = a.c.segment_id && a.c.segment_id === primary ? 0 : 1;
    const pb = b.c.segment_id && b.c.segment_id === primary ? 0 : 1;
    return pa - pb || byEvidence(a.c, b.c) || a.i - b.i;
  });
  return indexed.slice(0, n).map((x) => x.c);
}

export async function generateBlueprint(brief: Brief, opts: GenerateOptions = {}): Promise<LaunchBlueprint> {
  const call = brief.summary.go_hold.call;
  if ((call === "hold" || call === "stop") && !opts.allowHold) {
    throw new BlueprintRefused(`Brief ${brief.brief_id} says "${call}": ${brief.summary.go_hold.rationale}`);
  }
  const version = opts.version ?? "1.0.0";
  const niche = brief.niche;
  const newBusiness = (opts.businessKind ?? "existing_niche") === "new_business";
  const rec = brief.premium_product_recommendation;
  const primary = rec.target_segment_id ?? brief.audience.segments.find((s) => s.priority === "primary")?.id ?? null;
  const unknowns: Unknown[] = [];

  // ---------- offer ladder and products ----------
  const products: ProductSpec[] = [];
  const ladder: OfferTier[] = rec.offer_ladder.map((t) => {
    const p = price(t.price);
    const matchesRec = rec.name.toLowerCase().includes(t.item.toLowerCase()) || t.item.toLowerCase().includes(rec.name.toLowerCase());
    // "A or B" in an offer item is an undecided choice, not a product: never build a page for it (QA-009 S3).
    const undecided = !matchesRec && /\bor\b/i.test(t.item);
    const playbook = undecided ? "unsupported" : classifyPlaybook(t.item, t.tier, p.value, { formatHint: matchesRec ? rec.format : undefined });
    let productId: string | null = null;
    if (undecided) unknowns.push({ field: `offer_ladder.${t.tier}.item`, statement: `"${t.item}" names alternatives; choose one before it becomes a product.`, resolve_by: "Product & Offer recommends; owner decides at B1" });
    if (playbook !== "free-resource" && !undecided) {
      productId = `prd_${niche}_${slug(t.item)}`;
      const pb = PLAYBOOKS[playbook];
      const spec: ProductSpec = {
        product_id: productId, name: matchesRec ? rec.name : t.item, tier: t.tier, playbook, format: matchesRec ? rec.format : pb.label,
        price: p, target_segment_id: matchesRec ? primary : null,
        must_include: matchesRec ? [...rec.must_include] : [], must_not: matchesRec ? [...rec.must_not] : [],
        deliverables: pb.deliverables.map((d) => ({ ...d })), gates: [...pb.gates], status: "PROPOSED",
        basis: matchesRec ? (rec.evidence ?? []).map(ref) : [], falsifying_test: matchesRec ? rec.falsifying_test ?? null : null,
        registry_product_id: matchRegistry(opts.registryProducts ?? [], niche, playbook),
      };
      products.push(spec);
      if (!matchesRec) unknowns.push(spec.registry_product_id
        ? { field: `products.${productId}.must_include`, statement: `"${t.item}" already exists as ${spec.registry_product_id}; the brief gives no spec, so audit the existing file rather than rebuild it.`, resolve_by: "Product & Offer inventories the existing product; reviewed at B1" }
        : { field: `products.${productId}.must_include`, statement: `The brief gives no contents for "${t.item}".`, resolve_by: "Product & Offer proposes contents; reviewed at B1" });
      if (playbook === "unsupported") unknowns.push({ field: `products.${productId}.playbook`, statement: `"${t.item}" does not match a FORGE playbook.`, resolve_by: "New playbook or owner decision before the products stage" });
      if (pb.needsOwnerAccount) unknowns.push({ field: `products.${productId}.account`, statement: `Needs ${pb.needsOwnerAccount}.`, resolve_by: "Owner" });
    }
    if ((p.evidence === "INFERRED" || p.evidence === "ESTIMATED") && (p.value ?? 0) > 0) unknowns.push({ field: `offer_ladder.${t.tier}.price`, statement: `$${p.value} for "${t.item}" is a hypothesis (${p.evidence}), not a tested price.`, resolve_by: "Owner sets launch price; falsifying test decides changes" });
    if (p.note) unknowns.push({ field: `offer_ladder.${t.tier}.price`, statement: p.note, resolve_by: "Owner" });
    return { tier: t.tier, item: t.item, price: p, product_id: productId, playbook };
  });
  const core = products.find((p) => p.name === rec.name) ?? products[0] ?? null;

  // ---------- sales framework ----------
  const outcomes = pick(brief.desired_outcomes ?? [], primary, 3);
  const pains = pick(brief.pains, primary, 4);
  const proofCandidates = (rec.evidence ?? []).filter((c) => c.evidence === "VERIFIED");
  if (!outcomes.length) unknowns.push({ field: "sales_framework.promise", statement: "The brief has no desired outcomes to ground the promise.", resolve_by: "Intelligence adds desired_outcomes" });
  const promiseBasis = outcomes.slice(0, 1);
  // The picture never repeats the promise; with a single outcome it stays a copy gap for the website stage.
  const pictureBasis = outcomes.slice(1, 2);

  // ---------- pages ----------
  const pages: PageSpec[] = [
    { path: "/", purpose: "Home: the promise, the free tools and the paid offer", template: "home", sections: ["promise", "pain", "proof", "plan", "picture", "free-tools", "paid-offer", "email-capture"], required_for_launch: true, gates: ["G1", "G2", "G3", "G9"] },
    { path: "/tools/", purpose: "Free calculators, guides and templates (traffic and trust)", template: PLAYBOOKS["free-resource"].pageTemplate, sections: PLAYBOOKS["free-resource"].pageSections, required_for_launch: true, gates: PLAYBOOKS["free-resource"].gates },
    ...products.filter((p) => p.playbook !== "unsupported").map((p) => ({
      path: `/products/${slug(p.name)}/`, purpose: `Sales page for ${p.name}`, template: PLAYBOOKS[p.playbook].pageTemplate,
      sections: PLAYBOOKS[p.playbook].pageSections, required_for_launch: p === core, gates: ["G1", "G2", "G3", "G5", "G8", "G9"] as PageSpec["gates"],
    })),
    { path: "/thank-you/", purpose: "Post-purchase delivery instructions", template: "transactional", sections: ["download-steps", "support-contact"], required_for_launch: true, gates: ["G1", "G5"] },
    { path: "/about/", purpose: "Who runs this and why (real operator, no invented story)", template: "content", sections: ["operator", "mission"], required_for_launch: true, gates: ["G1", "G2"] },
    { path: "/contact/", purpose: "Support contact", template: "content", sections: ["contact"], required_for_launch: true, gates: ["G1", "G7"] },
    { path: "/privacy/", purpose: "Privacy policy matching actual data flows", template: "legal", sections: ["legal"], required_for_launch: true, gates: ["G7"] },
    { path: "/terms/", purpose: "Terms of sale", template: "legal", sections: ["legal"], required_for_launch: true, gates: ["G7"] },
    { path: "/refunds/", purpose: "Refund policy", template: "legal", sections: ["legal"], required_for_launch: true, gates: ["G7"] },
  ];

  // ---------- channels ----------
  const channels: ChannelPlan[] = (brief.channel_fit ?? []).map((c) => {
    const integ = /pinterest/i.test(c.channel) ? "Pinterest" : /email/i.test(c.channel) ? "MailerLite" : /search|seo/i.test(c.channel) ? "Google Search Console"
      : /youtube/i.test(c.channel) ? "YouTube" : /instagram/i.test(c.channel) ? "Instagram" : /etsy/i.test(c.channel) ? "Etsy"
      : /amazon|kdp/i.test(c.channel) ? "Amazon" : /facebook/i.test(c.channel) && !/group/i.test(c.channel) ? "Facebook" : null;
    const community = /group|reddit|forum|communit/i.test(c.channel);
    const priority: ChannelPlan["priority"] = c.fit === "strong" ? "launch" : c.fit === "moderate" ? (community ? "after_launch" : "launch") : c.fit === "weak" ? "hold" : "after_launch";
    return {
      channel: c.channel, fit: c.fit, priority, owner_role: community ? "Owner (personal participation only; no automated posting)" : "Marketing & Distribution",
      // Every public channel needs an owner-approved account or boundary; no channel is approval-free.
      integration_required: integ, owner_approval_required: true, cadence: null, basis: ref(c.rationale),
    };
  });
  if (!channels.length) unknowns.push({ field: "channel_plan", statement: "The brief has no channel_fit entries.", resolve_by: "Intelligence" });
  for (const c of channels) if (c.fit === "unknown") unknowns.push({ field: `channel_plan.${slug(c.channel)}`, statement: `Fit for ${c.channel} is unknown.`, resolve_by: "Measure after launch" });

  // ---------- integrations ----------
  const integrations: Integration[] = [
    { id: "checkout", service: "Lemon Squeezy", purpose: "Checkout and merchant of record", status: "unconnected", owner_approval_required: true, shared_component: "checkout-button", note: "Store activation and any live checkout need the owner." },
    { id: "delivery", service: "Lemon Squeezy file delivery", purpose: "Deliver the reviewed file (hash-matched)", status: "unconnected", owner_approval_required: true, shared_component: null, note: "Same account as checkout." },
    { id: "ledger", service: "FORGE ledger (Worker + D1)", purpose: `Signed sale webhooks and page beacons with vertical "${niche}"`, status: "unconnected", owner_approval_required: true, shared_component: "ledger-beacon", note: "Production Worker change." },
    { id: "email", service: "MailerLite", purpose: "Permission-based email capture and nurture", status: "unconnected", owner_approval_required: true, shared_component: "email-capture", note: "Connector connection is the owner's." },
    { id: "search-console", service: "Google Search Console", purpose: "Indexing and query data", status: "unconnected", owner_approval_required: true, shared_component: null, note: "Needs the owner's Google account." },
    { id: "hosting", service: "Cloudflare Pages", purpose: "Staging previews; production only on owner approval", status: "unconnected", owner_approval_required: true, shared_component: null, note: "Staging preview is allowed; production deploy is not." },
  ];
  for (const ch of channels) {
    const svc = ch.integration_required;
    if (svc && !integrations.some((i) => i.service === svc || (svc === "Google Search Console" && i.id === "search-console") || (svc === "MailerLite" && i.id === "email"))) {
      integrations.push({ id: slug(svc), service: svc, purpose: `Publishing for ${ch.channel}`, status: "unconnected", owner_approval_required: true, shared_component: null, note: "Official API or platform-sanctioned method only." });
    }
  }

  // ---------- unknowns from the brief ----------
  if (brief.status !== "approved") unknowns.push({ field: "source_brief.status", statement: `Brief ${brief.version} is ${brief.status}; the research stage needs an independent B0 review.`, resolve_by: "Independent QA" });
  for (const q of brief.open_questions) unknowns.push({ field: "brief.open_questions", statement: q, resolve_by: "Owner or Intelligence" });
  if (opts.budgetCeilingCents == null) unknowns.push({ field: "budget.ceiling_cents", statement: "No budget ceiling set for this build.", resolve_by: "Owner" });

  const ownerApprovalIntegrations = integrations.filter((i) => i.owner_approval_required).map((i) => i.service);
  const ownerApprovalChannels = channels.filter((c) => c.owner_approval_required && c.priority === "launch").map((c) => c.channel);
  const createdAt = opts.createdAt ?? brief.updated_at;

  const bp: LaunchBlueprint = {
    schema_version: BLUEPRINT_SCHEMA_VERSION,
    blueprint_id: `bp_${niche}_v${version.replace(/\./g, "-")}`,
    niche, display_name: brief.display_name ?? niche, version, supersedes: opts.supersedes ?? null,
    status: "draft", implementation_status: "PROPOSED", created_at: createdAt, approved_by: null,
    generated_by: { tool: "@forge/builder", tool_version: GENERATOR_VERSION, deterministic: true },
    business_kind: newBusiness ? "new_business" : "existing_niche",
    source_brief: { brief_id: brief.brief_id, version: brief.version, status: brief.status, content_hash: await contentHash(brief) },
    opportunity_ref: opts.opportunity ?? null,
    launch_policy: {
      auto_launch: false,
      owner_approval_required_for: [
        ...(newBusiness ? ["Selecting this opportunity", "Blueprint, budget ceiling and authorization boundaries"] : []),
        "Production deploy and launch", "New accounts and credential connections", "Live checkout", "Any spend", "Price changes", "Publishing outside approved campaigns",
      ],
    },
    go_hold: { call, subject: brief.summary.go_hold.subject ?? null, rationale: brief.summary.go_hold.rationale, falsifying_test: brief.summary.go_hold.falsifying_test },
    positioning: {
      one_line: brief.summary.one_line, primary_segment_id: primary,
      segments: brief.audience.segments.map((s) => ({ id: s.id, name: s.name, priority: s.priority })),
      desired_outcomes: outcomes.map(ref),
    },
    offer_ladder: ladder,
    products,
    brand: {
      direction: (brief.audience.visual_and_trust_preferences ?? []).map(ref),
      requirements: [
        "Designed for this audience, distinct from the other FORGE niches; no generic AI layout",
        "Licensed or original imagery only, each asset recorded in SOURCES_AND_LICENSES.md",
        "Accessible type and contrast (WCAG 2.2 AA); readable at 320 px",
        "Real product previews rendered from the actual files",
        "Products styled to the same standard as the site that sells them",
      ],
      asset_rights_policy: "Unknown provenance is a G8 FAIL. No asset ships without source URL, author, licence, commercial-use terms and attribution recorded.",
      status: "PROPOSED",
    },
    sales_framework: {
      promise: { draft: promiseBasis[0]?.statement ?? "", basis: promiseBasis.map(ref) },
      pain: pains.map(ref),
      proof: {
        allowed_kinds: ["Previews rendered from the real product files", "Worked example with clearly labelled sample data", "Verified facts from the brief, cited", "Customer feedback only once it exists, with permission"],
        items: proofCandidates.map(ref),
        status: proofCandidates.length ? "has_candidates" : "needs_genuine_proof",
        rule: "No testimonials, ratings, sales counts, user numbers or results until they exist and are verified.",
      },
      plan: core ? [
        `Get the ${core.name}${core.price.value != null ? ` for $${core.price.value}` : ""}`,
        "Download it straight from the confirmation email",
        core.must_include[0] ? `Start with: ${core.must_include[0]}` : "Follow the one-page quick start",
      ] : ["Use the free tools", "Join the email list for new resources"],
      picture: { draft: pictureBasis[0]?.statement ?? "", basis: pictureBasis.map(ref) },
      cta: { label: core ? `Get the ${core.name}` : "Try the free tools", product_id: core?.product_id ?? null },
      objections: brief.objections.slice().sort(byEvidence).map((c) => ({ claim: ref(c), response: null })),
      customer_language: (brief.audience.customer_language ?? []).map((l) => l.phrase),
    },
    page_map: pages,
    channel_plan: channels,
    integrations,
    measurement: {
      ledger_vertical: niche, beacon_path_prefix: `/${niche}/`,
      kpis: [
        { id: "product_page_sessions", label: "Sessions on the core product page", target: null, unit: "count", state: "unknown" },
        { id: "conversion_rate", label: "Product page to purchase", target: null, unit: "pct", state: "unknown" },
        { id: "orders", label: "Verified live orders (excludes test and owner-test)", target: null, unit: "count", state: "unknown" },
        { id: "gross_revenue", label: "Verified gross revenue", target: null, unit: "usd", state: "unknown" },
        { id: "refund_rate", label: "Refunds as share of orders", target: null, unit: "pct", state: "unknown" },
        { id: "email_signups", label: "Confirmed email signups", target: null, unit: "count", state: "unknown" },
        { id: "contribution", label: "Estimated contribution (withheld while any cost line is unknown)", target: null, unit: "usd", state: "unknown" },
      ],
      falsifying_tests: [brief.summary.go_hold.falsifying_test, ...(rec.falsifying_test ? [rec.falsifying_test] : [])],
    },
    economics: { note: `Scenarios copied from brief ${brief.version}. They are hypotheses with the brief's evidence labels, not forecasts.`, scenarios: brief.economics?.scenarios ?? null },
    budget: { ceiling_cents: opts.budgetCeilingCents ?? null, state: opts.budgetCeilingCents == null ? "owner_to_set" : "set", spend_authorized: false },
    permissions: {
      allowed: ["Local development and tests", "Generating product files and previews", "Staging preview deploys", "Draft content and copy", "Test-mode checkout once the owner has connected the account", "Writing FORGE database records for this build"],
      requires_owner_approval: ["Production deploy or launch", "New accounts or credential connections", "Any purchase or subscription", "Turning on live checkout", "Price changes", "Publishing outside approved campaigns", "Changes to customer data or permissions"],
      prohibited: ["Fabricated testimonials, reviews, sales counts or results", "Unlicensed images, fonts or text", "Copying another designer's or competitor's work", "Spam, purchased lists or prohibited scraping", "Storing secrets in the repo or dashboard", "Writing sales rows to the ledger", "Touching businesses outside FORGE"],
    },
    stages: stagePlans({ newBusiness, products, ownerApprovalIntegrations, ownerApprovalChannels }),
    done_criteria: [
      "Every required page passes its gates on a staging preview",
      "Every paid product passes G4 and its delivered file hash equals the reviewed file",
      "A test-mode purchase reaches the ledger with the right vertical, sends the delivery email, and the file opens; refund recorded",
      "Measurement live: beacons and sales attributed to this niche",
      "At least one launch channel prepared with receipts and a heartbeat-covered schedule",
      "All launch_readiness gates PASS with independent receipts",
      "Owner has explicitly approved the launch",
    ],
    unknowns,
    changelog: [{ version, date: createdAt.slice(0, 10), change: opts.changelog ?? `Generated from ${brief.brief_id} (${brief.version}).` }],
  };
  return bp;
}
