import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultFetcher } from "../src/lib.ts";

describe("defaultFetcher", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("stops reading at maxBytes and cancels the rest of the body", async () => {
    let pulled = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new TextEncoder().encode("a".repeat(10_000))); if (pulled > 100) c.close(); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", async () => new Response(body, { status: 200 }));
    const r = await defaultFetcher("https://example.test/", { maxBytes: 25_000 });
    expect(r.ok).toBe(true);
    expect(r.text.length).toBe(25_000);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(10);
  });
});
