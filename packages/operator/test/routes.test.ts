import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { operatorRoutes } from "../src/routes.ts";
import { makeEnv } from "./helpers.ts";

function app(role: string | null) {
  const a = new Hono<any>();
  a.use("*", async (c, next) => { if (role) c.set("me", { email: "owner@forge.test", role }); await next(); });
  a.route("/operator", operatorRoutes());
  return (env: any, method: string, path: string, body?: unknown) =>
    Promise.resolve(a.fetch(new Request(`http://t/operator${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), env))
      .then(async (r: Response) => ({ status: r.status, json: (await r.json()) as any }));
}

async function withItem(draft: object) {
  const { env, db } = await makeEnv();
  const at = new Date().toISOString();
  await db.prepare(`INSERT INTO op_content_items (id,niche_id,channel_id,platform,plan_key,title,evidence_label,status,body_json,created_by,created_at,updated_at) VALUES ('ci_1','quilt-plan-kit','ch_qpk_pinterest','pinterest','k1','t','INFERRED','drafted',?,'test',?,?)`).bind(JSON.stringify(draft), at, at).run();
  return { env, db };
}

describe("operator routes", () => {
  it("refuses owner actions without an owner", async () => {
    const { env } = await makeEnv();
    const call = app(null);
    expect((await call(env, "PUT", "/policies/ch_qpk_pinterest", { mode: "standing" })).status).toBe(403);
    expect((await call(env, "POST", "/content/decide", { ids: ["x"], approve: true })).status).toBe(403);
    expect((await call(env, "GET", "/policies")).status).toBe(200);
  });

  it("batch-approves clean drafts and refuses drafts with unsupported claims", async () => {
    const { env, db } = await withItem({ headline: "Free binding calculator", body: "Enter your quilt size.", cta: "Open it", linkPath: "/calculators/binding" });
    const at = new Date().toISOString();
    await db.prepare(`INSERT INTO op_content_items (id,niche_id,channel_id,platform,plan_key,title,evidence_label,status,body_json,created_by,created_at,updated_at) VALUES ('ci_2','quilt-plan-kit','ch_qpk_pinterest','pinterest','k2','t','INFERRED','drafted',?,'test',?,?)`)
      .bind(JSON.stringify({ headline: "Best-selling planner", body: "x", cta: "y", linkPath: "/" }), at, at).run();
    const r = await app("owner")(env, "POST", "/content/decide", { ids: ["ci_1", "ci_2", "nope"], approve: true });
    expect(r.json.data.map((x: any) => x.status)).toEqual(["approved", "refused: unsupported superlative", "not_found"]);
    const ap = (await db.prepare(`SELECT a.status, a.decided_by FROM approvals a JOIN op_content_items i ON i.approval_id = a.id WHERE i.id='ci_1'`).first()) as any;
    expect(ap).toEqual({ status: "approved", decided_by: "owner" });
  });

  it("records a standing policy with the owner's approval and a manual publication URL", async () => {
    const { env, db } = await withItem({ headline: "h", body: "b", cta: "c", linkPath: "/" });
    const call = app("owner");
    const p = await call(env, "PUT", "/policies/ch_qpk_pinterest", { mode: "standing", publisher: "dry_run", dailyCap: 1, windowEnd: "2026-12-31T00:00:00Z" });
    expect(p.status).toBe(200);
    expect(((await db.prepare(`SELECT status FROM approvals WHERE id=?`).bind(p.json.data.approvalId).first()) as any).status).toBe("approved");
    expect((await call(env, "PUT", "/policies/ch_qpk_pinterest", { mode: "yolo" })).status).toBe(400);
    expect((await call(env, "POST", "/content/ci_1/published", { externalUrl: "javascript:alert(1)" })).status).toBe(400);
    const ok = await call(env, "POST", "/content/ci_1/published", { externalUrl: "https://www.pinterest.com/pin/9/" });
    expect(ok.json.data.status).toBe("published");
    const list = await call(env, "GET", "/content?status=published");
    expect(list.json.data[0]).toMatchObject({ id: "ci_1", externalUrl: "https://www.pinterest.com/pin/9/", verifiedAt: null });
  });
});
