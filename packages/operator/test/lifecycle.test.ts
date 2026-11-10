import { describe, expect, it } from "vitest";
import { SEQUENCES, lintSequence, mailerLitePlan, sequenceText } from "../src/lifecycle/sequences.ts";
import { makeEnv } from "./helpers.ts";
import { nichePrices } from "../src/handlers/content.ts";

describe("lifecycle sequences", () => {
  it("every email passes the claims check with the niche's real prices, and links stay on the niche's own site", async () => {
    const { db } = await makeEnv();
    for (const s of SEQUENCES) expect(lintSequence(s, await nichePrices(db, s.nicheId)), s.id).toEqual([]);
  });

  it("catches a bad email: invented price, off-site link, placeholder, guarantee", () => {
    const bad = structuredClone(SEQUENCES[0]!);
    bad.emails[1]!.blocks.push({ type: "paragraph", text: "Now only $5, guaranteed results. TODO" }, { type: "button", text: "x", url: "https://example.com/x" });
    const out = lintSequence(bad, [800]).join("\n");
    expect(out).toMatch(/\$5 is not a current product price/);
    expect(out).toMatch(/not on https:\/\/quiltplankit\.pages\.dev/);
    expect(out).toMatch(/placeholder/);
    expect(out).toMatch(/guarantee/);
  });

  it("leaves offer emails out of the MailerLite draft until checkout is live", () => {
    const qpk = SEQUENCES.find((s) => s.id === "LC-QPK-WELCOME")!;
    const off = mailerLitePlan(qpk, { checkoutLive: false });
    expect(off.workflow.filter((w) => w.type === "email").map((w) => (w.data as { ref: string }).ref)).toEqual(["welcome", "binding"]);
    expect(off.triggers).toEqual([{ type: "subscriber_joins_group", group_ids: ["203436416693176152"] }]);
    expect(JSON.stringify(off)).not.toContain("$8");
    const on = mailerLitePlan(qpk, { checkoutLive: true });
    expect(on.workflow.filter((w) => w.type === "email")).toHaveLength(3);
    expect(lintSequence(qpk, [800], { checkoutLive: false }).join()).toMatch(/offer email while checkout is not live/);
  });

  it("never turns post-purchase copy into a MailerLite automation (buyers stay out of MailerLite)", () => {
    for (const s of SEQUENCES.filter((x) => x.kind === "post_purchase")) {
      expect(() => mailerLitePlan(s, { checkoutLive: true })).toThrow();
      expect(sequenceText(s)).toContain("Subject:");
    }
  });
});
