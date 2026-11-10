/**
 * Plan for making the existing n8n workflows report every run to FORGE (POST /api/v1/ingest/heartbeat, scheme v2).
 * PREPARED, NOT APPLIED: live n8n edits belong to the live-dollar workstream and need the owner's go-ahead.
 *
 * Shape: one shared sub-workflow "FORGE · Send heartbeat" does the signing and the POST. Each reporting workflow gets
 *  - one "Report run to FORGE" Execute Workflow node (wait for completion: off) attached after its last main-path
 *    node, so a heartbeat is sent even when the IF branch sends no email, and
 *  - settings.errorWorkflow = "FORGE · Heartbeat on failure", which posts status "failed" for any run that errors.
 * The secret lives in the existing forge_config data table (key heartbeat_secret), like the sale-forward secret.
 * Read from n8n on 2026-11-10 (workflow ids, node names, triggers).
 */
export interface HeartbeatTarget { registryId: string; workflowId: string; workflowName: string; attachAfter: string[]; trigger: string; note?: string }

export const HEARTBEAT_PLAN: { targets: HeartbeatTarget[]; excluded: { workflowId: string; name: string; why: string }[]; prerequisites: string[] } = {
  targets: [
    { registryId: "N8N-01", workflowId: "vWIlDu4JdcAjcmkr", workflowName: "FORGE · Sales alerts and weekly per-niche report", trigger: "webhook (sale forward) + daily 08:00",
      attachAfter: ["Respond 200", "Respond 401", "Build per-niche report"],
      note: "Two triggers: the webhook path reports after its Respond node (a 401 is a successful run that refused an unsigned call); the daily path reports after the report is built, before the IF that decides whether to email. Registry name is still 'QPK · Sales log and daily report'; the platform should rename it." },
    { registryId: "N8N-02", workflowId: "iWvwx0VDj7cFzAYy", workflowName: "QPK · Health check", trigger: "every 3 h at :07", attachAfter: ["Find failures"],
      note: "Attach before 'Anything down?' so a run with no outage still reports. Overlaps OPS-SITE-HEALTH; retire one of the two once FORGE's check is trusted on staging." },
    { registryId: "N8N-03", workflowId: "e4625vttrQGtDSnL", workflowName: "QPK · Pinterest pin tracker", trigger: "every 6 h at :23", attachAfter: ["Save to qpk_published_pins"],
      note: "The save node runs once per pin and not at all when the feed has no new pins, so attach after 'Parse pins' with Execute Once on, or set alwaysOutputData on the save node." },
    { registryId: "N8N-04", workflowId: "e4v1Qjmu8gqt8ugu", workflowName: "QPK · Lemon Squeezy status watch", trigger: "daily 07:30", attachAfter: ["Checkout probe row"],
      note: "Two parallel branches; the checkout probe branch always produces one row, so attach there. Planned for retirement once the store is activated." },
    { registryId: "N8N-05", workflowId: "Jgnze2IjwqEvqbVT", workflowName: "Portfolio · Monthly brand & UX audit", trigger: "monthly, 1st 14:17", attachAfter: ["Build audit report"] },
  ],
  excluded: [
    { workflowId: "30AmEXGxHMD4E5d9", name: "FORGE · One-time secret bootstrap", why: "One-time, deactivated after use." },
    { workflowId: "(10 workflows)", name: "SCC · * and Z3D Project Advisor *", why: "Not FORGE businesses and not in the FORGE registry. Leave them alone unless the owner adds them." },
  ],
  prerequisites: [
    "Owner approval to edit the five live workflows (live n8n change).",
    "A HEARTBEAT_SECRET of 32+ characters set on the FORGE Worker for the target environment, and the same value stored once in n8n forge_config as heartbeat_secret (through the existing one-time bootstrap pattern, never pasted in chat).",
    "BLOCKED until James approves: n8n cloud cannot reach /api/v1/ingest/heartbeat today (staging Access answers with a 302 to its login). Recommended: an Access service token with a Service Auth policy; n8n then also sends CF-Access-Client-Id and CF-Access-Client-Secret, stored in forge_config like the other secrets (docs/STAGING.md). Alternative: a Bypass policy on /api/v1/ingest/* behind the HMAC check.",
    "forge_config key forge_api_base = the FORGE API origin for that environment.",
  ],
};

/** Code for the shared sub-workflow's Code node. n8n's Code node allows require('crypto') on n8n cloud. */
export const SEND_HEARTBEAT_CODE = `// Inputs (from Execute Workflow): registryId, status ('success'|'failed'), startedAt, externalId, error?
// The previous node read forge_config rows heartbeat_secret and forge_api_base.
const cfg = Object.fromEntries($('Get FORGE config').all().map(i => [i.json.key, i.json.value]));
const input = $('When called by another workflow').first().json;
const body = JSON.stringify({ registryId: input.registryId, startedAt: input.startedAt, finishedAt: new Date().toISOString(),
  status: input.status || 'success', externalId: String(input.externalId), error: input.error ? String(input.error).slice(0, 500) : undefined });
const ts = String(Math.floor(Date.now() / 1000));
if (!cfg.heartbeat_secret || String(cfg.heartbeat_secret).length < 32 || !cfg.forge_api_base) return [{ json: { skipped: true, reason: 'heartbeat not configured' } }];
const sig = 'v2=' + require('crypto').createHmac('sha256', cfg.heartbeat_secret).update(ts + '.' + body).digest('hex');
return [{ json: { url: cfg.forge_api_base.replace(/\\/$/, '') + '/api/v1/ingest/heartbeat', body, ts, sig } }];
// Next: HTTP Request POST {{$json.url}}, headers X-Forge-Timestamp {{$json.ts}} and X-Forge-Signature {{$json.sig}},
// raw JSON body {{$json.body}}, "Never error" on, so a FORGE outage can never fail the business workflow.`;

/** Inputs each reporting workflow passes to the sub-workflow. */
export const REPORT_NODE_INPUTS = `registryId: "<N8N-0x>", status: "success", startedAt: {{ $execution.startedAt ?? $now.toISO() }}, externalId: {{ $execution.id }}`;
/** The error workflow maps the failed workflow id to its registry id. */
export const ERROR_WORKFLOW_CODE = `const map = ${"{"} vWIlDu4JdcAjcmkr: 'N8N-01', iWvwx0VDj7cFzAYy: 'N8N-02', e4625vttrQGtDSnL: 'N8N-03', e4v1Qjmu8gqt8ugu: 'N8N-04', Jgnze2IjwqEvqbVT: 'N8N-05' ${"}"};
const e = $input.first().json; // Error Trigger output
const registryId = map[e.workflow && e.workflow.id];
if (!registryId) return [];
return [{ json: { registryId, status: 'failed', startedAt: (e.execution && e.execution.startedAt) || new Date().toISOString(), externalId: String(e.execution && e.execution.id), error: e.execution && e.execution.error && e.execution.error.message } }];`;
