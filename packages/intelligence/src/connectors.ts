/**
 * Data sources the Scout can use, with their live state. Rule: a source that needs a credential, an account, money or
 * scraping a site that disallows it stays unconnected, and the brief says what it would add instead of estimating.
 */
export type ConnectorStatus = "connected" | "unconnected" | "blocked" | "requires_paid_access" | "requires_owner_account" | "not_applicable";
export interface ConnectorState { id: string; name: string; status: ConnectorStatus; cost: string; would_add: string; blocked_reason?: string }

export function connectorStates(env: Record<string, unknown> = {}): ConnectorState[] {
  const has = (k: string) => typeof env[k] === "string" && (env[k] as string).length > 0;
  return [
    { id: "source_recheck", name: "Cited-source re-check (HTTP GET of every source)", status: "connected", cost: "free",
      would_add: "Confirms each cited page still exists and still shows the quoted figure; failed sources downgrade their claims." },
    { id: "wikimedia_pageviews", name: "Wikimedia pageviews API (monthly, en.wikipedia)", status: "connected", cost: "free, no key",
      would_add: "Five-year monthly interest proxy and seasonality for topic articles. A proxy, never search volume." },
    { id: "google_trends", name: "Google Trends (5-year relative interest)", status: "blocked", cost: "free",
      would_add: "Search-interest seasonality and rising queries; sets publish-by dates.",
      blocked_reason: "No official API, and trends.google.com disallows automated access, so FORGE does not scrape it. A CSV exported by the owner can be attached to a pack." },
    { id: "google_autocomplete", name: "Google search autocomplete", status: "blocked", cost: "free",
      would_add: "Long-tail question phrasing.", blocked_reason: "No sanctioned API." },
    { id: "keyword_planner", name: "Google Ads Keyword Planner", status: has("GOOGLE_ADS_DEVELOPER_TOKEN") ? "connected" : "requires_owner_account", cost: "free with a Google Ads account (no spend)",
      would_add: "Monthly search-volume ranges and competition per keyword (labelled ESTIMATED)." },
    { id: "search_console", name: "Google Search Console", status: has("GSC_SERVICE_ACCOUNT_JSON") ? "connected" : "requires_owner_account", cost: "free",
      would_add: "First-party queries, impressions and clicks for the existing sites." },
    { id: "etsy_open_api", name: "Etsy Open API", status: "requires_owner_account", cost: "free developer account",
      would_add: "Systematic listing prices, review counts and favourites. Until then, individual listing pages are cited and re-checked." },
    { id: "reddit_api", name: "Reddit API", status: "requires_owner_account", cost: "free tier", would_add: "Systematic customer-language mining." },
    { id: "amazon_pinterest", name: "Amazon bestseller ranks and Pinterest Trends", status: "blocked", cost: "free",
      would_add: "Book demand proxies and visual-niche seasonality.", blocked_reason: "Automated access disallowed; Pinterest Trends needs a business login." },
    { id: "semrush_similarweb", name: "Semrush / Similarweb / Ahrefs", status: "requires_paid_access", cost: "paid, about $100+/month; not in budget",
      would_add: "Third-party competitor traffic and keyword difficulty (would be labelled ESTIMATED)." },
  ];
}

export const unconnectedNames = (states: ConnectorState[]): string[] => states.filter((s) => s.status !== "connected").map((s) => s.name);

/** The brief.schema.json data_connectors shape. */
export const asBriefConnectors = (states: ConnectorState[]) =>
  states.map((s) => ({ name: s.name, status: s.status, cost: s.cost, would_add: s.would_add, ...(s.blocked_reason ? { blocked_reason: s.blocked_reason } : {}) }));
