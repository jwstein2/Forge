/**
 * The nine build stages (BUILD_STAGES in @forge/contracts) as reusable templates.
 * Gate ids follow audit/final/FORGE_RELEASE_GATES.md; B0/B1 are Builder review gates:
 *   B0 Research review: an independent reviewer accepts the brief as fit to build from.
 *   B1 Blueprint review: an independent reviewer accepts the blueprint (schema-valid, traceable, no fabricated proof).
 */
import type { BuildStage } from "@forge/contracts";
import type { GateId, ProductSpec, StagePlan } from "./types.ts";
import { PLAYBOOKS } from "./playbooks.ts";

export const ALL_RELEASE_GATES: GateId[] = ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8", "G9", "G10", "G11", "G12", "G13", "G14", "G15"];

interface Ctx { newBusiness: boolean; products: ProductSpec[]; ownerApprovalIntegrations: string[]; ownerApprovalChannels: string[] }

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
const tasks = (stage: BuildStage, list: [string, string, "deterministic" | "model" | "owner"][]) =>
  list.map(([title, role, kind], i) => ({ id: `${stage}-${i + 1}`, title, role, kind }));

export function stagePlans(ctx: Ctx): StagePlan[] {
  const productGates = uniq(ctx.products.flatMap((p) => p.gates)).filter((g) => g !== "B1");
  const productTasks = ctx.products.flatMap((p) => PLAYBOOKS[p.playbook].buildTasks.map((t) => `${p.name}: ${t}`));
  return [
    {
      stage: "research", goal: "Confirm the Audience & Market Brief is fit to build from.", depends_on: [],
      inputs: ["Audience & Market Brief (exact version and content hash)", "Opportunity record, if this build came from the Scout"],
      tasks: tasks("research", [
        ["Check every claim the blueprint relies on has an evidence label and a source", "Market & Opportunity Intelligence", "deterministic"],
        ["Independent research review of the brief", "Independent QA", "model"],
        ...(ctx.newBusiness ? [["Owner selects this opportunity", "Owner", "owner"] as [string, string, "owner"]] : []),
      ]),
      outputs: ["B0 gate receipt"], gates: ["B0"],
      owner_approvals: ctx.newBusiness ? ["Select this opportunity for a build"] : [],
    },
    {
      stage: "blueprint", goal: "Agree the complete plan: offer, products, brand, pages, channels, integrations, gates and budget.", depends_on: ["research"],
      inputs: ["B0 receipt", "This Launch Blueprint"],
      tasks: tasks("blueprint", [
        ["Generate blueprint deterministically from the brief", "Ecosystem Builder", "deterministic"],
        ["Validate against launch-blueprint.schema.json and semantic rules", "Ecosystem Builder", "deterministic"],
        ["Independent blueprint review", "Independent QA", "model"],
        ...(ctx.newBusiness ? [["Owner sets the budget ceiling and authorization boundaries", "Owner", "owner"] as [string, string, "owner"]] : []),
      ]),
      outputs: ["Approved blueprint version", "B1 gate receipt"], gates: ["B1"],
      owner_approvals: ctx.newBusiness ? ["Approve blueprint, budget ceiling and authorization boundaries"] : [],
    },
    {
      stage: "products", goal: "Build every paid and free product to its spec, reproducibly.", depends_on: ["blueprint"],
      inputs: ["Product specs in this blueprint", "Brand tokens once available"],
      tasks: tasks("products", [
        ...productTasks.map((t) => [t, "Product & Offer", "model"] as [string, string, "model"]),
        ["Record file hashes of reviewed deliverables", "Ecosystem Builder", "deterministic"],
        ["Independent product review (formulas, contents, file integrity)", "Independent QA", "model"],
      ]),
      outputs: ["Product files with hashes", "Previews rendered from the real files", "G4 receipts"],
      gates: productGates.length ? productGates : ["G4"], owner_approvals: [],
    },
    {
      stage: "brand", goal: "Create a distinctive, audience-specific brand system with licensed assets.", depends_on: ["blueprint"],
      inputs: ["Brand direction claims from the brief", "Customer language"],
      tasks: tasks("brand", [
        ["Propose 2 visual directions grounded in the brief", "Website, Brand & CX", "model"],
        ["Build tokens (type, colour, spacing) and component samples", "Website, Brand & CX", "model"],
        ["Record every asset in SOURCES_AND_LICENSES.md", "Website, Brand & CX", "deterministic"],
        ["Independent visual and licence review", "Independent QA", "model"],
      ]),
      outputs: ["Brand tokens", "Asset licence ledger", "G2 and G8 receipts"], gates: ["G2", "G8"], owner_approvals: [],
    },
    {
      stage: "website", goal: "Build every page in the page map on a staging preview.", depends_on: ["brand", "products"],
      inputs: ["Page map", "Sales framework", "Brand tokens", "Product previews"],
      tasks: tasks("website", [
        ["Build pages from the page map in the site template", "Website, Brand & CX", "model"],
        ["Write copy to the Promise, Pain, Proof, Plan, Picture framework using only genuine proof", "Website, Brand & CX", "model"],
        ["Technical SEO: canonical, sitemap, robots, JSON-LD", "Marketing & Distribution", "deterministic"],
        ["Deploy to a staging preview (no production)", "Ecosystem Builder", "deterministic"],
        ["Independent rendered-page review at 320, 390 and 1366 px", "Independent QA", "model"],
      ]),
      outputs: ["Staging preview URL", "Crawl report", "Screenshots", "Gate receipts"],
      gates: ["G1", "G2", "G3", "G8", "G9", "G12", "G15"], owner_approvals: [],
    },
    {
      stage: "integrations", goal: "Wire checkout, delivery, ledger, email and analytics in test mode.", depends_on: ["website"],
      inputs: ["Integration list", "Shared components: checkout button, email capture, ledger beacon"],
      tasks: tasks("integrations", [
        ["Place shared checkout, email and beacon components", "Business Operations, Finance & Infrastructure", "deterministic"],
        ["Run a test-mode purchase end to end (webhook, ledger row, delivery email, file opens, refund)", "Business Operations, Finance & Infrastructure", "deterministic"],
        ["Write legal pages with the owner's operator name and jurisdiction", "Website, Brand & CX", "model"],
        ...ctx.ownerApprovalIntegrations.map((i) => [`Owner connects or approves: ${i}`, "Owner", "owner"] as [string, string, "owner"]),
      ]),
      outputs: ["Test-mode order evidence", "Legal pages", "G5, G6, G7, G12 receipts"],
      gates: ["G5", "G6", "G7", "G12"], owner_approvals: ctx.ownerApprovalIntegrations,
    },
    {
      stage: "marketing", goal: "Prepare launch channels with owners, cadences, receipts and heartbeats.", depends_on: ["website"],
      inputs: ["Channel plan", "Seasonal windows from the brief"],
      tasks: tasks("marketing", [
        ["Prepare first content batch per launch channel from the brief", "Marketing & Distribution", "model"],
        ["Register each scheduled job with owner, cost cap, retry budget, kill switch", "Business Operations, Finance & Infrastructure", "deterministic"],
        ["Force one failure per job and confirm the watchdog raises an alert", "Independent QA", "deterministic"],
        ...ctx.ownerApprovalChannels.map((c) => [`Owner approves channel account or publishing: ${c}`, "Owner", "owner"] as [string, string, "owner"]),
      ]),
      outputs: ["Content batch", "Registry entries", "G10, G11, G14 receipts"],
      gates: ["G10", "G11", "G14"], owner_approvals: ctx.ownerApprovalChannels,
    },
    {
      stage: "testing", goal: "Prove the whole customer journey works on staging, from first visit to delivered file.", depends_on: ["integrations", "marketing"],
      inputs: ["Staging preview", "Test-mode checkout"],
      tasks: tasks("testing", [
        ["Full customer-journey walkthrough on phone and desktop", "Independent QA", "model"],
        ["Confirm the change is a reviewed commit with a documented rollback", "Independent QA", "deterministic"],
      ]),
      outputs: ["Journey evidence", "G1, G5, G13 receipts"], gates: ["G1", "G5", "G13"], owner_approvals: [],
    },
    {
      stage: "launch_readiness", goal: "Assemble every gate receipt and present the launch decision to the owner. FORGE never launches on its own.", depends_on: ["testing"],
      inputs: ["All gate receipts", "Owner test purchase and refund per product (tagged owner test)"],
      tasks: tasks("launch_readiness", [
        ["Compile the launch readiness report from receipts", "Ecosystem Builder", "deterministic"],
        ["Owner decides whether to launch", "Owner", "owner"],
      ]),
      outputs: ["Launch readiness report"], gates: ALL_RELEASE_GATES,
      owner_approvals: ["Production deploy and launch"],
    },
  ];
}
