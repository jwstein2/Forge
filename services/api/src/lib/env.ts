/** Worker bindings and configuration. Secrets are bindings only; they are never logged or returned. */
export interface Env {
  DB: D1Database;                       // FORGE platform database (never the live sales ledger)
  LEDGER_DB?: D1Database;               // OPTIONAL read-only binding to the live sales ledger (staging, owner-approved only)
  LEDGER_ACCOUNT_ID?: string;           // with LEDGER_API_TOKEN: read the ledger over the D1 REST API
  LEDGER_DATABASE_ID?: string;
  LEDGER_API_TOKEN?: string;            // Cloudflare API token limited to "Account · D1 · Read". Preferred over LEDGER_DB.
  SELF?: Fetcher;                       // service binding to this same Worker: each cron job runs in its own invocation (free-plan limits are per invocation)
  ENVIRONMENT: "development" | "staging" | "production" | "test";
  OWNER_EMAILS: string;                 // comma-separated allowlist
  ACCESS_TEAM_DOMAIN?: string;          // e.g. https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string;                  // Cloudflare Access application audience tag
  DEV_AUTH_TOKEN?: string;              // development only; refused in any other environment
  HEARTBEAT_SECRET?: string;            // shared secret for signed run heartbeats (n8n → FORGE)
  N8N_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;           // OPTIONAL. Operator copy drafting only; unset = drafting idle. Needs owner approval.
  MAILERLITE_API_KEY?: string;          // OPTIONAL. Operator lifecycle watch, read-only GETs; unset = "unconnected". Worker secret only with owner approval.
  OPERATOR_MODEL?: string;              // OPTIONAL model id override for Operator drafting.
  N8N_API_KEY?: string;                 // FORGE-scoped, read-only. Unset = n8n live source unconnected.
}
