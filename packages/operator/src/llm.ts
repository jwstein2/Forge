/**
 * Bounded model step (the Sandbox Coffee pattern from the audit): JSON-validated output, one retry with the
 * validation error fed back, every attempt recorded in op_llm_calls with its cost, hard per-call cost cap.
 *
 * Providers:
 *  - `anthropic`: Claude via the official SDK. Only constructed when ANTHROPIC_API_KEY is bound in the environment,
 *    which requires the owner's approval (new credential). NOT connected today.
 *  - none: callers get `{ ok: false, reason: "no_provider" }` and must leave work in a human-visible state.
 * Tests inject a fake provider.
 */
import { newId, nowIso } from "./lib.ts";

export interface LlmRequest { system: string; prompt: string; maxTokens: number }
export interface LlmResponse { text: string; inputTokens: number; outputTokens: number; costCents: number; refused?: boolean }
export interface LlmProvider { id: string; model: string; complete(req: LlmRequest): Promise<LlmResponse> }

/** USD per million tokens (Anthropic first-party list prices, cached 2026-11-03). */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};
export const costCents = (model: string, inTok: number, outTok: number): number => {
  const p = PRICES[model]; if (!p) return NaN;
  return ((inTok * p.in + outTok * p.out) / 1_000_000) * 100;
};

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Claude provider. The SDK is imported lazily so builds without a key never load it. */
export function anthropicProvider(apiKey: string, model = DEFAULT_MODEL): LlmProvider {
  return {
    id: "anthropic", model,
    async complete(req) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
      const res = await client.messages.create({
        model, max_tokens: req.maxTokens, system: req.system,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: req.prompt }],
      } as never) as unknown as { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number }; stop_reason: string };
      const text = res.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens, costCents: costCents(model, res.usage.input_tokens, res.usage.output_tokens), refused: res.stop_reason === "refusal" };
    },
  };
}

export function providerFromEnv(env: Record<string, unknown>): LlmProvider | null {
  const key = env.ANTHROPIC_API_KEY;
  return typeof key === "string" && key.length > 20 ? anthropicProvider(key, typeof env.OPERATOR_MODEL === "string" ? env.OPERATOR_MODEL : DEFAULT_MODEL) : null;
}

export type Validator<T> = (value: unknown) => { ok: true; value: T } | { ok: false; error: string };

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const raw = (fenced ?? text).trim();
  const start = raw.indexOf("{"); const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in output");
  return JSON.parse(raw.slice(start, end + 1));
}

export async function boundedJsonCall<T>(db: D1Database, provider: LlmProvider | null, o: {
  jobId?: string; purpose: string; system: string; prompt: string; maxTokens?: number; validate: Validator<T>; costCapCents: number;
}): Promise<{ ok: true; value: T; costCents: number; attempts: number } | { ok: false; reason: string; costCents: number; attempts: number }> {
  if (!provider) return { ok: false, reason: "no_provider", costCents: 0, attempts: 0 };
  let spent = 0; let prompt = o.prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let valid = false; let error: string | null = null; let res: LlmResponse | null = null; let value: T | undefined;
    try {
      res = await provider.complete({ system: o.system, prompt, maxTokens: o.maxTokens ?? 2000 });
      spent += Number.isFinite(res.costCents) ? res.costCents : 0;
      if (res.refused) error = "model declined";
      else {
        const v = o.validate(extractJson(res.text));
        if (v.ok) { valid = true; value = v.value; } else error = v.error;
      }
    } catch (e) { error = String((e as Error).message ?? e).slice(0, 300); }
    await db.prepare(`INSERT INTO op_llm_calls (id,job_id,purpose,provider,model,attempt,input_tokens,output_tokens,cost_cents,valid,error,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(newId("llm"), o.jobId ?? null, o.purpose, provider.id, provider.model, attempt, res?.inputTokens ?? null, res?.outputTokens ?? null, res?.costCents ?? 0, valid ? 1 : 0, error, nowIso()).run();
    if (valid) return { ok: true, value: value as T, costCents: spent, attempts: attempt };
    if (spent >= o.costCapCents) return { ok: false, reason: `cost cap reached (${spent.toFixed(2)}¢)`, costCents: spent, attempts: attempt };
    prompt = `${o.prompt}\n\nYour previous answer was rejected: ${error}. Reply with one JSON object only, fixing that problem.`;
  }
  return { ok: false, reason: "invalid_after_retry", costCents: spent, attempts: 2 };
}
