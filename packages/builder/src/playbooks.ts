/**
 * Reusable playbooks: what a product of each format needs to be built, checked and sold.
 * Playbooks are deterministic templates. Model work (copy, design, content) happens inside the tasks they name,
 * and every output passes the independent gates listed here (FORGE_RELEASE_GATES.md).
 */
import type { Deliverable, GateId, PlaybookId } from "./types.ts";

export interface Playbook {
  id: PlaybookId;
  label: string;
  /** Can FORGE build this without a new external account? */
  needsOwnerAccount: string | null;
  deliverables: Deliverable[];
  gates: GateId[];
  pageTemplate: string;
  pageSections: string[];
  buildTasks: string[];
}

const PAID_GATES: GateId[] = ["G4", "G5", "G6", "G7", "G8", "G13"];

export const PLAYBOOKS: Record<PlaybookId, Playbook> = {
  "free-resource": {
    id: "free-resource", label: "Free calculator / guide / template (traffic and trust engine)", needsOwnerAccount: null,
    deliverables: [
      { kind: "calculator", file_format: "html+js", spec: "Embeddable calculator shell with documented test cases (≥5 input/output pairs)." },
      { kind: "guide", file_format: "html", spec: "Answer page that solves one job-to-be-done; claims sourced; JSON-LD where valid." },
    ],
    gates: ["G1", "G3", "G8", "G9"],
    pageTemplate: "resource",
    pageSections: ["tool", "how-to-use", "worked-example", "related-resources", "email-capture", "paid-upgrade-cta"],
    buildTasks: ["Write calculator test cases before code", "Build tool in the shared calculator shell", "Write the answer copy from the brief's jobs-to-be-done"],
  },
  "spreadsheet-template": {
    id: "spreadsheet-template", label: "Paid spreadsheet / workbook", needsOwnerAccount: null,
    deliverables: [
      { kind: "workbook", file_format: "xlsx", spec: "Styled to the brand; inputs unlocked, formulas protected; no macros; opens in Excel and Google Sheets without errors." },
      { kind: "quick-start", file_format: "pdf", spec: "One page: what it does, how to fill it in, where the answer appears." },
      { kind: "worked-example", file_format: "xlsx", spec: "Filled example using realistic, labelled sample inputs (never presented as a customer)." },
      { kind: "formula-test-cases", file_format: "json", spec: "≥5 known input/output cases checked by an independent reviewer (G4)." },
    ],
    gates: PAID_GATES,
    pageTemplate: "product",
    pageSections: ["promise", "pain", "proof", "plan", "picture", "whats-inside-previews", "price-and-cta", "faq-objections", "refund-policy-link"],
    buildTasks: ["Specify sheets and formulas from must_include", "Build workbook generator script (reproducible build)", "Write test cases and run them", "Render previews of real sheets for the sales page"],
  },
  "printable-pdf": {
    id: "printable-pdf", label: "Paid printable / PDF", needsOwnerAccount: null,
    deliverables: [
      { kind: "printable", file_format: "pdf", spec: "Print-tested at Letter and A4; page count and contents match the sales page; accessible type size for the audience." },
      { kind: "preview-images", file_format: "png", spec: "Real page renders for the sales page (no mock-ups of pages that do not exist)." },
    ],
    gates: PAID_GATES,
    pageTemplate: "product",
    pageSections: ["promise", "pain", "proof", "plan", "picture", "whats-inside-previews", "price-and-cta", "faq-objections", "refund-policy-link"],
    buildTasks: ["Outline pages from must_include", "Build reproducible PDF source (HTML/CSS or script)", "Print test", "Render previews"],
  },
  bundle: {
    id: "bundle", label: "Bundle of products (reused or built in this build)", needsOwnerAccount: null,
    deliverables: [
      { kind: "bundle-manifest", file_format: "json", spec: "Lists every component (existing products and any new item built for the bundle) with file hashes; every component passes G4 on its own." },
      { kind: "bundle-archive", file_format: "zip", spec: "Delivered archive equals the reviewed archive (hash match)." },
    ],
    gates: PAID_GATES,
    pageTemplate: "product",
    pageSections: ["promise", "pain", "proof", "plan", "picture", "whats-inside-previews", "price-and-cta", "faq-objections", "refund-policy-link"],
    buildTasks: ["Build components first", "Assemble archive with manifest and hashes", "Check bundle price against component prices"],
  },
  "kdp-book": {
    id: "kdp-book", label: "Amazon KDP paperback", needsOwnerAccount: "Amazon KDP (owner's account; publishing is a manual owner step)",
    deliverables: [
      { kind: "interior", file_format: "pdf", spec: "KDP trim and bleed spec; fonts embedded." },
      { kind: "cover", file_format: "pdf", spec: "Licensed or original artwork only; spine width from page count." },
    ],
    gates: ["G4", "G8", "G13"],
    pageTemplate: "book",
    pageSections: ["promise", "whats-inside-previews", "amazon-link"],
    buildTasks: ["Build interior from tested content", "Build cover", "Owner uploads to KDP"],
  },
  "affiliate-content": {
    id: "affiliate-content", label: "Affiliate recommendations inside useful content", needsOwnerAccount: "Each affiliate programme (owner applies)",
    deliverables: [{ kind: "recommendation-block", file_format: "html", spec: "Disclosed affiliate links placed where the user is about to buy; no fabricated reviews." }],
    gates: ["G8", "G9", "G10", "G14"],
    pageTemplate: "resource",
    pageSections: ["disclosure", "recommendations"],
    buildTasks: ["Owner joins programme", "Place disclosed links in the relevant resources"],
  },
  unsupported: {
    id: "unsupported", label: "Format FORGE does not build yet", needsOwnerAccount: null,
    deliverables: [],
    gates: ["B1"],
    pageTemplate: "none",
    pageSections: [],
    buildTasks: ["Needs a new playbook or an owner decision before it can be built"],
  },
};

const RULES: { playbook: PlaybookId; re: RegExp }[] = [
  { playbook: "kdp-book", re: /\b(kdp|paperback|hardcover|amazon book)\b/i },
  { playbook: "bundle", re: /\bbundle\b|\s\+\s/i },
  { playbook: "spreadsheet-template", re: /\b(workbook|spreadsheet|excel|google sheets|xlsx|price-book)\b/i },
  { playbook: "printable-pdf", re: /\b(pdf|printable|planner|label|sign pack|cheat sheet|pattern)\b/i },
  { playbook: "affiliate-content", re: /\baffiliate\b/i },
];

/** Classify an offer item into a playbook. Free tiers are always free resources. Unknown formats are never guessed. */
export function classifyPlaybook(text: string, tier: string, priceValue: number | null, opts: { formatHint?: string } = {}): PlaybookId {
  if (tier === "free" || priceValue === 0) return "free-resource";
  for (const r of RULES) if (r.re.test(text)) return r.playbook;
  // A format description lists the files in one product ("workbook + quick-start PDF"), so "+" there is not a bundle.
  if (opts.formatHint) for (const r of RULES) if (r.playbook !== "bundle" && r.re.test(opts.formatHint)) return r.playbook;
  return "unsupported";
}

/** Map the brief's monetization model enum to a playbook. */
export function playbookForModel(model: string): PlaybookId {
  switch (model) {
    case "spreadsheet_template": return "spreadsheet-template";
    case "printable": case "digital_download": return "printable-pdf";
    case "bundle": return "bundle";
    case "kdp_book": return "kdp-book";
    case "affiliate": return "affiliate-content";
    default: return "unsupported";
  }
}
