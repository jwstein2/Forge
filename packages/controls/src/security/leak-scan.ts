/**
 * Secret scanner core (gate G12 / audit S1). Stronger than the platform's starter scan:
 *  - provider-specific token shapes (Anthropic, OpenAI, GitHub, Stripe, Google, Slack, Cloudflare by name, JWT-style API keys);
 *  - credential-bearing URLs and bare n8n webhook URLs (an unauthenticated webhook URL is itself a capability);
 *  - sensitive file names that should never be tracked (.env, .dev.vars, *.pem, password-manager vaults…);
 *  - high-entropy values assigned to secret-looking names.
 * Matches are never printed: hits carry a redacted preview and a sha256 fingerprint used for allowlisting.
 */
import { createHash } from "node:crypto";

export type SecretSeverity = "critical" | "warning";
export interface SecretRule { id: string; label: string; re: RegExp; severity: SecretSeverity; group?: number }
export interface SecretHit { file: string; line: number; rule: string; label: string; severity: SecretSeverity; preview: string; fingerprint: string }

export const RULES: SecretRule[] = [
  { id: "private-key", label: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g, severity: "critical" },
  { id: "anthropic", label: "Anthropic API key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g, severity: "critical" },
  { id: "openai", label: "OpenAI API key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g, severity: "critical" },
  { id: "github", label: "GitHub token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g, severity: "critical" },
  { id: "aws", label: "AWS access key id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, severity: "critical" },
  { id: "stripe", label: "Stripe live key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, severity: "critical" },
  { id: "google-api", label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, severity: "critical" },
  { id: "google-oauth", label: "Google OAuth client secret", re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g, severity: "critical" },
  { id: "slack", label: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, severity: "critical" },
  { id: "jwt", label: "JWT-style API key (Lemon Squeezy, MailerLite, n8n use this shape)", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g, severity: "critical" },
  { id: "named-env", label: "credential assigned to a provider variable", re: /\b(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN|LEMONSQUEEZY_API_KEY|LS_API_KEY|LS_SIGNING_SECRET\w*|MAILERLITE_API_KEY|N8N_API_KEY|HEARTBEAT_SECRET|N8N_FORWARD_SECRET|REPORT_TOKEN|ANTHROPIC_API_KEY)\s*[:=]\s*["']?([^\s"'#]{12,})/g, severity: "critical", group: 1 },
  { id: "url-credentials", label: "credentials embedded in a URL", re: /\bhttps?:\/\/[^\s/:@"']+:[^\s/@"']{6,}@[^\s"']+/g, severity: "critical" },
  { id: "n8n-webhook", label: "n8n webhook URL (treat as a secret unless the workflow verifies a signature)", re: /\bhttps:\/\/[a-z0-9-]+\.app\.n8n\.cloud\/webhook(?:-test)?\/[A-Za-z0-9_\/-]+/g, severity: "warning" },
  { id: "assigned-literal", label: "secret-like literal", re: /\b(?:api[_-]?key|secret|password|passwd|token|auth)\w*["']?\s*[:=]\s*["']([A-Za-z0-9_\-+/=.]{16,})["']/gi, severity: "critical", group: 1 },
];

/** File paths that must never be tracked, whatever their content. */
export const SENSITIVE_FILES: { re: RegExp; label: string }[] = [
  { re: /(^|\/)\.env(\.[^/]*)?$/i, label: "dotenv file" },
  { re: /(^|\/)\.dev\.vars$/i, label: "wrangler local secrets" },
  { re: /\.(pem|key|p12|pfx)$/i, label: "key material" },
  { re: /(^|\/)id_(rsa|ed25519|ecdsa)$/i, label: "SSH private key" },
  { re: /\.(kdbx|1pux|opvault)$/i, label: "password-manager vault/export" },
  { re: /(^|\/)(credentials|secrets?|service[-_]account)[^/]*\.(json|txt|csv|ya?ml)$/i, label: "credential file" },
  { re: /(^|\/)\.data\/dev-token$/i, label: "local dev token" },
];

/** Values that look like placeholders, not secrets. */
const PLACEHOLDER = /^(x+|\*+|<[^>]+>|\$\{[^}]+\}|changeme|example|placeholder|redacted|test[-_]?secret.*|dummy.*|your[-_].*|replace[-_]?me|0+|(.)\2+)$/i;

/** Generic-rule values that announce themselves as fixtures. Provider-shaped tokens are never excused this way. */
const SAMPLE_WORD = /(test|example|dummy|fake|sample|placeholder|local|dev-only)/i;

export function entropy(s: string): number {
  const f = new Map<string, number>(); for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0; for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export const redact = (value: string) => `${value.slice(0, 4)}…(${value.length} chars)`;

export function scanText(file: string, text: string, allow: Set<string> = new Set()): SecretHit[] {
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => {
    if (ln.length > 20000) return; // minified bundles: skip pathological lines, scanned separately if needed
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (let m; (m = r.re.exec(ln)); ) {
        const value = (r.group ? m[r.group] : m[0]) ?? m[0];
        if (PLACEHOLDER.test(value)) continue;
        if ((r.id === "assigned-literal" || r.id === "named-env") && (SAMPLE_WORD.test(value) || value.includes("${") || value.includes("process.env") || value.includes("env."))) continue;
        if (r.id === "assigned-literal" && entropy(value) < 3.5) continue;
        const fp = fingerprint(value);
        if (allow.has(fp)) continue;
        hits.push({ file, line: i + 1, rule: r.id, label: r.label, severity: r.severity, preview: redact(value), fingerprint: fp });
      }
    }
  });
  return hits;
}

export function sensitiveFile(path: string): string | null {
  for (const s of SENSITIVE_FILES) if (s.re.test(path.replace(/\\/g, "/"))) return s.label;
  return null;
}
