/**
 * Customer lifecycle copy for the three live sites, kept in code so it goes through the same claims check as every
 * other piece of FORGE copy and is versioned with the engine.
 *
 *  - welcome:       MailerLite automation, triggered when a subscriber joins the site's signup group
 *                   (groups and double opt-in forms are owned by the live-dollar workstream). Created in MailerLite
 *                   as a DRAFT that stays off until the owner turns it on.
 *  - post_purchase: Lemon Squeezy text (receipt note and follow-up). Buyers are NOT added to MailerLite in
 *                   milestone 1 (live-dollar decision, 2026-11-10), so these are never MailerLite automations.
 *
 * Rules every email must pass (see lintSequence): claims lint with the niche's real prices only, https links on the
 * niche's own site, no placeholder text, and an offer email only for a product that exists and is buyable.
 */
import { claimsLint } from "../handlers/content.ts";

export type Block = { type: "heading" | "paragraph"; text: string } | { type: "button"; text: string; url: string };
export interface LifecycleEmail { ref: string; delayDays: number; subject: string; preheader: string; blocks: Block[]; requiresCheckoutLive?: boolean }
export interface Sequence {
  id: string; nicheId: string; kind: "welcome" | "post_purchase"; name: string; site: string;
  /** welcome: MailerLite group the form adds people to. post_purchase: where the text goes. */
  trigger: { mailerliteGroupId?: string; mailerliteGroupName?: string; lemonSqueezyProduct?: string };
  /** The draft automation created in MailerLite (off until the owner enables it). */
  mailerliteAutomationId?: string;
  status: "draft"; notes: string; emails: LifecycleEmail[];
}

const QPK = "https://quiltplankit.pages.dev";
const BID = "https://bidline.pages.dev";
const LOAF = "https://loaf-ledger.pages.dev";
const p = (text: string): Block => ({ type: "paragraph", text });
const h = (text: string): Block => ({ type: "heading", text });
const b = (text: string, url: string): Block => ({ type: "button", text, url });

export const SEQUENCES: Sequence[] = [
  {
    id: "LC-QPK-WELCOME", mailerliteAutomationId: "203721958159811713", nicheId: "quilt-plan-kit", kind: "welcome", name: "FORGE · Quilt Plan Kit · Welcome", site: QPK, status: "draft",
    trigger: { mailerliteGroupId: "203436416693176152", mailerliteGroupName: "Quilt Math Cheat Sheet" },
    notes: "Email 1 delivers the cheat sheet the form promises. Email 3 mentions the paid planner, so it must stay off until live checkout is on.",
    emails: [
      { ref: "welcome", delayDays: 0, subject: "Your Quilt Math Cheat Sheet", preheader: "The download link is inside.",
        blocks: [h("Here's your cheat sheet"), p("Thanks for signing up. Here is the Quilt Math Cheat Sheet you asked for. It's a PDF you can print and keep next to your cutting mat."),
          b("Download the cheat sheet", `${QPK}/downloads/quilt-math-cheat-sheet.pdf`),
          p("When you want the numbers worked out for a specific quilt, the free calculators on the site do the arithmetic for binding and precuts."),
          p("Reply to this email any time if something on the sheet is unclear.")] },
      { ref: "binding", delayDays: 2, subject: "A binding check before you cut", preheader: "Two minutes now saves a short strip later.",
        blocks: [h("Measure the quilt, then cut the binding"), p("Binding is easy to come up short on. Measure your finished quilt top, add the four sides together, then add extra for mitred corners and for joining the strips."),
          p("The binding calculator works that sum out for you."),
          b("Open the binding calculator", `${QPK}/calculators/binding`)] },
      { ref: "planner", delayDays: 4, requiresCheckoutLive: true, subject: "Plan the whole quilt on paper first", preheader: "A printable planner for your next project.",
        blocks: [h("The Quilt Planner"), p("If you like working a quilt out before you buy fabric, the Quilt Planner is a printable PDF for doing exactly that. It is $8."),
          b("See the Quilt Planner", `${QPK}/planner`), p("The calculators and the cheat sheet stay free either way.")] },
    ],
  },
  {
    id: "LC-BID-WELCOME", mailerliteAutomationId: "203722971884292051", nicheId: "bidline", kind: "welcome", name: "FORGE · Bidline · Welcome", site: BID, status: "draft",
    trigger: { mailerliteGroupId: "203717192087242239", mailerliteGroupName: "Bidline - Estimate Template" },
    notes: "Email 1 delivers the free template. Email 4 offers the Bidline Estimating Kit at $19 and must stay off until live checkout is on. Kit facts checked against build_kit.py (QA-011 P2-1).",
    emails: [
      { ref: "welcome", delayDays: 0, subject: "Your free estimate template", preheader: "Download link inside, plus one tip before your next bid.",
        blocks: [h("Here's your template"), p("Thanks for signing up. Here is the free Bidline estimate template. It opens in Excel and in Google Sheets."),
          b("Download the template", `${BID}/downloads/Bidline-Free-Estimate-Template.xlsx`),
          p("Before your next bid, try the free calculator on the site. It converts between markup and margin, so you can check a price before it goes on the quote.")] },
      { ref: "margin", delayDays: 2, subject: "Markup and margin are not the same number", preheader: "The mix-up that quietly shrinks a job's profit.",
        blocks: [h("Markup is on cost. Margin is on price."), p("Say a job costs you 100 and you mark it up by half. You charge 150. Your margin is 50 out of 150, which is one third, not one half."),
          p("If you set prices by markup but think in margin, every job earns less than you planned. Pick the margin you need first, then work back to the price."),
          b("Open the calculator", `${BID}/calculator`)] },
      { ref: "overhead", delayDays: 3, subject: "Put overhead into every estimate", preheader: "Rent, insurance and the truck belong in the price.",
        blocks: [h("Spread overhead across your jobs"), p("Add up a year of overhead: insurance, vehicle, phone, software, office time. Divide it by a year of direct job costs and you have an overhead percentage to add to every estimate. Divide it by the hours you bill in a year and you have overhead per billable hour."),
          p("Skip it, and part of every hour you bill pays for overhead instead of you."),
          p("Reply and tell me your trade. It helps us decide what to write about next.")] },
      { ref: "kit", delayDays: 3, requiresCheckoutLive: true, subject: "The Bidline Estimating Kit", preheader: "Overhead, price book, quote and job costing in one workbook.",
        blocks: [h("The Bidline Estimating Kit"), p("The free template gets an estimate onto paper. The kit adds an overhead calculator, a price book of your own unit costs, a markup and margin converter with a target-margin check, a one-page client quote, a job cost tracker for budget versus actual, and a change order log. It opens in Excel and imports into Google Sheets. It is $19."),
          b("See the kit", `${BID}/#kit`)] },
    ],
  },
  {
    id: "LC-LOAF-WELCOME", mailerliteAutomationId: "203721986573075969", nicheId: "loaf-ledger", kind: "welcome", name: "FORGE · Loaf Ledger · Welcome", site: LOAF, status: "draft",
    trigger: { mailerliteGroupId: "203717192705902160", mailerliteGroupName: "Loaf Ledger - Pricing Tips" },
    notes: "No lead magnet and no paid product yet, so there is no offer email. Add one only when the workbook exists and checkout is live.",
    emails: [
      { ref: "welcome", delayDays: 0, subject: "Welcome to Loaf Ledger pricing tips", preheader: "Short, practical notes on pricing what you bake.",
        blocks: [h("Thanks for signing up"), p("You'll get a short note every few days on pricing bread for markets and pre-orders: costing a loaf, counting the hidden costs, and paying yourself for your time."),
          p("In the meantime, the loaf cost calculator on the site works out what one loaf costs you to make."),
          b("Open the loaf cost calculator", `${LOAF}/`)] },
      { ref: "grams", delayDays: 3, subject: "Cost a loaf by the gram", preheader: "A simple, precise way to cost a recipe.",
        blocks: [h("Work in grams, not cups"), p("Write down what you paid for each ingredient and the size of the bag in grams. Divide one by the other and you have a cost per gram. Multiply by the grams in your recipe and add the lines up."),
          p("Do it once per recipe and keep the numbers. When flour goes up, you only change one line.")] },
      { ref: "hourly", delayDays: 4, subject: "What are you paying yourself per hour?", preheader: "Ingredients are only part of the price.",
        blocks: [h("Count everything, then your time"), p("After ingredients, add packaging, labels, your market stall fee spread across the loaves you sell, and the drive there and back."),
          p("Take what is left from the price of a loaf, multiply by loaves sold, and divide by the hours you spent baking and selling. That is what you are paying yourself per hour. If the number surprises you, it is worth revisiting your prices."),
          p("Cottage food rules differ by state, so check your state's rules before selling.")] },
    ],
  },
  {
    id: "LC-QPK-PURCHASE", nicheId: "quilt-plan-kit", kind: "post_purchase", name: "Quilt Planner · receipt note and follow-up", site: QPK, status: "draft",
    trigger: { lemonSqueezyProduct: "Quilt Planner PDF" },
    notes: "For Lemon Squeezy: email 1 goes in the product's receipt/confirmation text; email 2 is a follow-up sent from Lemon Squeezy if enabled. Buyers are not added to MailerLite.",
    emails: [
      { ref: "receipt", delayDays: 0, subject: "Your Quilt Planner", preheader: "Download and printing tips.",
        blocks: [h("Thanks for your order"), p("Your download link is above. For the cleanest pages, print at actual size rather than fit to page, on Letter or A4."),
          p("If anything is wrong with the file, reply to this email and we'll sort it out. The refund policy is on the site."),
          b("Refund policy", `${QPK}/refunds.html`)] },
      { ref: "followup", delayDays: 7, subject: "How is the plan coming along?", preheader: "One question, if you have a minute.",
        blocks: [p("You picked up the Quilt Planner a week ago. If you have a minute, reply and tell me what you're making and whether anything in the planner got in your way. Every reply is read and helps decide what gets improved.")] },
    ],
  },
  {
    id: "LC-BID-PURCHASE", nicheId: "bidline", kind: "post_purchase", name: "Bidline Estimating Kit · receipt note and follow-up", site: BID, status: "draft",
    trigger: { lemonSqueezyProduct: "The Bidline Estimating Kit" },
    notes: "For Lemon Squeezy receipt text and an optional follow-up. Buyers are not added to MailerLite.",
    emails: [
      { ref: "receipt", delayDays: 0, subject: "Your Bidline kit: where to start", preheader: "Three tabs to fill in first.",
        blocks: [h("Thanks for your order"), p("Your download link is above. The workbook opens in Excel and imports into Google Sheets (File, Import, Upload)."),
          p("Start in this order: Settings (your business details for the quote), then the Overhead Calculator (a year of overhead gives you the percentage to use), then the Price Book (your usual unit costs), then a first Estimate. The Worked Sample tab shows a finished job if you want to see where you're heading."),
          p("Reply to this email if anything doesn't open or doesn't add up.")] },
      { ref: "followup", delayDays: 10, subject: "After your first job: budget versus actual", preheader: "The tab that makes the next bid better.",
        blocks: [p("Once your first job priced with the kit is under way, fill in the Job Cost Tracker with what each line really cost. It shows budget versus actual and your projected profit, so you can see where the estimate missed and update your Price Book before the next bid."),
          p("If you have a minute, reply and tell me your trade and what you'd like the kit to do that it doesn't yet.")] },
    ],
  },
];

const PLACEHOLDER = /\b(lorem|ipsum|TODO|TBD|XXX|\[[^\]]*\])/i;

/** Problems with a sequence; empty means it passes. `prices` are the niche's real product prices in cents. */
export function lintSequence(seq: Sequence, prices: number[], opts: { checkoutLive?: boolean } = {}): string[] {
  const out: string[] = []; const origin = new URL(seq.site).origin;
  if (seq.kind === "welcome" && !seq.trigger.mailerliteGroupId) out.push(`${seq.id}: welcome sequence has no MailerLite group`);
  seq.emails.forEach((e, i) => {
    const where = `${seq.id}/${e.ref}`;
    const text = [e.subject, e.preheader, ...e.blocks.map((x) => x.text)].join("\n");
    for (const why of claimsLint(text, prices)) out.push(`${where}: ${why}`);
    if (PLACEHOLDER.test(text)) out.push(`${where}: placeholder text`);
    if (e.subject.length > 70) out.push(`${where}: subject over 70 characters`);
    if (!Number.isInteger(e.delayDays) || e.delayDays < 0 || e.delayDays > 30) out.push(`${where}: delay must be 0..30 days`);
    if (i === 0 && seq.kind === "welcome" && e.delayDays !== 0) out.push(`${where}: first welcome email must send immediately`);
    for (const x of e.blocks) if (x.type === "button") {
      let u: URL | null = null; try { u = new URL(x.url); } catch { /* invalid */ }
      if (!u || u.protocol !== "https:" || u.origin !== origin) out.push(`${where}: link ${x.url} is not on ${origin}`);
    }
    if (e.requiresCheckoutLive && opts.checkoutLive === false) out.push(`${where}: offer email while checkout is not live`);
  });
  return out;
}

/** The plan MailerLite's automation builder takes. Emails that need live checkout are left out unless it is live. */
export function mailerLitePlan(seq: Sequence, opts: { checkoutLive: boolean }) {
  if (seq.kind !== "welcome" || !seq.trigger.mailerliteGroupId) throw new Error(`${seq.id} is not a MailerLite welcome sequence`);
  const emails = seq.emails.filter((e) => opts.checkoutLive || !e.requiresCheckoutLive);
  const workflow: Record<string, unknown>[] = [];
  emails.forEach((e, i) => {
    if (i > 0 && e.delayDays > 0) workflow.push({ type: "delay", data: { unit: "days", value: e.delayDays } });
    workflow.push({ type: "email", data: { ref: e.ref, subject: e.subject, preheader: e.preheader, blocks: e.blocks } });
  });
  return { name: seq.name, triggers: [{ type: "subscriber_joins_group", group_ids: [seq.trigger.mailerliteGroupId] /* string: these ids exceed 2^53 */ }], trigger_data: { repeatable: false }, workflow };
}

/** Plain text for pasting into Lemon Squeezy (post-purchase) or for owner review. */
export function sequenceText(seq: Sequence): string {
  return seq.emails.map((e) => [`Subject: ${e.subject}`, `Preheader: ${e.preheader}`, `Send: ${e.delayDays === 0 ? "immediately" : `${e.delayDays} day(s) after the previous email`}${e.requiresCheckoutLive ? " (only once checkout is live)" : ""}`, "",
    ...e.blocks.map((x) => (x.type === "button" ? `[${x.text}] ${x.url}` : x.type === "heading" ? x.text.toUpperCase() : x.text)), ""].join("\n")).join("\n---\n\n");
}
