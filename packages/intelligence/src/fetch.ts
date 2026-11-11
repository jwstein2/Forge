/** Read-only HTTP for research: streamed with a byte cap and a timeout (same pattern as @forge/operator's defaultFetcher). */
export interface FetchResult { ok: boolean; status: number | null; text: string; error?: string }
export type Fetcher = (url: string, opts?: { timeoutMs?: number; maxBytes?: number; accept?: string; headers?: Record<string, string> }) => Promise<FetchResult>;

export const UA = "FORGE-Intelligence/0.1 (research source re-check for the site owner; low volume)";

export const defaultFetcher: Fetcher = async (url, opts = {}) => {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", headers: { "user-agent": UA, accept: opts.accept ?? "text/html,application/json;q=0.9,*/*;q=0.5", ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    const cap = opts.maxBytes ?? 1_000_000; const chunks: Uint8Array[] = []; let got = 0;
    const reader = res.body?.getReader();
    if (reader) {
      while (got < cap) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.byteLength; }
      if (got >= cap) await reader.cancel().catch(() => undefined);
    }
    const buf = new Uint8Array(Math.min(got, cap)); let off = 0;
    for (const c of chunks) { const n = Math.min(c.byteLength, buf.length - off); if (n <= 0) break; buf.set(c.subarray(0, n), off); off += n; }
    return { ok: res.ok, status: res.status, text: new TextDecoder().decode(buf) };
  } catch (e) {
    return { ok: false, status: null, text: "", error: String((e as Error).message ?? e).slice(0, 300) };
  }
};
