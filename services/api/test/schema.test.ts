import { describe, expect, it } from "vitest";
import { makeEnv } from "./helpers.ts";

describe("database constraints (migrations)", () => {
  it("applies all migrations and seeds the audited portfolio", async () => {
    const { env } = await makeEnv();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM niches").first<{ n: number }>();
    expect(n?.n).toBe(3);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM registry_entries").first<{ n: number }>();
    expect(r!.n).toBeGreaterThanOrEqual(15);
  });

  it("refuses a 'verified' channel without a publication receipt", async () => {
    const { env } = await makeEnv();
    await expect(env.DB.prepare(`INSERT INTO channels (id,niche_id,platform,status,updated_at) VALUES ('x','bidline','pinterest','verified','2026-11-10')`).run()).rejects.toThrow(/CHECK/);
  });

  it("refuses a TESTED/LIVE status change without evidence", async () => {
    const { env } = await makeEnv();
    await expect(env.DB.prepare(`INSERT INTO status_history (id,subject_type,subject_id,to_status,changed_by,changed_at) VALUES ('s','product','prd_bidline_kit','LIVE','x','t')`).run()).rejects.toThrow(/CHECK/);
  });

  it("refuses self-certified gate receipts", async () => {
    const { env } = await makeEnv();
    await expect(env.DB.prepare(`INSERT INTO gate_receipts (id,release_id,gate,result,reviewer,producer,created_at) VALUES ('g','r','G1','PASS','agent-a','agent-a','t')`).run()).rejects.toThrow(/CHECK/);
  });

  it("accepts only 1Password links as vault references (QA-002 R5)", async () => {
    const { env } = await makeEnv();
    const upd = (ref: string) => env.DB.prepare(`UPDATE accounts SET password_manager_ref = ? WHERE id = (SELECT id FROM accounts LIMIT 1)`).bind(ref).run();
    await expect(upd("javascript://alert(1)")).rejects.toThrow(/1Password/);
    await expect(upd("https://evil.example/x")).rejects.toThrow(/1Password/);
    await expect(upd("https://start.1password.com/open/i?a=X&v=Y&i=Z")).resolves.toBeTruthy();
  });

  it("has no password or secret column in the account directory", async () => {
    const { env } = await makeEnv();
    const cols = (await env.DB.prepare("PRAGMA table_info(accounts)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols.some((c) => /pass(word)?$|secret|token|api_key/i.test(c) && c !== "password_manager_ref")).toBe(false);
    await expect(env.DB.prepare(`INSERT INTO accounts (id,service,status,password_manager_ref,updated_at) VALUES ('a','x','active','hunter2','t')`).run()).rejects.toThrow(/CHECK|1Password/);
  });

  it("only the owner can decide an approval", async () => {
    const { env } = await makeEnv();
    await expect(env.DB.prepare(`INSERT INTO approvals (id,scope,action,status,requested_by,decided_by,created_at) VALUES ('p','spend','buy','approved','agent','agent','t')`).run()).rejects.toThrow(/CHECK/);
  });

  it("an unknown cost must be labelled UNKNOWN, never silently $0", async () => {
    const { env } = await makeEnv();
    await expect(env.DB.prepare(`INSERT INTO cost_items (id,category,vendor,item,amount_cents,cadence,evidence,updated_at) VALUES ('c','other','v','i',NULL,'monthly','VERIFIED','t')`).run()).rejects.toThrow(/CHECK/);
  });
});
