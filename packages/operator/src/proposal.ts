/**
 * One-decision publishing proposal: a recommended boundary for every channel, which the owner accepts (or not) in a
 * single decision instead of approving items one by one. Applying it writes ONE owner approval row that covers every
 * channel's boundary, sets each channel's policy, and expires after 90 days (the API's standing cap).
 *
 * What the boundary does and does not allow:
 *  - 'standing' lets FORGE treat drafts that pass the claims check as approved, up to the daily cap, inside the window.
 *  - It never connects a live publisher. Every channel keeps publisher 'dry_run' (or 'manual') until the owner
 *    separately approves a live connection (Pinterest API, MailerLite sending, site deploys).
 */
export const PROPOSAL_VERSION = "2026-11-10.1";
export const WINDOW_DAYS = 90;

export interface ChannelRow { id: string; niche_id: string; platform: string; status: string }
export interface ProposedPolicy { channelId: string; nicheId: string; platform: string; mode: "off" | "draft_only" | "approval_each" | "standing"; publisher: "dry_run" | "manual"; dailyCap: number; why: string; liveConnectionNeeded: string }

export function proposeFor(c: ChannelRow): ProposedPolicy {
  const base = { channelId: c.id, nicheId: c.niche_id, platform: c.platform };
  switch (c.platform) {
    case "pinterest":
      return { ...base, mode: "standing", publisher: "dry_run", dailyCap: 1,
        why: "Pins are low-risk, already go out at one a day from the site feed, and every pin is claims-checked and then verified from Pinterest's own feed.",
        liveConnectionNeeded: "Pinterest API access, or continuing the site's RSS drip (a site deploy). Not part of this decision." };
    case "email":
      return { ...base, mode: "approval_each", publisher: "dry_run", dailyCap: 1,
        why: "An email to subscribers can't be taken back, so each campaign is approved, but in one weekly batch, never a daily queue.",
        liveConnectionNeeded: "MailerLite sending from FORGE (API key as a Worker secret). Not part of this decision." };
    case "seo":
      return { ...base, mode: "approval_each", publisher: "manual", dailyCap: 1,
        why: "Articles go onto the live site through its normal release gate, so each one is approved in the weekly batch.",
        liveConnectionNeeded: "None: articles are deployed by the site's own release process." };
    default:
      return { ...base, mode: "draft_only", publisher: "dry_run", dailyCap: 0, why: "No publishing path FORGE can verify yet.", liveConnectionNeeded: "Unknown." };
  }
}

export async function buildProposal(db: D1Database, now = new Date()) {
  const channels = (await db.prepare(`SELECT c.id, c.niche_id, c.platform, c.status FROM channels c JOIN niches n ON n.id = c.niche_id WHERE n.paused = 0 ORDER BY c.niche_id, c.platform`).all<ChannelRow>()).results;
  const windowEnd = new Date(now.getTime() + WINDOW_DAYS * 86400000).toISOString();
  return {
    version: PROPOSAL_VERSION, windowEnd,
    summary: "One decision covers every channel below for 90 days. Pinterest pins that pass the claims check count as approved without asking you, up to one a day. Emails and SEO articles are approved in one weekly batch. Nothing goes live from this decision alone: each live connection is approved separately.",
    channels: channels.map(proposeFor),
  };
}
